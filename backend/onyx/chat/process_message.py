import re
import time
import traceback
from collections.abc import Callable
from collections.abc import Iterator
from typing import cast
from typing import Protocol

from sqlalchemy.orm import Session

from onyx.agents.agent_search.orchestration.nodes.call_tool import ToolCallException
from onyx.chat.answer import Answer
from onyx.chat.chat_utils import create_chat_chain
from onyx.chat.chat_utils import create_temporary_persona
from onyx.chat.chat_utils import process_kg_commands
from onyx.chat.models import AnswerStream
from onyx.chat.models import AnswerStyleConfig
from onyx.chat.models import ChatBasicResponse
from onyx.chat.models import CitationConfig
from onyx.chat.models import DocumentPruningConfig
from onyx.chat.models import MessageResponseIDInfo
from onyx.chat.models import MessageSpecificCitations
from onyx.chat.models import PromptConfig
from onyx.chat.models import QADocsResponse
from onyx.chat.models import StreamingError
from onyx.chat.models import UserKnowledgeFilePacket
from onyx.chat.packet_proccessing.process_streamed_packets import (
    process_streamed_packets,
)
from onyx.chat.prompt_builder.answer_prompt_builder import AnswerPromptBuilder
from onyx.chat.prompt_builder.answer_prompt_builder import default_build_system_message
from onyx.chat.prompt_builder.answer_prompt_builder import default_build_user_message
from onyx.chat.user_files.parse_user_files import parse_user_files
from onyx.configs.chat_configs import CHAT_TARGET_CHUNK_PERCENTAGE
from onyx.configs.chat_configs import DISABLE_LLM_CHOOSE_SEARCH
from onyx.configs.chat_configs import MAX_CHUNKS_FED_TO_CHAT
from onyx.configs.chat_configs import SELECTED_SECTIONS_MAX_WINDOW_PERCENTAGE
from onyx.configs.constants import MessageType
from onyx.configs.constants import MilestoneRecordType
from onyx.configs.constants import NO_AUTH_USER_ID
from onyx.context.search.enums import OptionalSearchSetting
from onyx.context.search.models import InferenceSection
from onyx.context.search.models import RetrievalDetails
from onyx.context.search.models import SavedSearchDoc
from onyx.context.search.retrieval.search_runner import (
    inference_sections_from_ids,
)
from onyx.db.chat import attach_files_to_chat_message
from onyx.db.chat import create_new_chat_message
from onyx.db.chat import get_chat_message
from onyx.db.chat import get_chat_session_by_id
from onyx.db.chat import get_db_search_doc_by_id
from onyx.db.chat import get_doc_query_identifiers_from_model
from onyx.db.chat import get_or_create_root_message
from onyx.db.chat import reserve_message_id
from onyx.db.engine.sql_engine import get_session_with_current_tenant
from onyx.db.milestone import check_multi_assistant_milestone
from onyx.db.milestone import create_milestone_if_not_exists
from onyx.db.milestone import update_user_assistant_milestone
from onyx.db.models import ChatMessage
from onyx.db.models import Persona
from onyx.db.models import SearchDoc as DbSearchDoc
from onyx.db.models import ToolCall
from onyx.db.models import User
from onyx.db.persona import get_persona_by_id
from onyx.db.search_settings import get_current_search_settings
from onyx.document_index.factory import get_default_document_index
from onyx.file_store.models import FileDescriptor
from onyx.file_store.utils import load_all_chat_files
from onyx.kg.models import KGException
from onyx.llm.exceptions import GenAIDisabledException
from onyx.llm.factory import get_llms_for_persona
from onyx.llm.factory import get_main_llm_from_tuple
from onyx.llm.interfaces import LLM
from onyx.llm.models import PreviousMessage
from onyx.llm.utils import litellm_exception_to_error_msg
from onyx.natural_language_processing.utils import get_tokenizer
from onyx.server.query_and_chat.models import CreateChatMessageRequest
from onyx.server.query_and_chat.streaming_models import CitationDelta
from onyx.server.query_and_chat.streaming_models import CitationInfo
from onyx.server.query_and_chat.streaming_models import MessageDelta
from onyx.server.query_and_chat.streaming_models import MessageStart
from onyx.server.query_and_chat.streaming_models import Packet
from onyx.server.utils import get_json_line
from onyx.tools.force import ForceUseTool
from onyx.tools.models import SearchToolOverrideKwargs
from onyx.tools.tool import Tool
from onyx.tools.tool_constructor import construct_tools
from onyx.tools.tool_constructor import CustomToolConfig
from onyx.tools.tool_constructor import ImageGenerationToolConfig
from onyx.tools.tool_constructor import InternetSearchToolConfig
from onyx.tools.tool_constructor import SearchToolConfig
from onyx.tools.tool_implementations.internet_search.internet_search_tool import (
    InternetSearchTool,
)
from onyx.tools.tool_implementations.search.search_tool import SearchTool
from onyx.utils.logger import setup_logger
from onyx.utils.long_term_log import LongTermLogger
from onyx.utils.telemetry import mt_cloud_telemetry
from onyx.utils.timing import log_function_time
from onyx.utils.timing import log_generator_function_time
from shared_configs.contextvars import get_current_tenant_id

