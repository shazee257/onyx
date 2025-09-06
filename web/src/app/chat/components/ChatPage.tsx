"use client";

import { redirect, useRouter, useSearchParams } from "next/navigation";
import { ChatSession, ChatSessionSharedStatus, Message } from "../interfaces";

import Cookies from "js-cookie";
import { HistorySidebar } from "@/components/sidebar/HistorySidebar";
import { HealthCheckBanner } from "@/components/health/healthcheck";
import { personaIncludesRetrieval, useScrollonStream } from "../services/lib";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePopup } from "@/components/admin/connectors/Popup";
import { SEARCH_PARAM_NAMES } from "../services/searchParams";
import { useFederatedConnectors, useFilters, useLlmManager } from "@/lib/hooks";
import { FeedbackType } from "@/app/chat/interfaces";
import { OnyxInitializingLoader } from "@/components/OnyxInitializingLoader";
import { FeedbackModal } from "./modal/FeedbackModal";
import { ShareChatSessionModal } from "./modal/ShareChatSessionModal";
import { FiArrowDown } from "react-icons/fi";
import { OnyxDocument, MinimalOnyxDocument } from "@/lib/search/interfaces";
import { SettingsContext } from "@/components/settings/SettingsProvider";
import Dropzone from "react-dropzone";
import { ChatInputBar } from "./input/ChatInputBar";
import { useChatContext } from "@/components/context/ChatContext";
import { ChatPopup } from "./ChatPopup";
import FunctionalHeader from "@/components/chat/Header";
import { useSidebarVisibility } from "@/components/chat/hooks";
import { SIDEBAR_TOGGLED_COOKIE_NAME } from "@/components/resizable/constants";
import FixedLogo from "@/components/logo/FixedLogo";
import ExceptionTraceModal from "@/components/modals/ExceptionTraceModal";
import { SEARCH_TOOL_ID } from "./tools/constants";
import { useUser } from "@/components/user/UserProvider";
import { ApiKeyModal } from "@/components/llm/ApiKeyModal";
import BlurBackground from "../../../components/chat/BlurBackground";
import { NoAssistantModal } from "@/components/modals/NoAssistantModal";
import { useAssistantsContext } from "@/components/context/AssistantsContext";
import TextView from "@/components/chat/TextView";
import { Modal } from "@/components/Modal";
import { useSendMessageToParent } from "@/lib/extension/utils";
import { SUBMIT_MESSAGE_TYPES } from "@/lib/extension/constants";

import { getSourceMetadata } from "@/lib/sources";
import { UserSettingsModal } from "./modal/UserSettingsModal";
import AssistantModal from "../../assistants/mine/AssistantModal";
import { useSidebarShortcut } from "@/lib/browserUtilities";
import { FilePickerModal } from "../my-documents/components/FilePicker";

import { SourceMetadata } from "@/lib/search/interfaces";
import { FederatedConnectorDetail, ValidSources } from "@/lib/types";
import { useDocumentsContext } from "../my-documents/DocumentsContext";
import { ChatSearchModal } from "../chat_search/ChatSearchModal";
import { ErrorBanner } from "../message/Resubmit";
import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import { useScreenSize } from "@/hooks/useScreenSize";
import { DocumentResults } from "./documentSidebar/DocumentResults";
import { useChatController } from "../hooks/useChatController";
import { useAssistantController } from "../hooks/useAssistantController";
import { useChatSessionController } from "../hooks/useChatSessionController";
import { useDeepResearchToggle } from "../hooks/useDeepResearchToggle";
import {
  useChatSessionStore,
  useMaxTokens,
  useUncaughtError,
} from "../stores/useChatSessionStore";
import {
  useCurrentChatState,
  useSubmittedMessage,
  useLoadingError,
  useIsReady,
  useIsFetching,
  useCurrentMessageTree,
  useCurrentMessageHistory,
  useHasPerformedInitialScroll,
  useDocumentSidebarVisible,
  useChatSessionSharedStatus,
  useHasSentLocalUserMessage,
} from "../stores/useChatSessionStore";
import { FederatedOAuthModal } from "@/components/chat/FederatedOAuthModal";
import { AssistantIcon } from "@/components/assistants/AssistantIcon";
import { StarterMessageDisplay } from "./starterMessages/StarterMessageDisplay";
import { MessagesDisplay } from "./MessagesDisplay";

