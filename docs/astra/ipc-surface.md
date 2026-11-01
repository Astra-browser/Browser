# IPC surface (P0-T03a, 2026-11-01) — authoritative command/event inventory

Source: Tauri Specta output `frame/src/shared/ipc/bindings.ts` (7674 lines) cross-checked
against every `#[tauri::command]` fn in `desktop/src` + `crates`. Result: **267 commands, 35 events, zero mismatches**.
This file is the input to P0-T04 (`BrowserHost`) and P2-T02 (`astra-proto`).

Conventions: every command takes `caller: WebviewWindow` first (caller-policy
authorization) and usually an `expectedProfile` scoping arg. Snake-case wire names;
camelCase TS wrappers. 8 event channels carry a previous-product prefix and **must be renamed** in the port (marked REN).

Legend: `prev_` / `prev:` / `Prev` mark verbatim source identifiers carrying the
previous product name. The rebrand maps `prev_*` → `astra_*` (crates, channels, types).

## Commands (267)

| Wire name | TS wrapper | Rust fn (file) | Params (minus caller) | Returns |
|---|---|---|---|---|
| `about_info` | `aboutInfo` | `d:about.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `Option<AboutInfo>` |
| `account_avatar_discard` | `accountAvatarDiscard` | `d:account/avatar.rs` | `caller: WebviewWindow, token: String` | `AccountReplyV1` |
| `account_avatar_pick` | `accountAvatarPick` | `d:account/avatar.rs` | `async caller: WebviewWindow, app: tauri::AppHandle,` | `Result<AccountAvatarPickV1, ()>` |
| `account_avatar_remove` | `accountAvatarRemove` | `d:account/avatar.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_avatar_save` | `accountAvatarSave` | `d:account/avatar.rs` | `async caller: WebviewWindow, token: String, crop: AccountAvatarCropV1,` | `AccountReplyV1` |
| `account_buy` | `accountBuy` | `d:account.rs` | `async caller: WebviewWindow, purchase: AccountPurchaseV1,` | `AccountReplyV1` |
| `account_cancel_code` | `accountCancelCode` | `d:account.rs` | `caller: WebviewWindow` | `AccountReplyV1` |
| `account_change_email` | `accountChangeEmail` | `d:account.rs` | `async caller: WebviewWindow, email: String, code: String,` | `AccountReplyV1` |
| `account_delete` | `accountDelete` | `d:account.rs` | `async caller: WebviewWindow, code: String` | `AccountReplyV1` |
| `account_deletion_code` | `accountDeletionCode` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_email_code` | `accountEmailCode` | `d:account.rs` | `async caller: WebviewWindow, email: String` | `AccountReplyV1` |
| `account_export` | `accountExport` | `d:account.rs` | `async caller: WebviewWindow` | `AccountExportV1` |
| `account_get` | `accountGet` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_manage` | `accountManage` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_plan_confirm` | `accountPlanConfirm` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_plan_dismiss` | `accountPlanDismiss` | `d:account.rs` | `caller: WebviewWindow` | `AccountReplyV1` |
| `account_plan_preview` | `accountPlanPreview` | `d:account.rs` | `async caller: WebviewWindow, plan: String, interval: String,` | `AccountReplyV1` |
| `account_reauth_code` | `accountReauthCode` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_receipt` | `accountReceipt` | `d:account.rs` | `async caller: WebviewWindow, id: String` | `AccountReceiptV1` |
| `account_refresh` | `accountRefresh` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_revoke_session` | `accountRevokeSession` | `d:account.rs` | `async caller: WebviewWindow, id: String` | `AccountReplyV1` |
| `account_send_code` | `accountSendCode` | `d:account.rs` | `async caller: WebviewWindow, email: String` | `AccountReplyV1` |
| `account_sessions` | `accountSessions` | `d:account.rs` | `async caller: WebviewWindow` | `AccountSessionsV1` |
| `account_set_daily_limit` | `accountSetDailyLimit` | `d:account.rs` | `async caller: WebviewWindow, limit: Option<String>,` | `AccountReplyV1` |
| `account_set_name` | `accountSetName` | `d:account.rs` | `async caller: WebviewWindow, name: Option<String>,` | `AccountReplyV1` |
| `account_set_server` | `accountSetServer` | `d:account.rs` | `async caller: WebviewWindow, server: Option<String>,` | `AccountReplyV1` |
| `account_sign_out` | `accountSignOut` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_sign_out_everywhere` | `accountSignOutEverywhere` | `d:account.rs` | `async caller: WebviewWindow` | `AccountReplyV1` |
| `account_usage_history` | `accountUsageHistory` | `d:account.rs` | `async caller: WebviewWindow, cursor: Option<String>,` | `AccountHistoryV1` |
| `account_verify` | `accountVerify` | `d:account.rs` | `async caller: WebviewWindow, code: String` | `AccountReplyV1` |
| `add_menu_popup` | `addMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64, can_split: bool,` | `bool` |
| `blocker_picker` | `blockerPicker` | `d:lib.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, context: prev_ipc::BlockerSiteContext, action: prev_ipc::BlockerPickerAction,` | `Result<Option<prev_ipc::BlockerPickerView>, ()>` |
| `blocker_refresh_sources` | `blockerRefreshSources` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>,` | `prev_ipc::OperationAdmission` |
| `blocker_retry` | `blockerRetry` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, failed_generation: String,` | `prev_ipc::OperationAdmission` |
| `blocker_set_enabled` | `blockerSetEnabled` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, enabled: bool,` | `prev_ipc::OperationAdmission` |
| `blocker_site_change` | `blockerSiteChange` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, context: prev_ipc::BlockerSiteContext, action: prev_ipc::BlockerSiteAction,` | `prev_ipc::OperationAdmission` |
| `blocker_stats` | `blockerStats` | `d:lib.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, profile: String,` | `Result<prev_ipc::BlockerStatsView, ()>` |
| `blocker_status` | `blockerStatus` | `d:lib.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>,` | `Result<prev_ipc::BlockerStatusView, ()>` |
| `bookmark_call` | `bookmarkCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_ipc::BookmarkCall,` | `prev_ipc::BookmarkResponse` |
| `bookmark_menu_popup` | `bookmarkMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64, folder: bool,` | `bool` |
| `browser_credential_capability` | `browserCredentialCapability` | `d:browser_credentials.rs` | `caller: WebviewWindow,` | `BrowserCredentialCapabilityView` |
| `browser_open_url` | `browserOpenUrl` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, url: String, new_tab: bool,` | `prev_ipc::OperationAdmission` |
| `browser_passkey_authorization_request` | `browserPasskeyAuthorizationRequest` | `d:browser_credentials.rs` | `caller: WebviewWindow` | `bool` |
| `browsing_data_call` | `browsingDataCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_ipc::BrowsingDataCall,` | `prev_ipc::BrowsingDataResponse` |
| `chrome_menu_popup` | `chromeMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64, page: bool, can_split: bool,` | `bool` |
| `default_browser_request` | `defaultBrowserRequest` | `d:default_browser.rs` | `async caller: WebviewWindow` | `Option<DefaultBrowserStatus>` |
| `default_browser_status` | `defaultBrowserStatus` | `d:default_browser.rs` | `async caller: WebviewWindow` | `Option<DefaultBrowserStatus>` |
| `diagnostics_report` | `diagnosticsReport` | `d:diagnostic_report.rs` | `async caller: WebviewWindow, app: tauri::AppHandle,` | `Option<String>` |
| `diagnostics_show_logs` | `diagnosticsShowLogs` | `d:lib.rs` | `caller: WebviewWindow` | `bool` |
| `divider_drag` | `dividerDrag` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, x: f64, y: f64` | `` |
| `divider_grab` | `dividerGrab` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, x: f64, y: f64` | `` |
| `divider_release` | `dividerRelease` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, x: Option<f64>, y: Option<f64>,` | `prev_ipc::OperationAdmission` |
| `download_call` | `downloadCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_core::downloads::DownloadCall,` | `prev_core::downloads::DownloadResponse` |
| `download_open_access_settings` | `downloadOpenAccessSettings` | `d:lib.rs` | `caller: WebviewWindow` | `bool` |
| `essentials_keep` | `essentialsKeep` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, site: String,` | `prev_ipc::OperationAdmission` |
| `essentials_release` | `essentialsRelease` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, site: String,` | `prev_ipc::OperationAdmission` |
| `export_browser_data` | `exportBrowserData` | `d:data_export.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, kind: ExportKindView,` | `ExportOutcomeView` |
| `extension_action_invoke` | `extensionActionInvoke` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile_id: String, install_id: String, runtime_generation: String, action_revision: String, anchor_x: f64, anchor_y: f64, anchor_width: f64, anchor_height: f64,` | `prev_ipc::OperationAdmission` |
| `extension_action_menu` | `extensionActionMenu` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile_id: String, install_id: String, runtime_generation: String, action_revision: String, anchor_x: f64, anchor_y: f64, anchor_width: f64, anchor_height: f64,` | `prev_ipc::OperationAdmission` |
| `favicon_probe` | `faviconProbe` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, origins: Vec<String>,` | `bool` |
| `focus_control` | `focusControl` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, shell: State<'_, Handle>, control: prev_ipc::FocusControl,` | `prev_ipc::OperationAdmission` |
| `haptic` | `haptic` | `d:haptics.rs` | `caller: WebviewWindow, kind: HapticKind` | `` |
| `history_call` | `historyCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_ipc::HistoryCall,` | `prev_ipc::HistoryResponse` |
| `history_menu_popup` | `historyMenuPopup` | `d:history_menu.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, id: String, forward: bool, x: f64, y: f64,` | `bool` |
| `import_cancel` | `importCancel` | `d:browser_import.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `bool` |
| `import_open_permission` | `importOpenPermission` | `d:browser_import.rs` | `caller: WebviewWindow, source: String` | `bool` |
| `import_sources` | `importSources` | `d:browser_import.rs` | `async caller: WebviewWindow` | `Vec<ImportSourceView>` |
| `import_start` | `importStart` | `d:browser_import.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, source: String, profile: String, kinds: Vec<ImportKindView>,` | `bool` |
| `keymap_bind` | `keymapBind` | `d:keymap.rs` | `caller: WebviewWindow, app: tauri::AppHandle, id: String, accelerator: Option<String>, replace: bool,` | `KeymapOutcome` |
| `keymap_entries` | `keymapEntries` | `d:keymap.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `Vec<KeymapEntry>` |
| `keymap_record` | `keymapRecord` | `d:keymap.rs` | `caller: WebviewWindow, app: tauri::AppHandle, active: bool` | `bool` |
| `keymap_reset` | `keymapReset` | `d:keymap.rs` | `caller: WebviewWindow, app: tauri::AppHandle, id: Option<String>,` | `bool` |
| `launcher_edit` | `launcherEdit` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, tab_id: String, url: String,` | `bool` |
| `launcher_open_accessibility` | `launcherOpenAccessibility` | `d:lib.rs` | `caller: WebviewWindow` | `` |
| `launcher_record_shortcut` | `launcherRecordShortcut` | `d:lib.rs` | `caller: WebviewWindow, active: bool` | `` |
| `launcher_run` | `launcherRun` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, action: prev_ipc::SearchAction, context: prev_ipc::SearchContext, background: bool,` | `prev_ipc::OperationAdmission` |
| `launcher_search` | `launcherSearch` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, shell: State<'_, Handle>, query: String, request_id: String,` | `bool` |
| `launcher_set_double_tap` | `launcherSetDoubleTap` | `d:lib.rs` | `caller: WebviewWindow, mode: launcher_trigger::DoubleTap,` | `Option<launcher_trigger::LauncherTrigger>` |
| `launcher_set_shortcut` | `launcherSetShortcut` | `d:lib.rs` | `caller: WebviewWindow, accelerator: String,` | `Option<launcher_trigger::TriggerChange>` |
| `launcher_trigger` | `launcherTrigger` | `d:lib.rs` | `caller: WebviewWindow` | `Option<launcher_trigger::LauncherTrigger>` |
| `link_describe` | `linkDescribe` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, shell: State<'_, prev_app::Handle>, expected_profile: String, environment: String, element: String,` | `Result<bool, ()>` |
| `login_item_open_settings` | `loginItemOpenSettings` | `d:login_item.rs` | `caller: WebviewWindow` | `bool` |
| `login_item_set` | `loginItemSet` | `d:login_item.rs` | `async caller: WebviewWindow, enabled: bool` | `LoginItemStatus` |
| `login_item_status` | `loginItemStatus` | `d:login_item.rs` | `async caller: WebviewWindow` | `LoginItemStatus` |
| `media_admit_remote` | `mediaAdmitRemote` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, shell: State<'_, prev_app::Handle>, expected_profile: String, environment: String, element: String, url: String,` | `Result<prev_ipc::MediaAdmitV1, ()>` |
| `media_import` | `mediaImport` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, shell: State<'_, prev_app::Handle>, expected_profile: String,` | `Result<MediaImportV1, ()>` |
| `media_open` | `mediaOpen` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, shell: State<'_, prev_app::Handle>, expected_profile: String, id: String,` | `Result<bool, ()>` |
| `media_player` | `mediaPlayer` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, action: prev_ipc::MediaPlayerAction,` | `prev_ipc::OperationAdmission` |
| `menu_popup` | `menuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64` | `bool` |
| `newtab_cancel` | `newtabCancel` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, context: prev_ipc::SearchContext,` | `bool` |
| `newtab_run` | `newtabRun` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, shell: State<'_, Handle>, action: prev_ipc::SearchAction, context: prev_ipc::SearchContext,` | `prev_ipc::OperationAdmission` |
| `newtab_search` | `newtabSearch` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, shell: State<'_, Handle>, query: String, context: prev_ipc::SearchContext,` | `bool` |
| `newtab_search_context` | `newtabSearchContext` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, tab_id: String,` | `Option<prev_ipc::SearchContext>` |
| `note_call` | `noteCall` | `d:notes.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: NoteCall,` | `NoteReply` |
| `onboarding_finish` | `onboardingFinish` | `d:lib.rs` | `caller: WebviewWindow, gate: State<'_, UiStartupGate>` | `bool` |
| `onboarding_play_intro` | `onboardingPlayIntro` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `bool` |
| `open_software_update` | `openSoftwareUpdate` | `d:updates.rs` | `caller: WebviewWindow` | `bool` |
| `operation_acknowledge` | `operationAcknowledge` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, operation_id: String,` | `bool` |
| `operation_status` | `operationStatus` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, operation_id: String,` | `prev_ipc::OperationStatus` |
| `operations_reconcile` | `operationsReconcile` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle,` | `Vec<prev_ipc::OperationDisposition>` |
| `page_assist_ask` | `pageAssistAsk` | `d:page_assist.rs` | `async caller: WebviewWindow, request: PageAssistAskV1,` | `PageAssistAskResponseV1` |
| `page_assist_cite` | `pageAssistCite` | `d:page_assist.rs` | `async caller: WebviewWindow, conversation: String, reply: u32, n: u8,` | `bool` |
| `page_assist_close` | `pageAssistClose` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String` | `bool` |
| `page_assist_continue` | `pageAssistContinue` | `d:page_assist.rs` | `async caller: WebviewWindow, conversation: String, reply: u32, block: u16,` | `PageAssistContinueV1` |
| `page_assist_decide` | `pageAssistDecide` | `d:page_assist.rs` | `async caller: WebviewWindow, conversation: String, reply: u32, block: u16, decision: PageAssistDecisionV1,` | `bool` |
| `page_assist_delete` | `pageAssistDelete` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String, conversation: String,` | `bool` |
| `page_assist_detach` | `pageAssistDetach` | `d:page_assist.rs` | `async caller: WebviewWindow, tab: String, pick: String` | `bool` |
| `page_assist_focus` | `pageAssistFocus` | `d:page_assist.rs` | `async caller: WebviewWindow, conversation: String, reply: u32, block: u16, n: Option<u8>,` | `bool` |
| `page_assist_history` | `pageAssistHistory` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String,` | `PageAssistHistoryV1` |
| `page_assist_new` | `pageAssistNew` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String` | `bool` |
| `page_assist_open` | `pageAssistOpen` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String, conversation: String,` | `bool` |
| `page_assist_pick` | `pageAssistPick` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String, tab: String,` | `PageAssistPickResponseV1` |
| `page_assist_pick_cancel` | `pageAssistPickCancel` | `d:page_assist.rs` | `async caller: WebviewWindow, tab: String` | `bool` |
| `page_assist_resume` | `pageAssistResume` | `d:page_assist.rs` | `async caller: WebviewWindow, conversation: String, reply: u32,` | `bool` |
| `page_assist_status` | `pageAssistStatus` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String, tab: Option<String>,` | `PageAssistStatusV1` |
| `page_assist_stop` | `pageAssistStop` | `d:page_assist.rs` | `async caller: WebviewWindow, space: String` | `bool` |
| `page_find` | `pageFind` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, query: Option<String>, forward: bool,` | `bool` |
| `page_permission_card_host` | `pagePermissionCardHost` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, available: bool` | `` |
| `page_permission_respond` | `pagePermissionRespond` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile_id: String, item_id: String, request_id: String, decision: PagePermissionPromptDecisionInput,` | `prev_ipc::OperationAdmission` |
| `page_source` | `pageSource` | `d:page_source.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, id: String,` | `Option<PageSourceView>` |
| `page_style_remove` | `pageStyleRemove` | `d:page_assist.rs` | `async caller: WebviewWindow, tab: String, style: String,` | `PageStylesV1` |
| `page_style_remove_for` | `pageStyleRemoveFor` | `d:page_assist.rs` | `async caller: WebviewWindow, profile: String, site: String, style: String,` | `PageStylesAllV1` |
| `page_style_toggle` | `pageStyleToggle` | `d:page_assist.rs` | `async caller: WebviewWindow, tab: String, style: String, enabled: bool,` | `PageStylesV1` |
| `page_style_toggle_for` | `pageStyleToggleFor` | `d:page_assist.rs` | `async caller: WebviewWindow, profile: String, site: String, style: String, enabled: bool,` | `PageStylesAllV1` |
| `page_styles` | `pageStyles` | `d:page_assist.rs` | `async caller: WebviewWindow, tab: String` | `PageStylesV1` |
| `page_styles_all` | `pageStylesAll` | `d:page_assist.rs` | `async caller: WebviewWindow, profile: String` | `PageStylesAllV1` |
| `panel_hide` | `panelHide` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `` |
| `panel_intent` | `panelIntent` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, intent: prev_ipc::PanelIntent,` | `bool` |
| `panel_layout` | `panelLayout` | `d:lib.rs` | `caller: WebviewWindow, overlay: State<'_, overlay::Overlay>, layout: prev_ipc::PanelLayout,` | `` |
| `panel_ready` | `panelReady` | `d:lib.rs` | `caller: WebviewWindow, overlay: State<'_, overlay::Overlay>,` | `Option<prev_ipc::PanelState>` |
| `profile_avatar_pick` | `profileAvatarPick` | `d:profiles.rs` | `async caller: WebviewWindow, app: AppHandle,` | `Result<ProfileAvatarPickV1, ()>` |
| `profile_menu_popup` | `profileMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64` | `bool` |
| `profile_rename` | `profileRename` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, name: String,` | `prev_ipc::OperationAdmission` |
| `profiles_create` | `profilesCreate` | `d:profiles.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, name: String, avatar: ProfileAvatarInputV1, and_switch: bool,` | `OperationAdmission` |
| `profiles_delete` | `profilesDelete` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile: String,` | `prev_ipc::OperationAdmission` |
| `profiles_get` | `profilesGet` | `d:profiles.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>,` | `Result<Option<ProfilesView>, ()>` |
| `profiles_rename` | `profilesRename` | `d:profiles.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile: String, name: String,` | `OperationAdmission` |
| `profiles_set_avatar` | `profilesSetAvatar` | `d:profiles.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile: String, avatar: ProfileAvatarInputV1,` | `OperationAdmission` |
| `profiles_switch` | `profilesSwitch` | `d:profiles.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, profile: String,` | `OperationAdmission` |
| `resource_call` | `resourceCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_ipc::ResourceCall,` | `prev_ipc::ResourceReply` |
| `resource_close_ready` | `resourceCloseReady` | `d:lib.rs` | `caller: WebviewWindow, token: String, success: bool` | `bool` |
| `run_command` | `runCommand` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, id: String,` | `prev_ipc::OperationAdmission` |
| `setting_get` | `settingGet` | `d:lib.rs` | `async caller: WebviewWindow, key: String` | `Option<String>` |
| `setting_set` | `settingSet` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, shell: State<'_, Handle>, key: String, value: String,` | `prev_ipc::OperationAdmission` |
| `sidebar_menu_popup` | `sidebarMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64, site_protected: Option<bool>, can_hide: bool, can_clear_data: bool, extensions: Vec<SidebarMenuExtension>, manage_extensions: bool,` | `bool` |
| `sidebar_peek` | `sidebarPeek` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, peek: bool, lights: bool, slide: bool,` | `` |
| `sidebar_resize` | `sidebarResize` | `d:lib.rs` | `async caller: WebviewWindow, width: f64, enabled: bool, revision: f64` | `bool` |
| `sidebar_resize_guide` | `sidebarResizeGuide` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, width: Option<f64>,` | `bool` |
| `sidebar_set_hidden` | `sidebarSetHidden` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, hidden: bool` | `` |
| `sidebar_set_width` | `sidebarSetWidth` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, width: f64, animate: bool, revision: f64,` | `` |
| `site_permission_set` | `sitePermissionSet` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, origin: String, kind: prev_ipc::SitePermissionKindView, decision: Option<prev_ipc::SitePermissionDecisionView>,` | `prev_ipc::OperationAdmission` |
| `site_permissions` | `sitePermissions` | `d:lib.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, origin: Option<String>,` | `Result<prev_ipc::SitePermissionsView, ()>` |
| `spaces_create` | `spacesCreate` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, name: String, look: SpaceLookInputV1,` | `OperationAdmission` |
| `spaces_delete` | `spacesDelete` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, space: String,` | `OperationAdmission` |
| `spaces_menu_popup` | `spacesMenuPopup` | `d:spaces.rs` | `caller: WebviewWindow, app: AppHandle, x: f64, y: f64` | `bool` |
| `spaces_move_tab` | `spacesMoveTab` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, tab: String, space: String,` | `OperationAdmission` |
| `spaces_reorder` | `spacesReorder` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, space: String, before: Option<String>,` | `OperationAdmission` |
| `spaces_step` | `spacesStep` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, step: i8,` | `OperationAdmission` |
| `spaces_switch` | `spacesSwitch` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, space: String,` | `OperationAdmission` |
| `spaces_update` | `spacesUpdate` | `d:spaces.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, space: String, name: String, look: SpaceLookInputV1,` | `OperationAdmission` |
| `swipe_region` | `swipeRegion` | `d:swipe.rs` | `async caller: WebviewWindow, region: Option<SwipeRegion>` | `bool` |
| `system_clock_24h` | `systemClock24h` | `d:system_time.rs` | `caller: WebviewWindow` | `Option<bool>` |
| `tab_drag_over` | `tabDragOver` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, x: Option<f64>, y: Option<f64>` | `` |
| `tab_drop` | `tabDrop` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, x: f64, y: f64,` | `prev_ipc::OperationAdmission` |
| `tab_menu_popup` | `tabMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, id: String, x: f64, y: f64, context: TabMenuContext,` | `bool` |
| `tab_set_muted` | `tabSetMuted` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, muted: bool,` | `prev_ipc::OperationAdmission` |
| `tabs_activate` | `tabsActivate` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_answer_page_request` | `tabsAnswerPageRequest` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, answer: prev_ipc::PageRequestAnswer,` | `prev_ipc::OperationAdmission` |
| `tabs_answer_sign_in` | `tabsAnswerSignIn` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, request: u32, credentials: Option<prev_ipc::SignInCredentials>,` | `prev_ipc::OperationAdmission` |
| `tabs_back` | `tabsBack` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_bootstrap` | `tabsBootstrap` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>` | `` |
| `tabs_close` | `tabsClose` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_continue_past_certificate` | `tabsContinuePastCertificate` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_forward` | `tabsForward` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_leave_split` | `tabsLeaveSplit` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_navigate` | `tabsNavigate` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, input: String,` | `prev_ipc::OperationAdmission` |
| `tabs_open` | `tabsOpen` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>` | `prev_ipc::OperationAdmission` |
| `tabs_reload` | `tabsReload` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `prev_ipc::OperationAdmission` |
| `tabs_set_essential` | `tabsSetEssential` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, id: String, essential: bool, before: Option<String>,` | `prev_ipc::OperationAdmission` |
| `tabs_split` | `tabsSplit` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, other: String,` | `prev_ipc::OperationAdmission` |
| `tabs_unsplit` | `tabsUnsplit` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>,` | `prev_ipc::OperationAdmission` |
| `time_call` | `timeCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_ipc::TimeCall,` | `prev_ipc::TimeResponse` |
| `tools_menu_popup` | `toolsMenuPopup` | `d:lib.rs` | `caller: WebviewWindow, app: tauri::AppHandle, x: f64, y: f64` | `bool` |
| `ui_info` | `uiInfo` | `d:lib.rs` | `caller: WebviewWindow` | `UiInfo` |
| `ui_ready` | `uiReady` | `d:lib.rs` | `caller: WebviewWindow, gate: State<'_, UiStartupGate>` | `bool` |
| `update_check` | `updateCheck` | `d:updates.rs` | `async caller: WebviewWindow, app: tauri::AppHandle,` | `Option<UpdateStatus>` |
| `update_highlights` | `updateHighlights` | `d:updates.rs` | `caller: WebviewWindow, app: tauri::AppHandle,` | `Option<UpdateHighlights>` |
| `update_relaunch` | `updateRelaunch` | `d:updates.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `bool` |
| `update_status` | `updateStatus` | `d:updates.rs` | `caller: WebviewWindow, updates: tauri::State<'_, Updates>,` | `Option<UpdateStatus>` |
| `voice_cancel` | `voiceCancel` | `d:voice.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `bool` |
| `voice_choose_engine` | `voiceChooseEngine` | `d:voice.rs` | `async caller: WebviewWindow, engine: Option<VoiceEngineV1>,` | `VoiceStatusV1` |
| `voice_choose_language` | `voiceChooseLanguage` | `d:voice.rs` | `async caller: WebviewWindow, language: Option<String>,` | `VoiceStatusV1` |
| `voice_open_privacy` | `voiceOpenPrivacy` | `d:voice.rs` | `caller: WebviewWindow, kind: VoicePrivacyV1` | `bool` |
| `voice_start` | `voiceStart` | `d:voice.rs` | `async caller: WebviewWindow, app: tauri::AppHandle` | `VoiceStartV1` |
| `voice_status` | `voiceStatus` | `d:voice.rs` | `async caller: WebviewWindow` | `VoiceStatusV1` |
| `voice_stop` | `voiceStop` | `d:voice.rs` | `caller: WebviewWindow, app: tauri::AppHandle, take: u32` | `bool` |
| `web_extension_answer_access` | `webExtensionAnswerAccess` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, request: prev_ipc::WebExtensionAccessRequestView, allowed: bool,` | `Result<(), String>` |
| `web_extension_cancel` | `webExtensionCancel` | `d:webext/mod.rs` | `async caller: WebviewWindow, review_id: String` | `` |
| `web_extension_choose_file` | `webExtensionChooseFile` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, folder: bool,` | `Result<Option<WebExtensionReview>, String>` |
| `web_extension_confirm` | `webExtensionConfirm` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, id: String, review_id: String,` | `Result<(), String>` |
| `web_extension_list` | `webExtensionList` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>,` | `Result<Vec<WebExtensionView>, String>` |
| `web_extension_open_options` | `webExtensionOpenOptions` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, id: String,` | `Result<(), String>` |
| `web_extension_prepare` | `webExtensionPrepare` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, tab_id: String,` | `Result<WebExtensionReview, String>` |
| `web_extension_prepare_file` | `webExtensionPrepareFile` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, path: String,` | `Result<WebExtensionReview, String>` |
| `web_extension_retry` | `webExtensionRetry` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, profile_id: String, install_id: String,` | `Result<(), String>` |
| `web_extension_review_update` | `webExtensionReviewUpdate` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, id: String,` | `Result<WebExtensionReview, String>` |
| `web_extension_set_access` | `webExtensionSetAccess` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, id: String, mode: String, sites: Vec<String>,` | `Result<(), String>` |
| `web_extension_set_enabled` | `webExtensionSetEnabled` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, id: String, enabled: bool,` | `Result<(), String>` |
| `web_extension_set_pinned` | `webExtensionSetPinned` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, id: String, pinned: bool,` | `Result<(), String>` |
| `web_extension_store_button` | `webExtensionStoreButton` | `d:webext/mod.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, tab_id: String, extension_id: String, state: WebExtensionStoreButtonState, label: String,` | `bool` |
| `web_extension_uninstall` | `webExtensionUninstall` | `d:webext/mod.rs` | `async caller: WebviewWindow, shell: State<'_, Handle>, extensions: State<'_, WebExtensions>, id: String,` | `Result<(), String>` |
| `windows_diagnostics_settings` | `windowsDiagnosticsSettings` | `d:windows_privacy.rs` | `caller: WebviewWindow` | `bool` |
| `windows_reputation_managed` | `windowsReputationManaged` | `d:windows_privacy.rs` | `caller: WebviewWindow` | `Option<bool>` |
| `work_activity` | `workActivity` | `d:work_product.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId,` | `prev_ipc::work::WorkActivityResponseV1` |
| `work_admit_folder` | `workAdmitFolder` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, expected_profile: String, path: String,` | `Result<prev_ipc::WorkFolderAdmitV1, ()>` |
| `work_call` | `workCall` | `d:work_product.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: WorkCallV1,` | `WorkResponseV1` |
| `work_cancel_connection_sign_in` | `workCancelConnectionSignIn` | `d:work_connections.rs` | `caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, id: String, request_id: String,` | `bool` |
| `work_change_memory` | `workChangeMemory` | `d:work_personal.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, query: WorkMemoryQueryV1, change: WorkMemoryChangeV1,` | `WorkMemoryResponseV1` |
| `work_change_skill` | `workChangeSkill` | `d:work_personal.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, change: WorkSkillChangeV1,` | `WorkSkillsResponseV1` |
| `work_check_connection` | `workCheckConnection` | `d:work_connections.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, id: String,` | `WorkServerCheckV1` |
| `work_choose_folder` | `workChooseFolder` | `d:work_folders.rs` | `async caller: WebviewWindow, app: AppHandle, expected_profile: String, start: Option<String>,` | `Result<Option<prev_ipc::WorkFolderAdmitV1>, ()>` |
| `work_choose_model` | `workChooseModel` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, role: WorkModelRole, id: Option<String>,` | `WorkModelsV1` |
| `work_clear_decision_key` | `workClearDecisionKey` | `d:work_decision.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `WorkDecisionPreferenceV1` |
| `work_clear_provider_key` | `workClearProviderKey` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, provider: WorkModelProvider,` | `WorkModelsV1` |
| `work_clear_website_data` | `workClearWebsiteData` | `d:work_website_data.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `bool` |
| `work_connections` | `workConnections` | `d:work_connections.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `WorkConnectionsResponseV1` |
| `work_context_preview` | `workContextPreview` | `d:work_product.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, purpose: prev_core::work::context::WorkContextPurpose, selection: prev_core::work::context::WorkContextSelectionV1,` | `prev_ipc::work::WorkContextPreviewV1` |
| `work_decision_preference` | `workDecisionPreference` | `d:work_decision.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `WorkDecisionPreferenceV1` |
| `work_edit_draft` | `workEditDraft` | `d:work_product.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, expected_revision: prev_core::work::WorkRevision, command: WorkCommandId, execution: prev_core::work::WorkExecutionId, artifact: prev_core::work::WorkArtifactId, body: String,` | `WorkResponseV1` |
| `work_human_check` | `workHumanCheck` | `d:work_human.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, page: WorkHumanPageIdV1,` | `WorkHumanCheckResponseV1` |
| `work_human_continue` | `workHumanContinue` | `d:work_human.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, page: WorkHumanPageIdV1, account: WorkHumanAccountV1,` | `WorkHumanResponseV1` |
| `work_human_extend` | `workHumanExtend` | `d:work_human.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, page: WorkHumanPageIdV1,` | `WorkHumanResponseV1` |
| `work_human_pages` | `workHumanPages` | `d:work_human.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId,` | `WorkHumanResponseV1` |
| `work_human_present` | `workHumanPresent` | `d:work_human.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, page: WorkHumanPageIdV1, region: WorkHumanRegionV1,` | `WorkHumanResponseV1` |
| `work_human_release` | `workHumanRelease` | `d:work_human.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, page: WorkHumanPageIdV1,` | `WorkHumanResponseV1` |
| `work_local_servers` | `workLocalServers` | `d:work_models.rs` | `async caller: WebviewWindow` | `Vec<WorkLocalServerV1>` |
| `work_memories` | `workMemories` | `d:work_personal.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, query: WorkMemoryQueryV1,` | `WorkMemoryResponseV1` |
| `work_models` | `workModels` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String` | `WorkModelsV1` |
| `work_models_ready` | `workModelsReady` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String,` | `WorkModelsReadyV1` |
| `work_more_models` | `workMoreModels` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, provider: WorkModelProvider,` | `WorkMoreModelsV1` |
| `work_operation` | `workOperation` | `d:work_product.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, operation: WorkCommandId, input: WorkOperationV1,` | `WorkOperationResponseV1` |
| `work_operation_status` | `workOperationStatus` | `d:work_product.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, work: WorkId, operation: WorkCommandId, acknowledge: bool,` | `WorkOperationResponseV1` |
| `work_pane_hide` | `workPaneHide` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>,` | `prev_ipc::OperationAdmission` |
| `work_pane_set_rect` | `workPaneSetRect` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, rect: prev_ipc::WorkPaneRect, generation: u32,` | `` |
| `work_pane_show` | `workPaneShow` | `d:lib.rs` | `caller: WebviewWindow, shell: State<'_, Handle>, target: prev_ipc::WorkPaneTarget, rect: prev_ipc::WorkPaneRect,` | `prev_ipc::OperationAdmission` |
| `work_pick_folder` | `workPickFolder` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, expected_profile: String,` | `Result<Option<prev_ipc::WorkFolderAdmitV1>, ()>` |
| `work_preview_connection` | `workPreviewConnection` | `d:work_connections.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, draft: WorkServerDraftV1,` | `WorkServerCheckV1` |
| `work_release_memory` | `workReleaseMemory` | `d:work_memory.rs` | `async caller: WebviewWindow, idle: bool` | `bool` |
| `work_remove_connection` | `workRemoveConnection` | `d:work_connections.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, id: String,` | `WorkConnectionsResponseV1` |
| `work_reveal_path` | `workRevealPath` | `d:media.rs` | `async caller: WebviewWindow, app: AppHandle, expected_profile: String, path: String,` | `Result<bool, ()>` |
| `work_running` | `workRunning` | `d:work_product.rs` | `caller: WebviewWindow, app: tauri::AppHandle` | `bool` |
| `work_save_calendar` | `workSaveCalendar` | `d:work_product.rs` | `async caller: WebviewWindow, name: String, text: String` | `bool` |
| `work_save_connection` | `workSaveConnection` | `d:work_connections.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, draft: WorkServerDraftV1,` | `WorkConnectionsResponseV1` |
| `work_screenshot_sites` | `workScreenshotSites` | `d:work_sites.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `prev_ipc::work::WorkScreenshotSitesResponseV1` |
| `work_set_decision_key` | `workSetDecisionKey` | `d:work_decision.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, secret: String,` | `WorkDecisionPreferenceV1` |
| `work_set_decision_preference` | `workSetDecisionPreference` | `d:work_decision.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, choice: WorkDecisionChoiceV1,` | `WorkDecisionPreferenceV1` |
| `work_set_model_effort` | `workSetModelEffort` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, effort: Option<WorkModelReasoning>,` | `WorkModelsV1` |
| `work_set_model_endpoint` | `workSetModelEndpoint` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, base: Option<String>,` | `WorkModelsV1` |
| `work_set_provider_key` | `workSetProviderKey` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, provider: WorkModelProvider, key: String,` | `WorkModelsV1` |
| `work_set_screenshot_site` | `workSetScreenshotSite` | `d:work_sites.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, change: prev_ipc::work::WorkScreenshotSiteChangeV1,` | `prev_ipc::work::WorkScreenshotSitesResponseV1` |
| `work_set_site` | `workSetSite` | `d:work_sites.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, change: WorkSiteChangeV1,` | `WorkSiteAccessResponseV1` |
| `work_sign_in_connection` | `workSignInConnection` | `d:work_connections.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, id: String,` | `WorkServerCheckV1` |
| `work_sites` | `workSites` | `d:work_sites.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `WorkSiteAccessResponseV1` |
| `work_skill_text` | `workSkillText` | `d:work_personal.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, name: String,` | `WorkSkillsResponseV1` |
| `work_skills` | `workSkills` | `d:work_personal.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String,` | `WorkSkillsResponseV1` |
| `work_test_provider_key` | `workTestProviderKey` | `d:work_models.rs` | `async caller: WebviewWindow, expected_profile: String, provider: WorkModelProvider,` | `WorkModelsV1` |
| `zoom_call` | `zoomCall` | `d:lib.rs` | `async caller: WebviewWindow, app: tauri::AppHandle, expected_profile: String, call: prev_ipc::ZoomCall,` | `prev_ipc::ZoomResponse` |