logger = setup_logger()
ERROR_TYPE_CANCELLED = "cancelled"


class PartialResponse(Protocol):
    def __call__(
        self,
        message: str,
        rephrased_query: str | None,
        reference_docs: list[DbSearchDoc] | None,
        files: list[FileDescriptor],
        token_count: int,
        citations: dict[int, int] | None,
        error: str | None,
        tool_call: ToolCall | None,
    ) -> ChatMessage: ...


def _translate_citations(
    citations_list: list[CitationInfo], db_docs: list[DbSearchDoc]
) -> MessageSpecificCitations:
    """Always cites the first instance of the document_id, assumes the db_docs
    are sorted in the order displayed in the UI"""
    doc_id_to_saved_doc_id_map: dict[str, int] = {}
    for db_doc in db_docs:
        if db_doc.document_id not in doc_id_to_saved_doc_id_map:
            doc_id_to_saved_doc_id_map[db_doc.document_id] = db_doc.id

    citation_to_saved_doc_id_map: dict[int, int] = {}
    for citation in citations_list:
        if citation.citation_num not in citation_to_saved_doc_id_map:
            citation_to_saved_doc_id_map[citation.citation_num] = (
                doc_id_to_saved_doc_id_map[citation.document_id]
            )

    return MessageSpecificCitations(citation_map=citation_to_saved_doc_id_map)


def _get_force_search_settings(
    new_msg_req: CreateChatMessageRequest,
    tools: list[Tool],
    search_tool_override_kwargs: SearchToolOverrideKwargs | None,
) -> ForceUseTool:
    if new_msg_req.forced_tool_ids:
        forced_tools = [
            tool for tool in tools if tool.id in new_msg_req.forced_tool_ids
        ]
        if not forced_tools:
            raise ValueError(
                f"No tools found for forced tool IDs: {new_msg_req.forced_tool_ids}"
            )
        return ForceUseTool(
            force_use=True,
            tool_name=forced_tools[0].name,
            args=None,
            override_kwargs=search_tool_override_kwargs,
        )

    internet_search_available = any(
        isinstance(tool, InternetSearchTool) for tool in tools
    )
    search_tool_available = any(isinstance(tool, SearchTool) for tool in tools)

    if not internet_search_available and not search_tool_available:
        # Does not matter much which tool is set here as force is false and neither tool is available
        return ForceUseTool(force_use=False, tool_name=SearchTool._NAME)
    # Currently, the internet search tool does not support query override
    args = (
        {"query": new_msg_req.query_override}
        if new_msg_req.query_override and search_tool_available
        else None
    )

    should_force_search = any(
        [
            new_msg_req.retrieval_options
            and new_msg_req.retrieval_options.run_search
            == OptionalSearchSetting.ALWAYS,
            new_msg_req.search_doc_ids,
            new_msg_req.query_override is not None,
            DISABLE_LLM_CHOOSE_SEARCH,
            search_tool_override_kwargs is not None,
        ]
    )

    if should_force_search:
        # If we are using selected docs, just put something here so the Tool doesn't need to build its own args via an LLM call
        args = {"query": new_msg_req.message} if new_msg_req.search_doc_ids else args

        return ForceUseTool(
            force_use=True,
            tool_name=SearchTool._NAME,
            args=args,
            override_kwargs=search_tool_override_kwargs,
        )

    return ForceUseTool(
        force_use=False,
        tool_name=(
            SearchTool._NAME if search_tool_available else InternetSearchTool._NAME
        ),
        args=args,
        override_kwargs=None,
    )