export function ChatPage({
  toggle,
  documentSidebarInitialWidth,
  sidebarVisible,
  firstMessage,
}: {
  toggle: (toggled?: boolean) => void;
  documentSidebarInitialWidth?: number;
  sidebarVisible: boolean;
  firstMessage?: string;
}) {
  // Performance tracking
  // Keeping this here in case we need to track down slow renders in the future
  // const renderCount = useRef(0);
  // renderCount.current++;
  // const renderStartTime = performance.now();

  // useEffect(() => {
  //   const renderTime = performance.now() - renderStartTime;
  //   if (renderTime > 10) {
  //     console.log(
  //       `[ChatPage] Slow render #${renderCount.current}: ${renderTime.toFixed(
  //         2
  //       )}ms`
  //     );
  //   }
  // });

  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    chatSessions,
    ccPairs,
    tags,
    documentSets,
    llmProviders,
    folders,
    shouldShowWelcomeModal,
    refreshChatSessions,
  } = useChatContext();

  const {
    selectedFiles,
    selectedFolders,
    addSelectedFolder,
    clearSelectedItems,
    folders: userFolders,
    files: allUserFiles,
    currentMessageFiles,
    setCurrentMessageFiles,
  } = useDocumentsContext();

  const { height: screenHeight } = useScreenSize();

  // handle redirect if chat page is disabled
  // NOTE: this must be done here, in a client component since
  // settings are passed in via Context and therefore aren't
  // available in server-side components
  const settings = useContext(SettingsContext);
  const enterpriseSettings = settings?.enterpriseSettings;

  const [toggleDocSelection, setToggleDocSelection] = useState(false);

  const isInitialLoad = useRef(true);
  const [userSettingsToggled, setUserSettingsToggled] = useState(false);

  const { assistants: availableAssistants } = useAssistantsContext();

  const [showApiKeyModal, setShowApiKeyModal] = useState(
    !shouldShowWelcomeModal
  );

  // Also fetch federated connectors for the sources list
  const { data: federatedConnectorsData } = useFederatedConnectors();

  const { user, isAdmin } = useUser();
  const existingChatIdRaw = searchParams?.get("chatId");

  const [showHistorySidebar, setShowHistorySidebar] = useState(false);

  const existingChatSessionId = existingChatIdRaw ? existingChatIdRaw : null;

  const selectedChatSession = chatSessions.find(
    (chatSession) => chatSession.id === existingChatSessionId
  );

  const processSearchParamsAndSubmitMessage = (searchParamsString: string) => {
    const newSearchParams = new URLSearchParams(searchParamsString);
    const message = newSearchParams?.get("user-prompt");

    filterManager.buildFiltersFromQueryString(
      newSearchParams.toString(),
      sources,
      documentSets.map((ds) => ds.name),
      tags
    );

    newSearchParams.delete(SEARCH_PARAM_NAMES.SEND_ON_LOAD);

    router.replace(`?${newSearchParams.toString()}`, { scroll: false });

    // If there's a message, submit it
    if (message) {
      onSubmit({
        message,
        selectedFiles,
        selectedFolders,
        currentMessageFiles,
        useAgentSearch: deepResearchEnabled,
      });
    }
  };

  const { selectedAssistant, setSelectedAssistantFromId, liveAssistant } =
    useAssistantController({
      selectedChatSession,
    });

  const { deepResearchEnabled, toggleDeepResearch } = useDeepResearchToggle({
    chatSessionId: existingChatSessionId,
    assistantId: selectedAssistant?.id,
  });

  const [presentingDocument, setPresentingDocument] =
    useState<MinimalOnyxDocument | null>(null);

  const llmManager = useLlmManager(
    llmProviders,
    selectedChatSession,
    liveAssistant
  );

  const noAssistants = liveAssistant === null || liveAssistant === undefined;

  const availableSources: ValidSources[] = useMemo(() => {
    return ccPairs.map((ccPair) => ccPair.source);
  }, [ccPairs]);

  const sources: SourceMetadata[] = useMemo(() => {
    const uniqueSources = Array.from(new Set(availableSources));
    const regularSources = uniqueSources.map((source) =>
      getSourceMetadata(source)
    );

    // Add federated connectors as sources
    const federatedSources =
      federatedConnectorsData?.map((connector: FederatedConnectorDetail) => {
        return getSourceMetadata(connector.source);
      }) || [];

    // Combine sources and deduplicate based on internalName
    const allSources = [...regularSources, ...federatedSources];
    const deduplicatedSources = allSources.reduce((acc, source) => {
      const existing = acc.find((s) => s.internalName === source.internalName);
      if (!existing) {
        acc.push(source);
      }
      return acc;
    }, [] as SourceMetadata[]);

    return deduplicatedSources;
  }, [availableSources, federatedConnectorsData]);

  const { popup, setPopup } = usePopup();

  useEffect(() => {
    const userFolderId = searchParams?.get(SEARCH_PARAM_NAMES.USER_FOLDER_ID);
    const allMyDocuments = searchParams?.get(
      SEARCH_PARAM_NAMES.ALL_MY_DOCUMENTS
    );

    if (userFolderId) {
      const userFolder = userFolders.find(
        (folder) => folder.id === parseInt(userFolderId)
      );
      if (userFolder) {
        addSelectedFolder(userFolder);
      }
    } else if (allMyDocuments === "true" || allMyDocuments === "1") {
      // Clear any previously selected folders

      clearSelectedItems();

      // Add all user folders to the current context
      userFolders.forEach((folder) => {
        addSelectedFolder(folder);
      });
    }
  }, [
    userFolders,
    searchParams?.get(SEARCH_PARAM_NAMES.USER_FOLDER_ID),
    searchParams?.get(SEARCH_PARAM_NAMES.ALL_MY_DOCUMENTS),
    addSelectedFolder,
    clearSelectedItems,
  ]);

  const [message, setMessage] = useState(
    searchParams?.get(SEARCH_PARAM_NAMES.USER_PROMPT) || ""
  );

  const filterManager = useFilters();
  const [isChatSearchModalOpen, setIsChatSearchModalOpen] = useState(false);

  const [currentFeedback, setCurrentFeedback] = useState<
    [FeedbackType, number] | null
  >(null);

  const [sharingModalVisible, setSharingModalVisible] =
    useState<boolean>(false);

  const [aboveHorizon, setAboveHorizon] = useState(false);

  const scrollableDivRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const endDivRef = useRef<HTMLDivElement>(null);
  const endPaddingRef = useRef<HTMLDivElement>(null);

  const scrollInitialized = useRef(false);

  const previousHeight = useRef<number>(
    inputRef.current?.getBoundingClientRect().height!
  );
  const scrollDist = useRef<number>(0);

  // Reset scroll state when switching chat sessions
  useEffect(() => {
    scrollDist.current = 0;
    setAboveHorizon(false);
  }, [existingChatSessionId]);

  const handleInputResize = () => {
    setTimeout(() => {
      if (
        inputRef.current &&
        lastMessageRef.current &&
        !waitForScrollRef.current
      ) {
        const newHeight: number =
          inputRef.current?.getBoundingClientRect().height!;
        const heightDifference = newHeight - previousHeight.current;
        if (
          previousHeight.current &&
          heightDifference != 0 &&
          endPaddingRef.current &&
          scrollableDivRef &&
          scrollableDivRef.current
        ) {
          endPaddingRef.current.style.transition = "height 0.3s ease-out";
          endPaddingRef.current.style.height = `${Math.max(
            newHeight - 50,
            0
          )}px`;

          if (autoScrollEnabled) {
            scrollableDivRef?.current.scrollBy({
              left: 0,
              top: Math.max(heightDifference, 0),
              behavior: "smooth",
            });
          }
        }
        previousHeight.current = newHeight;
      }
    }, 100);
  };

  const resetInputBar = useCallback(() => {
    setMessage("");
    setCurrentMessageFiles([]);
    if (endPaddingRef.current) {
      endPaddingRef.current.style.height = `95px`;
    }
  }, [setMessage, setCurrentMessageFiles]);

  const debounceNumber = 100; // time for debouncing

  // handle re-sizing of the text area
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    handleInputResize();
  }, [message]);

  // Add refs needed by useChatSessionController
  const chatSessionIdRef = useRef<string | null>(existingChatSessionId);
  const loadedIdSessionRef = useRef<string | null>(existingChatSessionId);
  const submitOnLoadPerformed = useRef<boolean>(false);

  // used for resizing of the document sidebar
  const masterFlexboxRef = useRef<HTMLDivElement>(null);
  const [maxDocumentSidebarWidth, setMaxDocumentSidebarWidth] = useState<
    number | null
  >(null);
  const adjustDocumentSidebarWidth = () => {
    if (masterFlexboxRef.current && document.documentElement.clientWidth) {
      // numbers below are based on the actual width the center section for different
      // screen sizes. `1700` corresponds to the custom "3xl" tailwind breakpoint
      // NOTE: some buffer is needed to account for scroll bars
      if (document.documentElement.clientWidth > 1700) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 950);
      } else if (document.documentElement.clientWidth > 1420) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 760);
      } else {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 660);
      }
    }
  };

  const loadNewPageLogic = (event: MessageEvent) => {
    if (event.data.type === SUBMIT_MESSAGE_TYPES.PAGE_CHANGE) {
      try {
        const url = new URL(event.data.href);
        processSearchParamsAndSubmitMessage(url.searchParams.toString());
      } catch (error) {
        console.error("Error parsing URL:", error);
      }
    }
  };

  // Equivalent to `loadNewPageLogic`
  useEffect(() => {
    if (searchParams?.get(SEARCH_PARAM_NAMES.SEND_ON_LOAD)) {
      processSearchParamsAndSubmitMessage(searchParams.toString());
    }
  }, [searchParams, router]);

  useEffect(() => {
    adjustDocumentSidebarWidth();
    window.addEventListener("resize", adjustDocumentSidebarWidth);
    window.addEventListener("message", loadNewPageLogic);

    return () => {
      window.removeEventListener("message", loadNewPageLogic);
      window.removeEventListener("resize", adjustDocumentSidebarWidth);
    };
  }, []);

  if (!documentSidebarInitialWidth && maxDocumentSidebarWidth) {
    documentSidebarInitialWidth = Math.min(700, maxDocumentSidebarWidth);
  }

  const [selectedDocuments, setSelectedDocuments] = useState<OnyxDocument[]>(
    []
  );

  // Access chat state directly from the store
  const currentChatState = useCurrentChatState();
  const chatSessionId = useChatSessionStore((state) => state.currentSessionId);
  const submittedMessage = useSubmittedMessage();
  const loadingError = useLoadingError();
  const uncaughtError = useUncaughtError();
  const isReady = useIsReady();
  const maxTokens = useMaxTokens();
  const isFetchingChatMessages = useIsFetching();
  const completeMessageTree = useCurrentMessageTree();
  const messageHistory = useCurrentMessageHistory();
  const hasPerformedInitialScroll = useHasPerformedInitialScroll();
  const currentSessionHasSentLocalUserMessage = useHasSentLocalUserMessage();
  const documentSidebarVisible = useDocumentSidebarVisible();
  const chatSessionSharedStatus = useChatSessionSharedStatus();
  const updateHasPerformedInitialScroll = useChatSessionStore(
    (state) => state.updateHasPerformedInitialScroll
  );
  const updateCurrentDocumentSidebarVisible = useChatSessionStore(
    (state) => state.updateCurrentDocumentSidebarVisible
  );
  const updateCurrentChatSessionSharedStatus = useChatSessionStore(
    (state) => state.updateCurrentChatSessionSharedStatus
  );

  const clientScrollToBottom = useCallback(
    (fast?: boolean) => {
      waitForScrollRef.current = true;

      setTimeout(() => {
        if (!endDivRef.current || !scrollableDivRef.current) {
          console.error("endDivRef or scrollableDivRef not found");
          return;
        }

        const rect = endDivRef.current.getBoundingClientRect();
        const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;

        if (isVisible) return;

        // Check if all messages are currently rendered
        // If all messages are already rendered, scroll immediately
        endDivRef.current.scrollIntoView({
          behavior: fast ? "auto" : "smooth",
        });

        if (chatSessionIdRef.current) {
          updateHasPerformedInitialScroll(chatSessionIdRef.current, true);
        }
      }, 50);

      // Reset waitForScrollRef after 1.5 seconds
      setTimeout(() => {
        waitForScrollRef.current = false;
      }, 1500);
    },
    [updateHasPerformedInitialScroll]
  );

  const { onSubmit, stopGenerating, handleMessageSpecificFileUpload } =
    useChatController({
      filterManager,
      llmManager,
      availableAssistants,
      liveAssistant,
      existingChatSessionId,
      selectedDocuments,
      searchParams,
      setPopup,
      clientScrollToBottom,
      resetInputBar,
      setSelectedAssistantFromId,
    });

  const { onMessageSelection } = useChatSessionController({
    existingChatSessionId,
    searchParams,
    filterManager,
    firstMessage,
    setSelectedAssistantFromId,
    setSelectedDocuments,
    setCurrentMessageFiles,
    chatSessionIdRef,
    loadedIdSessionRef,
    textAreaRef,
    scrollInitialized,
    isInitialLoad,
    submitOnLoadPerformed,
    hasPerformedInitialScroll,
    clientScrollToBottom,
    clearSelectedItems,
    refreshChatSessions,
    onSubmit,
  });

  const autoScrollEnabled = user?.preferences?.auto_scroll ?? false;

  useScrollonStream({
    chatState: currentChatState,
    scrollableDivRef,
    scrollDist,
    endDivRef,
    debounceNumber,
    mobile: settings?.isMobile,
    enableAutoScroll: autoScrollEnabled,
  });

  const getContainerHeight = useMemo(() => {
    return () => {
      if (!currentSessionHasSentLocalUserMessage) {
        return undefined;
      }
      if (autoScrollEnabled) return undefined;

      if (screenHeight < 600) return "40vh";
      if (screenHeight < 1200) return "50vh";
      return "60vh";
    };
  }, [autoScrollEnabled, screenHeight, currentSessionHasSentLocalUserMessage]);

  const reset = useCallback(() => {
    setMessage("");
    setCurrentMessageFiles([]);
    clearSelectedItems();
    // TODO: move this into useChatController
    // setLoadingError(null);
  }, [setMessage, setCurrentMessageFiles, clearSelectedItems]);

  // Used to maintain a "time out" for history sidebar so our existing refs can have time to process change
  const [untoggled, setUntoggled] = useState(false);

  const explicitlyUntoggle = useCallback(() => {
    setShowHistorySidebar(false);

    setUntoggled(true);
    setTimeout(() => {
      setUntoggled(false);
    }, 200);
  }, [setShowHistorySidebar, setUntoggled]);

  const toggleSidebar = useCallback(() => {
    if (user?.is_anonymous_user) {
      return;
    }
    Cookies.set(
      SIDEBAR_TOGGLED_COOKIE_NAME,
      String(!sidebarVisible).toLocaleLowerCase()
    );

    toggle();
  }, [user?.is_anonymous_user, toggle, sidebarVisible]);

  const removeToggle = useCallback(() => {
    setShowHistorySidebar(false);
    toggle(false);
  }, [setShowHistorySidebar, toggle]);

  const waitForScrollRef = useRef(false);
  const sidebarElementRef = useRef<HTMLDivElement>(null);

  useSidebarVisibility({
    sidebarVisible,
    sidebarElementRef,
    showDocSidebar: showHistorySidebar,
    setShowDocSidebar: setShowHistorySidebar,
    setToggled: removeToggle,
    mobile: settings?.isMobile,
    isAnonymousUser: user?.is_anonymous_user,
  });

  useSendMessageToParent();

  const retrievalEnabled = useMemo(() => {
    if (liveAssistant) {
      return liveAssistant.tools.some(
        (tool) => tool.in_code_tool_id === SEARCH_TOOL_ID
      );
    }
    return false;
  }, [liveAssistant]);

  useEffect(() => {
    if (
      (!personaIncludesRetrieval &&
        (!selectedDocuments || selectedDocuments.length === 0) &&
        documentSidebarVisible) ||
      chatSessionId == undefined
    ) {
      updateCurrentDocumentSidebarVisible(false);
    }
    clientScrollToBottom();
  }, [chatSessionId]);

  const [stackTraceModalContent, setStackTraceModalContent] = useState<
    string | null
  >(null);

  const innerSidebarElementRef = useRef<HTMLDivElement>(null);
  const [settingsToggled, setSettingsToggled] = useState(false);

  const HORIZON_DISTANCE = 800;
  const handleScroll = useCallback(() => {
    const scrollDistance =
      endDivRef?.current?.getBoundingClientRect()?.top! -
      inputRef?.current?.getBoundingClientRect()?.top!;
    scrollDist.current = scrollDistance;
    setAboveHorizon(scrollDist.current > HORIZON_DISTANCE);
  }, []);

  useSidebarShortcut(router, toggleSidebar);

  const [sharedChatSession, setSharedChatSession] =
    useState<ChatSession | null>();

  const handleResubmitLastMessage = () => {
    // Grab the last user-type message
    const lastUserMsg = messageHistory
      .slice()
      .reverse()
      .find((m) => m.type === "user");
    if (!lastUserMsg) {
      setPopup({
        message: "No previously-submitted user message found.",
        type: "error",
      });
      return;
    }

    // We call onSubmit, passing a `messageOverride`
    onSubmit({
      message: lastUserMsg.message,
      selectedFiles: selectedFiles,
      selectedFolders: selectedFolders,
      currentMessageFiles: currentMessageFiles,
      useAgentSearch: deepResearchEnabled,
      messageIdToResend: lastUserMsg.messageId,
    });
  };

  const [showAssistantsModal, setShowAssistantsModal] = useState(false);

  const toggleDocumentSidebar = useCallback(() => {
    if (!documentSidebarVisible) {
      updateCurrentDocumentSidebarVisible(true);
    } else {
      updateCurrentDocumentSidebarVisible(false);
    }
  }, [documentSidebarVisible, updateCurrentDocumentSidebarVisible]);

  const toggleChatSessionSearchModal = useCallback(
    () => setIsChatSearchModalOpen((open) => !open),
    [setIsChatSearchModalOpen]
  );

  if (!user) {
    redirect("/auth/login");
  }

  const clearSelectedDocuments = useCallback(() => {
    setSelectedDocuments([]);
    clearSelectedItems();
  }, [clearSelectedItems]);

  const toggleDocumentSelection = useCallback((document: OnyxDocument) => {
    setSelectedDocuments((prev) =>
      prev.some((d) => d.document_id === document.document_id)
        ? prev.filter((d) => d.document_id !== document.document_id)
        : [...prev, document]
    );
  }, []);

  // Memoized callbacks for ChatInputBar
  const handleToggleDocSelection = useCallback(() => {
    setToggleDocSelection(true);
  }, []);

  const handleShowApiKeyModal = useCallback(() => {
    setShowApiKeyModal(true);
  }, []);

  const handleChatInputSubmit = useCallback(() => {
    onSubmit({
      message: message,
      selectedFiles: selectedFiles,
      selectedFolders: selectedFolders,
      currentMessageFiles: currentMessageFiles,
      useAgentSearch: deepResearchEnabled,
    });
  }, [
    message,
    onSubmit,
    selectedFiles,
    selectedFolders,
    currentMessageFiles,
    deepResearchEnabled,
  ]);

  // Memoized callbacks for Header
  const handleToggleUserSettings = useCallback(() => {
    setUserSettingsToggled(true);
  }, []);

  const handleHeaderReset = useCallback(() => {
    setMessage("");
  }, []);

  // Memoized callbacks for DocumentResults
  const handleMobileDocumentSidebarClose = useCallback(() => {
    updateCurrentDocumentSidebarVisible(false);
  }, [updateCurrentDocumentSidebarVisible]);

  const handleDesktopDocumentSidebarClose = useCallback(() => {
    setTimeout(() => updateCurrentDocumentSidebarVisible(false), 300);
  }, [updateCurrentDocumentSidebarVisible]);

  // Determine whether to show the centered input (no messages yet)
  const showCenteredInput =
    messageHistory.length === 0 &&
    !isFetchingChatMessages &&
    !loadingError &&
    !submittedMessage;

  // handle error case where no assistants are available
  if (noAssistants) {
    return (
      <>
        <HealthCheckBanner />
        <NoAssistantModal isAdmin={isAdmin} />
      </>
    );
  }

  return (
    <>
      <HealthCheckBanner />

      {showApiKeyModal && !shouldShowWelcomeModal && (
        <ApiKeyModal
          hide={() => setShowApiKeyModal(false)}
          setPopup={setPopup}
        />
      )}

      {/* ChatPopup is a custom popup that displays a admin-specified message on initial user visit. 
      Only used in the EE version of the app. */}
      {popup}

      <ChatPopup />

      {currentFeedback && (
        <FeedbackModal
          feedbackType={currentFeedback[0]}
          messageId={currentFeedback[1]}
          onClose={() => setCurrentFeedback(null)}
          setPopup={setPopup}
        />
      )}

      {(settingsToggled || userSettingsToggled) && (
        <UserSettingsModal
          setPopup={setPopup}
          updateCurrentLlm={llmManager.updateCurrentLlm}
          defaultModel={user?.preferences.default_model!}
          llmProviders={llmProviders}
          onClose={() => {
            setUserSettingsToggled(false);
            setSettingsToggled(false);
          }}
        />
      )}

      {toggleDocSelection && (
        <FilePickerModal
          setPresentingDocument={setPresentingDocument}
          buttonContent="Set as Context"
          isOpen={true}
          onClose={() => setToggleDocSelection(false)}
          onSave={() => {
            setToggleDocSelection(false);
          }}
        />
      )}

      <ChatSearchModal
        open={isChatSearchModalOpen}
        onCloseModal={() => setIsChatSearchModalOpen(false)}
      />

      {retrievalEnabled && documentSidebarVisible && settings?.isMobile && (
        <div className="md:hidden">
          <Modal
            hideDividerForTitle
            onOutsideClick={() => updateCurrentDocumentSidebarVisible(false)}
            title="Sources"
          >
            {/* IMPORTANT: this is a memoized component, and it's very important
            for performance reasons that this stays true. MAKE SURE that all function 
            props are wrapped in useCallback. */}
            <DocumentResults
              setPresentingDocument={setPresentingDocument}
              modal={true}
              ref={innerSidebarElementRef}
              closeSidebar={handleMobileDocumentSidebarClose}
              selectedDocuments={selectedDocuments}
              toggleDocumentSelection={toggleDocumentSelection}
              clearSelectedDocuments={clearSelectedDocuments}
              // TODO (chris): fix
              selectedDocumentTokens={0}
              maxTokens={maxTokens}
              initialWidth={400}
              isOpen={true}
            />
          </Modal>
        </div>
      )}

      {presentingDocument && (
        <TextView
          presentingDocument={presentingDocument}
          onClose={() => setPresentingDocument(null)}
        />
      )}

      {stackTraceModalContent && (
        <ExceptionTraceModal
          onOutsideClick={() => setStackTraceModalContent(null)}
          exceptionTrace={stackTraceModalContent}
        />
      )}

      {sharedChatSession && (
        <ShareChatSessionModal
          assistantId={liveAssistant?.id}
          message={message}
          modelOverride={llmManager.currentLlm}
          chatSessionId={sharedChatSession.id}
          existingSharedStatus={sharedChatSession.shared_status}
          onClose={() => setSharedChatSession(null)}
          onShare={(shared) =>
            updateCurrentChatSessionSharedStatus(
              shared
                ? ChatSessionSharedStatus.Public
                : ChatSessionSharedStatus.Private
            )
          }
        />
      )}

      {sharingModalVisible && chatSessionId !== null && (
        <ShareChatSessionModal
          message={message}
          assistantId={liveAssistant?.id}
          modelOverride={llmManager.currentLlm}
          chatSessionId={chatSessionId}
          existingSharedStatus={chatSessionSharedStatus}
          onClose={() => setSharingModalVisible(false)}
        />
      )}

      {showAssistantsModal && (
        <AssistantModal hideModal={() => setShowAssistantsModal(false)} />
      )}

      {isReady && <FederatedOAuthModal />}

      <div className="fixed inset-0 flex flex-col text-text-dark">
        <div className="h-[100dvh] overflow-y-hidden">
          <div className="w-full">
            <div
              ref={sidebarElementRef}
              className={`
                flex-none
                fixed
                left-0
                z-40
                bg-neutral-200
                h-screen
                transition-all
                bg-opacity-80
                duration-300
                ease-in-out
                ${
                  !untoggled && (showHistorySidebar || sidebarVisible)
                    ? "opacity-100 w-[250px] translate-x-0"
                    : "opacity-0 w-[250px] pointer-events-none -translate-x-10"
                }`}
            >
              <div className="w-full relative">
                {/* IMPORTANT: this is a memoized component, and it's very important
                for performance reasons that this stays true. MAKE SURE that all function 
                props are wrapped in useCallback. */}
                <HistorySidebar
                  toggleChatSessionSearchModal={toggleChatSessionSearchModal}
                  liveAssistant={liveAssistant}
                  setShowAssistantsModal={setShowAssistantsModal}
                  explicitlyUntoggle={explicitlyUntoggle}
                  reset={reset}
                  page="chat"
                  ref={innerSidebarElementRef}
                  toggleSidebar={toggleSidebar}
                  toggled={sidebarVisible}
                  existingChats={chatSessions}
                  currentChatSession={selectedChatSession}
                  folders={folders}
                  removeToggle={removeToggle}
                  showShareModal={setSharedChatSession}
                />
              </div>

              <div
                className={`
                flex-none
                fixed
                left-0
                z-40
                bg-background-100
                h-screen
                transition-all
                bg-opacity-80
                duration-300
                ease-in-out
                ${
                  documentSidebarVisible &&
                  !settings?.isMobile &&
                  "opacity-100 w-[350px]"
                }`}
              ></div>
            </div>
          </div>

          <div
            style={{ transition: "width 0.30s ease-out" }}
            className={`
                flex-none 
                fixed
                right-0
                z-[1000]
                h-screen
                transition-all
                duration-300
                ease-in-out
                bg-transparent
                transition-all
                duration-300
                ease-in-out
                h-full
                ${
                  documentSidebarVisible && !settings?.isMobile
                    ? "w-[400px]"
                    : "w-[0px]"
                }
            `}
          >
            {/* IMPORTANT: this is a memoized component, and it's very important
            for performance reasons that this stays true. MAKE SURE that all function 
            props are wrapped in useCallback. */}
            <DocumentResults
              setPresentingDocument={setPresentingDocument}
              modal={false}
              ref={innerSidebarElementRef}
              closeSidebar={handleDesktopDocumentSidebarClose}
              selectedDocuments={selectedDocuments}
              toggleDocumentSelection={toggleDocumentSelection}
              clearSelectedDocuments={clearSelectedDocuments}
              // TODO (chris): fix
              selectedDocumentTokens={0}
              maxTokens={maxTokens}
              initialWidth={400}
              isOpen={documentSidebarVisible && !settings?.isMobile}
            />
          </div>

          <BlurBackground
            visible={!untoggled && (showHistorySidebar || sidebarVisible)}
            onClick={() => toggleSidebar()}
          />

          <div
            ref={masterFlexboxRef}
            className="flex h-full w-full overflow-x-hidden"
          >
            <div
              id="scrollableContainer"
              className="flex h-full relative px-2 flex-col w-full"
            >
              {/* IMPORTANT: this is a memoized component, and it's very important
              for performance reasons that this stays true. MAKE SURE that all function 
              props are wrapped in useCallback. */}
              {liveAssistant && (
                <FunctionalHeader
                  toggleUserSettings={handleToggleUserSettings}
                  sidebarToggled={sidebarVisible}
                  reset={handleHeaderReset}
                  page="chat"
                  setSharingModalVisible={
                    chatSessionId !== null ? setSharingModalVisible : undefined
                  }
                  documentSidebarVisible={
                    documentSidebarVisible && !settings?.isMobile
                  }
                  toggleSidebar={toggleSidebar}
                  currentChatSession={selectedChatSession}
                  hideUserDropdown={user?.is_anonymous_user}
                />
              )}

              {documentSidebarInitialWidth !== undefined && isReady ? (
                <Dropzone
                  key={chatSessionId}
                  onDrop={(acceptedFiles) =>
                    handleMessageSpecificFileUpload(acceptedFiles)
                  }
                  noClick
                >
                  {({ getRootProps }) => (
                    <div className="flex h-full w-full">
                      {!settings?.isMobile && (
                        <div
                          style={{ transition: "width 0.30s ease-out" }}
                          className={`
                          flex-none 
                          overflow-y-hidden 
                          bg-transparent
                          transition-all 
                          bg-opacity-80
                          duration-300 
                          ease-in-out
                          h-full
                          ${sidebarVisible ? "w-[200px]" : "w-[0px]"}
                      `}
                        ></div>
                      )}

                      <div
                        className={`h-full w-full relative flex-auto transition-margin duration-300 overflow-x-auto mobile:pb-12 desktop:pb-[100px]`}
                        {...getRootProps()}
                      >
                        <div
                          onScroll={handleScroll}
                          className={`w-full h-[calc(100vh-160px)] flex flex-col default-scrollbar overflow-y-auto overflow-x-hidden relative`}
                          ref={scrollableDivRef}
                        >
                          {liveAssistant && (
                            <div className="z-20 fixed top-0 pointer-events-none left-0 w-full flex justify-center overflow-visible">
                              {!settings?.isMobile && (
                                <div
                                  style={{ transition: "width 0.30s ease-out" }}
                                  className={`
                                  flex-none 
                                  overflow-y-hidden 
                                  transition-all 
                                  pointer-events-none
                                  duration-300 
                                  ease-in-out
                                  h-full
                                  ${sidebarVisible ? "w-[200px]" : "w-[0px]"}
                              `}
                                />
                              )}
                            </div>
                          )}

                          <MessagesDisplay
                            messageHistory={messageHistory}
                            completeMessageTree={completeMessageTree}
                            liveAssistant={liveAssistant}
                            llmManager={llmManager}
                            deepResearchEnabled={deepResearchEnabled}
                            selectedFiles={selectedFiles}
                            selectedFolders={selectedFolders}
                            currentMessageFiles={currentMessageFiles}
                            setPresentingDocument={setPresentingDocument}
                            setCurrentFeedback={setCurrentFeedback}
                            onSubmit={onSubmit}
                            onMessageSelection={onMessageSelection}
                            stopGenerating={stopGenerating}
                            uncaughtError={uncaughtError}
                            loadingError={loadingError}
                            handleResubmitLastMessage={
                              handleResubmitLastMessage
                            }
                            autoScrollEnabled={autoScrollEnabled}
                            getContainerHeight={getContainerHeight}
                            lastMessageRef={lastMessageRef}
                            endPaddingRef={endPaddingRef}
                            endDivRef={endDivRef}
                            hasPerformedInitialScroll={
                              hasPerformedInitialScroll
                            }
                            chatSessionId={chatSessionId}
                            enterpriseSettings={enterpriseSettings}
                          />
                        </div>

                        <div
                          ref={inputRef}
                          className={`absolute pointer-events-none z-10 w-full ${
                            showCenteredInput
                              ? "inset-0"
                              : "bottom-0 left-0 right-0 translate-y-0"
                          }`}
                        >
                          {!showCenteredInput && aboveHorizon && (
                            <div className="mx-auto w-fit !pointer-events-none flex sticky justify-center">
                              <button
                                onClick={() => clientScrollToBottom()}
                                className="p-1 pointer-events-auto text-neutral-700 dark:text-neutral-800 rounded-2xl bg-neutral-200 border border-border  mx-auto "
                              >
                                <FiArrowDown size={18} />
                              </button>
                            </div>
                          )}

                          <div
                            className={`pointer-events-auto w-[95%] mx-auto relative text-text-600 ${
                              showCenteredInput
                                ? "h-full grid grid-rows-[0.85fr_auto_1.15fr]"
                                : "mb-8"
                            }`}
                          >
                            {showCenteredInput && (
                              <div
                                data-testid="chat-intro"
                                className="row-start-1 self-end flex text-text-800 justify-center mb-6 transition-opacity duration-300"
                              >
                                <AssistantIcon
                                  colorOverride="text-text-800"
                                  assistant={liveAssistant}
                                  size="large"
                                />
                                <div className="ml-4 flex justify-center items-center text-center text-3xl font-bold">
                                  {liveAssistant.name}
                                </div>
                              </div>
                            )}
                            <div
                              className={showCenteredInput ? "row-start-2" : ""}
                            >
                              <ChatInputBar
                                deepResearchEnabled={deepResearchEnabled}
                                toggleDeepResearch={toggleDeepResearch}
                                toggleDocumentSidebar={toggleDocumentSidebar}
                                filterManager={filterManager}
                                llmManager={llmManager}
                                removeDocs={clearSelectedDocuments}
                                retrievalEnabled={retrievalEnabled}
                                toggleDocSelection={handleToggleDocSelection}
                                showConfigureAPIKey={handleShowApiKeyModal}
                                selectedDocuments={selectedDocuments}
                                message={message}
                                setMessage={setMessage}
                                stopGenerating={stopGenerating}
                                onSubmit={handleChatInputSubmit}
                                chatState={currentChatState}
                                selectedAssistant={
                                  selectedAssistant || liveAssistant
                                }
                                handleFileUpload={
                                  handleMessageSpecificFileUpload
                                }
                                textAreaRef={textAreaRef}
                              />
                            </div>

                            {liveAssistant.starter_messages &&
                              liveAssistant.starter_messages.length > 0 &&
                              messageHistory.length === 0 &&
                              showCenteredInput && (
                                <div className="mt-6 row-start-3">
                                  <StarterMessageDisplay
                                    starterMessages={
                                      liveAssistant.starter_messages
                                    }
                                    onSelectStarterMessage={(message) => {
                                      onSubmit({
                                        message: message,
                                        selectedFiles: selectedFiles,
                                        selectedFolders: selectedFolders,
                                        currentMessageFiles:
                                          currentMessageFiles,
                                        useAgentSearch: deepResearchEnabled,
                                      });
                                    }}
                                  />
                                </div>
                              )}

                            {enterpriseSettings &&
                              enterpriseSettings.custom_lower_disclaimer_content && (
                                <div className="mobile:hidden mt-4 flex items-center justify-center relative w-[95%] mx-auto">
                                  <div className="text-sm text-text-500 max-w-searchbar-max px-4 text-center">
                                    <MinimalMarkdown
                                      content={
                                        enterpriseSettings.custom_lower_disclaimer_content
                                      }
                                    />
                                  </div>
                                </div>
                              )}
                            {enterpriseSettings &&
                              enterpriseSettings.use_custom_logotype && (
                                <div className="hidden lg:block fixed right-12 bottom-8 pointer-events-none z-10">
                                  <img
                                    src="/api/enterprise-settings/logotype"
                                    alt="logotype"
                                    style={{ objectFit: "contain" }}
                                    className="w-fit h-9"
                                  />
                                </div>
                              )}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{ transition: "width 0.30s ease-out" }}
                        className={`
                          flex-none 
                          overflow-y-hidden 
                          transition-all 
                          bg-opacity-80
                          duration-300 
                          ease-in-out
                          h-full
                          ${
                            documentSidebarVisible && !settings?.isMobile
                              ? "w-[350px]"
                              : "w-[0px]"
                          }
                      `}
                      />
                    </div>
                  )}
                </Dropzone>
              ) : (
                <div className="mx-auto h-full flex">
                  <div
                    style={{ transition: "width 0.30s ease-out" }}
                    className={`flex-none bg-transparent transition-all bg-opacity-80 duration-300 ease-in-out h-full
                        ${
                          sidebarVisible && !settings?.isMobile
                            ? "w-[250px] "
                            : "w-[0px]"
                        }`}
                  />
                  <div className="my-auto">
                    <OnyxInitializingLoader />
                  </div>
                </div>
              )}
            </div>
          </div>
          <FixedLogo backgroundToggled={sidebarVisible || showHistorySidebar} />
        </div>
      </div>
    </>
  );
}