## Events (35)

| Wire channel | TS event | Payload type | Rename? |
|---|---|---|---|
| `blocker-status-changed` | `blockerStatusChanged` | `BlockerStatusChanged` | — |
| `browser-credential-capability-changed` | `browserCredentialCapabilityChanged` | `BrowserCredentialCapabilityChanged` | — |
| `downloads-changed` | `downloadsChanged` | `DownloadsChanged` | — |
| `extension-action-failed` | `extensionActionFailed` | `ExtensionActionFailed` | — |
| `extension-action-shortcut` | `extensionActionShortcut` | `ExtensionActionShortcut` | — |
| `extension-actions-changed` | `extensionActionsChanged` | `ExtensionActionsChanged` | — |
| `favicons-changed` | `faviconsChanged` | `FaviconsChanged` | — |
| `find-changed` | `findChanged` | `FindChanged` | — |
| `focus-changed` | `focusChanged` | `FocusChanged` | — |
| `items-changed` | `itemsChanged` | `ItemsChanged` | — |
| `layout-changed` | `layoutChanged` | `LayoutChanged` | — |
| `media-player-changed` | `mediaPlayerChanged` | `MediaPlayerChanged` | — |
| `note-open-requested` | `noteOpenRequested` | `NoteOpenRequested` | — |
| `notes-changed` | `notesChanged` | `NotesChanged` | — |
| `operation-processed` | `operationProcessed` | `OperationProcessed` | — |
| `page-permission-prompt-changed` | `pagePermissionPromptChanged` | `PagePermissionPromptChanged` | — |
| `resource-changed` | `resourceChanged` | `ResourceChanged` | — |
| `runtime-status-changed` | `runtimeStatusChanged` | `RuntimeStatusChanged` | — |
| `search-changed` | `searchChanged` | `SearchChanged` | — |
| `tab-changed` | `tabChanged` | `TabChanged` | — |
| `ui-command` | `uiCommand` | `UiCommand` | — |
| `web-extension-access-requested` | `webExtensionAccessRequested` | `WebExtensionAccessRequested` | — |
| `web-extension-store-clicked` | `webExtensionStoreClicked` | `WebExtensionStoreClicked` | — |
| `work-changed` | `workChanged` | `WorkChanged` | — |
| `work-environment-changed` | `workEnvironmentChanged` | `WorkEnvironmentChanged` | — |
| `prev:account-changed` | `prevAccountChanged` | `AccountChanged` | REN |
| `prev:import-progress` | `prevImportProgress` | `ImportJobView` | REN |
| `prev:keymap-changed` | `prevKeymapChanged` | `KeymapChanged` | REN |
| `prev:page-assist-changed` | `prevPageAssistChanged` | `PageAssistChanged` | REN |
| `prev:swipe` | `prevSwipe` | `SwipeScroll` | REN |
| `prev:voice-changed` | `prevVoiceChanged` | `VoiceChanged` | REN |
| `prev:voice-levels` | `prevVoiceLevels` | `VoiceLevels` | REN |
| `prev:work-decision-preference-changed` | `prevWorkDecisionPreferenceChanged` | `WorkDecisionPreferenceChanged` | REN |
| `prev:work-human-changed` | `prevWorkHumanChanged` | `WorkHumanChanged` | REN |
| `prev:work-models-changed` | `prevWorkModelsChanged` | `WorkModelsChanged` | REN |

## Porting notes for P2-T02

- Wire names are stable snake_case: keep them where possible; only the 8 REN channels change.
- `bindings.ts` is generated by Tauri Specta — do not hand-edit the original; `astra-proto` replaces the generator.
- Auth model (`caller` + CallerPolicy + `expectedProfile`) maps to Host API session + container scoping (D-12).