def _get_persona_for_chat_session(
    new_msg_req: CreateChatMessageRequest,
    user: User | None,
    db_session: Session,
    default_persona: Persona,
) -> Persona:
    if new_msg_req.alternate_assistant_id is not None:
        # Allows users to specify a temporary persona (assistant) in the chat session
        # this takes highest priority since it's user specified
        persona = get_persona_by_id(
            new_msg_req.alternate_assistant_id,
            user=user,
            db_session=db_session,
            is_for_edit=False,
        )
    elif new_msg_req.persona_override_config:
        # Certain endpoints allow users to specify arbitrary persona settings
        # this should never conflict with the alternate_assistant_id
        persona = create_temporary_persona(
            db_session=db_session,
            persona_config=new_msg_req.persona_override_config,
            user=user,
        )
    else:
        persona = default_persona

    if not persona:
        raise RuntimeError("No persona specified or found for chat session")
    return persona


def stream_chat_message_objects(
    new_msg_req: CreateChatMessageRequest,
    user: User | None,
    db_session: Session,
    # Needed to translate persona num_chunks to tokens to the LLM
    default_num_chunks: float = MAX_CHUNKS_FED_TO_CHAT,
    # For flow with search, don't include as many chunks as possible since we need to leave space
    # for the chat history, for smaller models, we likely won't get MAX_CHUNKS_FED_TO_CHAT chunks
    max_document_percentage: float = CHAT_TARGET_CHUNK_PERCENTAGE,
    # if specified, uses the last user message and does not create a new user message based
    # on the `new_msg_req.message`. Currently, requires a state where the last message is a
    litellm_additional_headers: dict[str, str] | None = None,
    custom_tool_additional_headers: dict[str, str] | None = None,
    is_connected: Callable[[], bool] | None = None,
    enforce_chat_session_id_for_search_docs: bool = True,
    bypass_acl: bool = False,
    # a string which represents the history of a conversation. Used in cases like
    # Slack threads where the conversation cannot be represented by a chain of User/Assistant
    # messages.
    # NOTE: is not stored in the database at all.
    single_message_history: str | None = None,
) -> AnswerStream:
    """Streams in order:
    1. [conditional] Retrieved documents if a search needs to be run
    2. [conditional] LLM selected chunk indices if LLM chunk filtering is turned on
    3. [always] A set of streamed LLM tokens or an error anywhere along the line if something fails
    4. [always] Details on the final AI response message that is created
    """
    tenant_id = get_current_tenant_id()
    use_existing_user_message = new_msg_req.use_existing_user_message
    existing_assistant_message_id = new_msg_req.existing_assistant_message_id

    # Currently surrounding context is not supported for chat
    # Chat is already token heavy and harder for the model to process plus it would roll history over much faster
    new_msg_req.chunks_above = 0
    new_msg_req.chunks_below = 0

    llm: LLM
    answer: Answer

    try:
        # Move these variables inside the try block
        user_id = user.id if user is not None else None

        chat_session = get_chat_session_by_id(
            chat_session_id=new_msg_req.chat_session_id,
            user_id=user_id,
            db_session=db_session,
        )

        message_text = new_msg_req.message
        chat_session_id = new_msg_req.chat_session_id
        parent_id = new_msg_req.parent_message_id
        reference_doc_ids = new_msg_req.search_doc_ids
        retrieval_options = new_msg_req.retrieval_options
        new_msg_req.alternate_assistant_id

        # permanent "log" store, used primarily for debugging
        long_term_logger = LongTermLogger(
            metadata={"user_id": str(user_id), "chat_session_id": str(chat_session_id)}
        )

        persona = _get_persona_for_chat_session(
            new_msg_req=new_msg_req,
            user=user,
            db_session=db_session,
            default_persona=chat_session.persona,
        )

        # TODO: remove once we have an endpoint for this stuff
        process_kg_commands(new_msg_req.message, persona.name, tenant_id, db_session)

        multi_assistant_milestone, _is_new = create_milestone_if_not_exists(
            user=user,
            event_type=MilestoneRecordType.MULTIPLE_ASSISTANTS,
            db_session=db_session,
        )

        update_user_assistant_milestone(
            milestone=multi_assistant_milestone,
            user_id=str(user.id) if user else NO_AUTH_USER_ID,
            assistant_id=persona.id,
            db_session=db_session,
        )

        _, just_hit_multi_assistant_milestone = check_multi_assistant_milestone(
            milestone=multi_assistant_milestone,
            db_session=db_session,
        )

        if just_hit_multi_assistant_milestone:
            mt_cloud_telemetry(
                distinct_id=tenant_id,
                event=MilestoneRecordType.MULTIPLE_ASSISTANTS,
                properties=None,
            )

        # If a prompt override is specified via the API, use that with highest priority
        # but for saving it, we are just mapping it to an existing prompt
        prompt_id = new_msg_req.prompt_id
        if prompt_id is None and persona.prompts:
            prompt_id = sorted(persona.prompts, key=lambda x: x.id)[-1].id

        if reference_doc_ids is None and retrieval_options is None:
            raise RuntimeError(
                "Must specify a set of documents for chat or specify search options"
            )

        try:
            llm, fast_llm = get_llms_for_persona(
                persona=persona,
                llm_override=new_msg_req.llm_override or chat_session.llm_override,
                additional_headers=litellm_additional_headers,
                long_term_logger=long_term_logger,
            )
        except GenAIDisabledException:
            raise RuntimeError("LLM is disabled. Can't use chat flow without LLM.")

        llm_provider = llm.config.model_provider
        llm_model_name = llm.config.model_name

        llm_tokenizer = get_tokenizer(
            model_name=llm_model_name,
            provider_type=llm_provider,
        )
        llm_tokenizer_encode_func = cast(
            Callable[[str], list[int]], llm_tokenizer.encode
        )

        search_settings = get_current_search_settings(db_session)
        document_index = get_default_document_index(search_settings, None)

        # Every chat Session begins with an empty root message
        root_message = get_or_create_root_message(
            chat_session_id=chat_session_id, db_session=db_session
        )

        if parent_id is not None:
            parent_message = get_chat_message(
                chat_message_id=parent_id,
                user_id=user_id,
                db_session=db_session,
            )
        else:
            parent_message = root_message

        user_message = None

        if new_msg_req.regenerate:
            final_msg, history_msgs = create_chat_chain(
                stop_at_message_id=parent_id,
                chat_session_id=chat_session_id,
                db_session=db_session,
            )

        elif not use_existing_user_message:
            # Create new message at the right place in the tree and update the parent's child pointer
            # Don't commit yet until we verify the chat message chain
            user_message = create_new_chat_message(
                chat_session_id=chat_session_id,
                parent_message=parent_message,
                prompt_id=prompt_id,
                message=message_text,
                token_count=len(llm_tokenizer_encode_func(message_text)),
                message_type=MessageType.USER,
                files=None,  # Need to attach later for optimization to only load files once in parallel
                db_session=db_session,
                commit=False,
            )
            # re-create linear history of messages
            final_msg, history_msgs = create_chat_chain(
                chat_session_id=chat_session_id, db_session=db_session
            )
            if final_msg.id != user_message.id:
                db_session.rollback()
                raise RuntimeError(
                    "The new message was not on the mainline. "
                    "Be sure to update the chat pointers before calling this."
                )

            # NOTE: do not commit user message - it will be committed when the
            # assistant message is successfully generated
        else:
            # re-create linear history of messages
            final_msg, history_msgs = create_chat_chain(
                chat_session_id=chat_session_id, db_session=db_session
            )
            if existing_assistant_message_id is None:
                if final_msg.message_type != MessageType.USER:
                    raise RuntimeError(
                        "The last message was not a user message. Cannot call "
                        "`stream_chat_message_objects` with `is_regenerate=True` "
                        "when the last message is not a user message."
                    )
            else:
                if final_msg.id != existing_assistant_message_id:
                    raise RuntimeError(
                        "The last message was not the existing assistant message. "
                        f"Final message id: {final_msg.id}, "
                        f"existing assistant message id: {existing_assistant_message_id}"
                    )

        # load all files needed for this chat chain in memory
        files = load_all_chat_files(history_msgs, new_msg_req.file_descriptors)
        req_file_ids = [f["id"] for f in new_msg_req.file_descriptors]
        latest_query_files = [file for file in files if file.file_id in req_file_ids]
        user_file_ids = new_msg_req.user_file_ids or []
        user_folder_ids = new_msg_req.user_folder_ids or []

        if persona.user_files:
            for file in persona.user_files:
                user_file_ids.append(file.id)
        if persona.user_folders:
            for folder in persona.user_folders:
                user_folder_ids.append(folder.id)

        # Load in user files into memory and create search tool override kwargs if needed
        # if we have enough tokens and no folders, we don't need to use search
        # we can just pass them into the prompt directly
        (
            in_memory_user_files,
            user_file_models,
            search_tool_override_kwargs_for_user_files,
        ) = parse_user_files(
            user_file_ids=user_file_ids,
            user_folder_ids=user_folder_ids,
            db_session=db_session,
            persona=persona,
            actual_user_input=message_text,
            user_id=user_id,
        )
        if not search_tool_override_kwargs_for_user_files:
            latest_query_files.extend(in_memory_user_files)

        if user_message:
            attach_files_to_chat_message(
                chat_message=user_message,
                files=[
                    new_file.to_file_descriptor() for new_file in latest_query_files
                ],
                db_session=db_session,
                commit=False,
            )

        selected_db_search_docs = None
        selected_sections: list[InferenceSection] | None = None
        if reference_doc_ids:
            identifier_tuples = get_doc_query_identifiers_from_model(
                search_doc_ids=reference_doc_ids,
                chat_session=chat_session,
                user_id=user_id,
                db_session=db_session,
                enforce_chat_session_id_for_search_docs=enforce_chat_session_id_for_search_docs,
            )

            # Generates full documents currently
            # May extend to use sections instead in the future
            selected_sections = inference_sections_from_ids(
                doc_identifiers=identifier_tuples,
                document_index=document_index,
            )

            # Add a maximum context size in the case of user-selected docs to prevent
            # slight inaccuracies in context window size pruning from causing
            # the entire query to fail
            document_pruning_config = DocumentPruningConfig(
                is_manually_selected_docs=True,
                max_window_percentage=SELECTED_SECTIONS_MAX_WINDOW_PERCENTAGE,
            )

            # In case the search doc is deleted, just don't include it
            # though this should never happen
            db_search_docs_or_none = [
                get_db_search_doc_by_id(doc_id=doc_id, db_session=db_session)
                for doc_id in reference_doc_ids
            ]

            selected_db_search_docs = [
                db_sd for db_sd in db_search_docs_or_none if db_sd
            ]

        else:
            document_pruning_config = DocumentPruningConfig(
                max_chunks=int(
                    persona.num_chunks
                    if persona.num_chunks is not None
                    else default_num_chunks
                ),
                max_window_percentage=max_document_percentage,
            )

        # we don't need to reserve a message id if we're using an existing assistant message
        reserved_message_id = (
            final_msg.id
            if existing_assistant_message_id is not None
            else reserve_message_id(
                db_session=db_session,
                chat_session_id=chat_session_id,
                parent_message=(
                    user_message.id if user_message is not None else parent_message.id
                ),
                message_type=MessageType.ASSISTANT,
            )
        )
        yield MessageResponseIDInfo(
            user_message_id=user_message.id if user_message else None,
            reserved_assistant_message_id=reserved_message_id,
        )

        prompt_override = new_msg_req.prompt_override or chat_session.prompt_override
        if new_msg_req.persona_override_config:
            prompt_config = PromptConfig(
                system_prompt=new_msg_req.persona_override_config.prompts[
                    0
                ].system_prompt,
                task_prompt=new_msg_req.persona_override_config.prompts[0].task_prompt,
                datetime_aware=new_msg_req.persona_override_config.prompts[
                    0
                ].datetime_aware,
            )
        elif prompt_override:
            if not final_msg.prompt:
                raise ValueError(
                    "Prompt override cannot be applied, no base prompt found."
                )
            prompt_config = PromptConfig.from_model(
                final_msg.prompt,
                prompt_override=prompt_override,
            )
        else:
            prompt_config = PromptConfig.from_model(
                final_msg.prompt or persona.prompts[0]
            )

        answer_style_config = AnswerStyleConfig(
            citation_config=CitationConfig(
                all_docs_useful=selected_db_search_docs is not None
            ),
            structured_response_format=new_msg_req.structured_response_format,
        )

        tool_dict = construct_tools(
            persona=persona,
            prompt_config=prompt_config,
            db_session=db_session,
            user=user,
            llm=llm,
            fast_llm=fast_llm,
            run_search_setting=(
                retrieval_options.run_search
                if retrieval_options
                else OptionalSearchSetting.AUTO
            ),
            search_tool_config=SearchToolConfig(
                answer_style_config=answer_style_config,
                document_pruning_config=document_pruning_config,
                retrieval_options=retrieval_options or RetrievalDetails(),
                rerank_settings=new_msg_req.rerank_settings,
                selected_sections=selected_sections,
                chunks_above=new_msg_req.chunks_above,
                chunks_below=new_msg_req.chunks_below,
                full_doc=new_msg_req.full_doc,
                latest_query_files=latest_query_files,
                bypass_acl=bypass_acl,
            ),
            internet_search_tool_config=InternetSearchToolConfig(
                answer_style_config=answer_style_config,
                document_pruning_config=document_pruning_config,
            ),
            image_generation_tool_config=ImageGenerationToolConfig(
                additional_headers=litellm_additional_headers,
            ),
            custom_tool_config=CustomToolConfig(
                chat_session_id=chat_session_id,
                message_id=user_message.id if user_message else None,
                additional_headers=custom_tool_additional_headers,
            ),
            allowed_tool_ids=new_msg_req.allowed_tool_ids,
        )

        tools: list[Tool] = []
        for tool_list in tool_dict.values():
            tools.extend(tool_list)

        force_use_tool = _get_force_search_settings(
            new_msg_req, tools, search_tool_override_kwargs_for_user_files
        )

        # TODO: unify message history with single message history
        message_history = [
            PreviousMessage.from_chat_message(msg, files) for msg in history_msgs
        ]
        if not search_tool_override_kwargs_for_user_files and in_memory_user_files:
            yield UserKnowledgeFilePacket(
                user_files=[
                    FileDescriptor(
                        id=str(file.file_id), type=file.file_type, name=file.filename
                    )
                    for file in in_memory_user_files
                ]
            )

        prompt_builder = AnswerPromptBuilder(
            user_message=default_build_user_message(
                user_query=final_msg.message,
                prompt_config=prompt_config,
                files=latest_query_files,
                single_message_history=single_message_history,
            ),
            system_message=default_build_system_message(prompt_config, llm.config),
            message_history=message_history,
            llm_config=llm.config,
            raw_user_query=final_msg.message,
            raw_user_uploaded_files=latest_query_files or [],
            single_message_history=single_message_history,
        )

        # LLM prompt building, response capturing, etc.
        answer = Answer(
            prompt_builder=prompt_builder,
            is_connected=is_connected,
            latest_query_files=latest_query_files,
            answer_style_config=answer_style_config,
            llm=(
                llm
                or get_main_llm_from_tuple(
                    get_llms_for_persona(
                        persona=persona,
                        llm_override=(
                            new_msg_req.llm_override or chat_session.llm_override
                        ),
                        additional_headers=litellm_additional_headers,
                    )
                )
            ),
            fast_llm=fast_llm,
            force_use_tool=force_use_tool,
            persona=persona,
            rerank_settings=new_msg_req.rerank_settings,
            chat_session_id=chat_session_id,
            current_agent_message_id=reserved_message_id,
            tools=tools,
            db_session=db_session,
            use_agentic_search=new_msg_req.use_agentic_search,
            skip_gen_ai_answer_generation=new_msg_req.skip_gen_ai_answer_generation,
        )

        # Process streamed packets using the new packet processing module
        yield from process_streamed_packets(
            answer_processed_output=answer.processed_streamed_output,
        )

    except ValueError as e:
        logger.exception("Failed to process chat message.")

        error_msg = str(e)
        yield StreamingError(error=error_msg)
        db_session.rollback()
        return

    # TODO: remove after moving kg stuff to api endpoint
    except KGException:
        raise

    except Exception as e:
        logger.exception(f"Failed to process chat message due to {e}")
        error_msg = str(e)
        stack_trace = traceback.format_exc()

        if isinstance(e, ToolCallException):
            yield StreamingError(error=error_msg, stack_trace=stack_trace)
        elif llm:
            client_error_msg = litellm_exception_to_error_msg(e, llm)
            if llm.config.api_key and len(llm.config.api_key) > 2:
                client_error_msg = client_error_msg.replace(
                    llm.config.api_key, "[REDACTED_API_KEY]"
                )
                stack_trace = stack_trace.replace(
                    llm.config.api_key, "[REDACTED_API_KEY]"
                )

            yield StreamingError(error=client_error_msg, stack_trace=stack_trace)

        db_session.rollback()
        return


