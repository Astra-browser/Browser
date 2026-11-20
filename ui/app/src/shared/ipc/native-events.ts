import type {
  WorkEnvironmentChanged,
  WorkChanged,
  WorkHumanChanged,
  WorkDecisionPreferenceChanged,
  WorkModelsChanged,
  AccountChanged,
  PanelState,
  PageAssistChanged,
  ProfilesView,
  FaviconsView,
  NoteOpenRequested,
  NoteChanges,
  ResourceChanged,
  DownloadsChanged,
  BlockerStatusChanged,
  BrowserCredentialCapabilityChanged,
  FocusChanged,
  ExtensionActionFailed,
  ExtensionActionShortcut,
  ExtensionActionsChanged,
  FindResultView,
  ImportJobView,
  ItemsChanged,
  KeymapChanged,
  LayoutChanged,
  MediaPlayerChanged,
  OperationProcessed,
  PagePermissionPromptChanged,
  PageDialogPromptChanged,
  PasskeyPromptChanged,
  RuntimeStatusChanged,
  SearchChanged,
  TabChanged,
  UiCommand,
  VoiceChanged,
  VoiceLevels,
  SwipeScroll,
  WebExtensionAccessRequested,
  WebExtensionPromptChanged,
  WebExtensionStoreClicked,
} from "./bindings";

type PayloadEvent<T> = { payload: T };
type Listener<T> = (event: PayloadEvent<T>) => void;
type PresentationTab = { tab: TabChanged; active: string | null };

function scopedEvent<T>(name: string) {
  return {
    listen(listener: Listener<T>): Promise<() => void> {
      const handler = (event: Event) => listener({ payload: (event as CustomEvent<T>).detail });
      window.addEventListener(name, handler);
      return Promise.resolve(() => window.removeEventListener(name, handler));
    },
  };
}

// Rust delivers these directly into the intended WebView. Do not replace this
// with @tauri-apps/api/event: its listen command accepts a caller-selected
// target, which would let the launcher panel subscribe to main-window state.
export const nativeEventNames = {
  windowsReputationManaged: "astra:windows-reputation-managed",
  workEnvironmentChanged: "astra:work-environment-changed",
  workChanged: "astra:work-changed",
  workHumanChanged: "astra:work-human-changed",
  workDecisionPreferenceChanged: "astra:work-decision-preference-changed",
  workModelsChanged: "astra:work-models-changed",
  pageAssistChanged: "astra:page-assist-changed",
  accountChanged: "astra:account-changed",
  panelState: "astra:panel-state",
  favicons: "astra:favicons",
  noteOpenRequested: "astra:note-open-requested",
  resourceChanged: "astra:resource-changed",
  notesChanged: "astra:notes-changed",
  downloadsChanged: "astra:downloads-changed",
  resourceClose: "astra:resource-close",
  resourceCloseCancelled: "astra:resource-close-cancelled",
  browserCredentialCapabilityChanged: "astra:browser-credential-capability",
  itemsChanged: "astra:items",
  tabChanged: "astra:tab",
  extensionActionsChanged: "astra:extension-actions",
  extensionActionFailed: "astra:extension-action-failed",
  extensionActionShortcut: "astra:extension-action-shortcut",
  pagePermissionPromptChanged: "astra:page-permission-prompt",
  pageDialogPromptChanged: "astra:page-dialog-prompt",
  passkeyPromptChanged: "astra:passkey-prompt",
  webExtensionAccessRequested: "astra:web-extension-access",
  webExtensionPromptChanged: "astra:web-extension-prompt",
  webExtensionStoreClicked: "astra:web-extension-store-click",
  webExtensionDropped: "astra:web-extension-dropped",
  browserReturn: "astra:browser-return",
  presentationTab: "astra:presentation-tab",
  uiCommand: "astra:ui-command",
  keymapChanged: "astra:keymap-changed",
  importProgress: "astra:import-progress",
  find: "astra:find",
  searchChanged: "astra:search",
  layoutChanged: "astra:layout",
  mediaPlayerChanged: "astra:media-player",
  operationProcessed: "astra:operation-processed",
  runtimeStatusChanged: "astra:runtime-status",
  blockerStatusChanged: "astra:blocker-status",
  focusChanged: "astra:focus",
  voiceChanged: "astra:voice-changed",
  voiceLevels: "astra:voice-levels",
  swipeScroll: "astra:swipe",
  profilesChanged: "astra:profiles",
  peekChanged: "astra:peek",
} as const;

export const events = {
  windowsReputationManaged: scopedEvent<boolean>(nativeEventNames.windowsReputationManaged),
  workEnvironmentChanged: scopedEvent<WorkEnvironmentChanged>(
    nativeEventNames.workEnvironmentChanged,
  ),
  workChanged: scopedEvent<WorkChanged>(nativeEventNames.workChanged),
  workHumanChanged: scopedEvent<WorkHumanChanged>(nativeEventNames.workHumanChanged),
  workDecisionPreferenceChanged: scopedEvent<WorkDecisionPreferenceChanged>(
    nativeEventNames.workDecisionPreferenceChanged,
  ),
  workModelsChanged: scopedEvent<WorkModelsChanged>(nativeEventNames.workModelsChanged),
  pageAssistChanged: scopedEvent<PageAssistChanged>(nativeEventNames.pageAssistChanged),
  accountChanged: scopedEvent<AccountChanged>(nativeEventNames.accountChanged),
  favicons: scopedEvent<FaviconsView>(nativeEventNames.favicons),
  noteOpenRequested: scopedEvent<NoteOpenRequested>(nativeEventNames.noteOpenRequested),
  resourceClose: scopedEvent<string>(nativeEventNames.resourceClose),
  resourceCloseCancelled: scopedEvent<string>(nativeEventNames.resourceCloseCancelled),
  resourceChanged: scopedEvent<ResourceChanged>(nativeEventNames.resourceChanged),
  notesChanged: scopedEvent<NoteChanges>(nativeEventNames.notesChanged),
  downloadsChanged: scopedEvent<DownloadsChanged>(nativeEventNames.downloadsChanged),
  panelState: scopedEvent<PanelState>(nativeEventNames.panelState),
  browserCredentialCapabilityChanged: scopedEvent<BrowserCredentialCapabilityChanged>(
    nativeEventNames.browserCredentialCapabilityChanged,
  ),
  itemsChanged: scopedEvent<ItemsChanged>(nativeEventNames.itemsChanged),
  tabChanged: scopedEvent<TabChanged>(nativeEventNames.tabChanged),
  extensionActionsChanged: scopedEvent<ExtensionActionsChanged>(
    nativeEventNames.extensionActionsChanged,
  ),
  extensionActionFailed: scopedEvent<ExtensionActionFailed>(nativeEventNames.extensionActionFailed),
  extensionActionShortcut: scopedEvent<ExtensionActionShortcut>(
    nativeEventNames.extensionActionShortcut,
  ),
  pagePermissionPromptChanged: scopedEvent<PagePermissionPromptChanged>(
    nativeEventNames.pagePermissionPromptChanged,
  ),
  pageDialogPromptChanged: scopedEvent<PageDialogPromptChanged>(
    nativeEventNames.pageDialogPromptChanged,
  ),
  passkeyPromptChanged: scopedEvent<PasskeyPromptChanged>(nativeEventNames.passkeyPromptChanged),
  webExtensionAccessRequested: scopedEvent<WebExtensionAccessRequested>(
    nativeEventNames.webExtensionAccessRequested,
  ),
  webExtensionPromptChanged: scopedEvent<WebExtensionPromptChanged>(
    nativeEventNames.webExtensionPromptChanged,
  ),
  webExtensionStoreClicked: scopedEvent<WebExtensionStoreClicked>(
    nativeEventNames.webExtensionStoreClicked,
  ),
  /** The path of an extension package dropped on the browser. */
  webExtensionDropped: scopedEvent<string>(nativeEventNames.webExtensionDropped),
  browserReturn: scopedEvent<ItemsChanged>(nativeEventNames.browserReturn),
  presentationTab: scopedEvent<PresentationTab>(nativeEventNames.presentationTab),
  uiCommand: scopedEvent<UiCommand>(nativeEventNames.uiCommand),
  keymapChanged: scopedEvent<KeymapChanged>(nativeEventNames.keymapChanged),
  importProgress: scopedEvent<ImportJobView>(nativeEventNames.importProgress),
  find: scopedEvent<FindResultView>(nativeEventNames.find),
  searchChanged: scopedEvent<SearchChanged>(nativeEventNames.searchChanged),
  layoutChanged: scopedEvent<LayoutChanged>(nativeEventNames.layoutChanged),
  mediaPlayerChanged: scopedEvent<MediaPlayerChanged>(nativeEventNames.mediaPlayerChanged),
  operationProcessed: scopedEvent<OperationProcessed>(nativeEventNames.operationProcessed),
  runtimeStatusChanged: scopedEvent<RuntimeStatusChanged>(nativeEventNames.runtimeStatusChanged),
  blockerStatusChanged: scopedEvent<BlockerStatusChanged>(nativeEventNames.blockerStatusChanged),
  focusChanged: scopedEvent<FocusChanged>(nativeEventNames.focusChanged),
  voiceChanged: scopedEvent<VoiceChanged>(nativeEventNames.voiceChanged),
  voiceLevels: scopedEvent<VoiceLevels>(nativeEventNames.voiceLevels),
  swipeScroll: scopedEvent<SwipeScroll>(nativeEventNames.swipeScroll),
  profilesChanged: scopedEvent<ProfilesView>(nativeEventNames.profilesChanged),
  peekChanged: scopedEvent<{
    peeks: Array<{
      id: string;
      tab_id: string;
      url: string;
      title: string;
      space_id: string;
      source: string;
      private: boolean;
      captured_at: number;
      image: string | null;
      thumbnail: string | null;
    }>;
    config: Record<string, unknown>;
    private?: boolean;
  }>(nativeEventNames.peekChanged),
};