@log_generator_function_time()
def stream_chat_message(
    new_msg_req: CreateChatMessageRequest,
    user: User | None,
    litellm_additional_headers: dict[str, str] | None = None,
    custom_tool_additional_headers: dict[str, str] | None = None,
    is_connected: Callable[[], bool] | None = None,
) -> Iterator[str]:
    start_time = time.time()
    with get_session_with_current_tenant() as db_session:
        objects = stream_chat_message_objects(
            new_msg_req=new_msg_req,
            user=user,
            db_session=db_session,
            litellm_additional_headers=litellm_additional_headers,
            custom_tool_additional_headers=custom_tool_additional_headers,
            is_connected=is_connected,
        )
        for obj in objects:
            # Check if this is a QADocsResponse with document results
            if isinstance(obj, QADocsResponse):
                document_retrieval_latency = time.time() - start_time
                logger.debug(f"First doc time: {document_retrieval_latency}")

            yield get_json_line(obj.model_dump())


def remove_answer_citations(answer: str) -> str:
    pattern = r"\s*\[\[\d+\]\]\(http[s]?://[^\s]+\)"

    return re.sub(pattern, "", answer)


@log_function_time()
def gather_stream(
    packets: AnswerStream,
) -> ChatBasicResponse:
    answer = ""
    citations: list[CitationInfo] = []
    error_msg: str | None = None
    message_id: int | None = None
    top_documents: list[SavedSearchDoc] = []

    for packet in packets:
        if isinstance(packet, Packet):
            # Handle the different packet object types
            if isinstance(packet.obj, MessageStart):
                # MessageStart contains the initial content and final documents
                if packet.obj.content:
                    answer += packet.obj.content
                if packet.obj.final_documents:
                    top_documents = packet.obj.final_documents
            elif isinstance(packet.obj, MessageDelta):
                # MessageDelta contains incremental content updates
                if packet.obj.content:
                    answer += packet.obj.content
            elif isinstance(packet.obj, CitationDelta):
                # CitationDelta contains citation information
                if packet.obj.citations:
                    citations.extend(packet.obj.citations)
        elif isinstance(packet, StreamingError):
            error_msg = packet.error
        elif isinstance(packet, MessageResponseIDInfo):
            message_id = packet.reserved_assistant_message_id

    if message_id is None:
        raise ValueError("Message ID is required")

    return ChatBasicResponse(
        answer=answer,
        answer_citationless=remove_answer_citations(answer),
        cited_documents={
            citation.citation_num: citation.document_id for citation in citations
        },
        message_id=message_id,
        error_msg=error_msg,
        top_documents=top_documents,
    )
