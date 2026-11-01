/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-host-trait`: the seam replacing shell-runtime coupling.
//!
//! UI and `astra-core` never touch browser-engine or shell-runtime APIs
//! directly — only this trait (enforced by lint). Implementors:
//! [`MockHost`](mock::MockHost) (tests/dev) and the Gecko host (over the
//! Host API + BiDi), which is the only implementor allowed to speak the
//! Host API wire format.
//!
//! Method groups derive from the IPC surface inventory
//! (`docs/astra/ipc-surface.md`): Tabs, Navigation, Windows, Settings,
//! Downloads, Permissions, Session (profiles/spaces), Native (OS services),
//! plus host event channels.

pub mod admission;
pub mod downloads;
pub mod events;
pub mod ids;
pub mod mock;
pub mod native;
pub mod permissions;
pub mod session;
pub mod tabs;
pub mod windows;

pub use admission::Admission;
pub use downloads::{DownloadInfo, DownloadState};
pub use events::{EventChannel, HostEvent};
pub use ids::{DownloadId, ProfileId, SpaceId, TabId, WindowId};
pub use mock::{MockError, MockHost};
pub use native::HapticKind;
pub use permissions::{PermissionDecision, PermissionKind, PermissionRequest};
pub use session::{ProfileInfo, SpaceInfo};
pub use tabs::TabInfo;
pub use windows::WindowInfo;

use std::sync::mpsc;

/// The browser-host seam.
///
/// Methods are declared as `fn ... -> impl Future<Output = ...> + Send`
/// (rather than `async fn`) so implementors promise executor-compatible
/// futures; `async fn` in the impl satisfies these signatures.
///
/// All methods are scoped to a profile/container by the caller; the auth
/// model (caller identity + expected profile) from the IPC surface maps to
/// Host API session + container scoping in the Gecko implementation.
pub trait BrowserHost: Send + Sync {
    /// Host-local error type.
    type Error: std::error::Error + Send + Sync + 'static;

    /// Stable implementor name (`"mock"`, `"gecko"`, …) for diagnostics.
    fn host_name(&self) -> &'static str;

    // -- Tabs / navigation (`tabs_*`, `page_find`, `zoom_call`) --

    fn tab_open(
        &self,
        profile: &ProfileId,
    ) -> impl std::future::Future<Output = Result<TabId, Self::Error>> + Send;
    fn tab_close(
        &self,
        id: &TabId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_activate(
        &self,
        id: &TabId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_navigate(
        &self,
        id: &TabId,
        input: &str,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_reload(
        &self,
        id: &TabId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_back(
        &self,
        id: &TabId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_forward(
        &self,
        id: &TabId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_set_muted(
        &self,
        id: &TabId,
        muted: bool,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;
    fn tab_snapshot(
        &self,
        id: &TabId,
    ) -> impl std::future::Future<Output = Result<Option<TabInfo>, Self::Error>> + Send;

    // -- Windows (`windows_*`, `panel_*`) --

    fn window_open(
        &self,
        profile: &ProfileId,
    ) -> impl std::future::Future<Output = Result<WindowId, Self::Error>> + Send;
    fn window_close(
        &self,
        id: &WindowId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;

    // -- Settings (`setting_*`, applied at `Boot`) --

    fn setting_get(
        &self,
        key: &str,
    ) -> impl std::future::Future<Output = Result<Option<String>, Self::Error>> + Send;
    fn setting_set(
        &self,
        key: &str,
        value: &str,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;

    // -- Downloads (`download_*`) --

    fn download_start(
        &self,
        url: &str,
        profile: &ProfileId,
    ) -> impl std::future::Future<Output = Result<DownloadId, Self::Error>> + Send;
    fn download_state(
        &self,
        id: &DownloadId,
    ) -> impl std::future::Future<Output = Result<Option<DownloadInfo>, Self::Error>> + Send;

    // -- Permissions (`site_permission_*`, `page_permission_*`) --

    fn permission_decide(
        &self,
        req: &PermissionRequest,
        decision: PermissionDecision,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;

    // -- Session: profiles + spaces (`profiles_*`, `spaces_*`) --

    fn profiles_list(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<ProfileInfo>, Self::Error>> + Send;
    fn profile_switch(
        &self,
        id: &ProfileId,
    ) -> impl std::future::Future<Output = Result<Admission, Self::Error>> + Send;

    // -- Native OS services (`haptic`, clipboard, login item) --

    fn haptic(
        &self,
        kind: HapticKind,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send;
    fn clipboard_write(
        &self,
        text: &str,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send;
    fn clipboard_read(
        &self,
    ) -> impl std::future::Future<Output = Result<Option<String>, Self::Error>> + Send;

    // -- Events --

    /// Subscribe to a host event channel; dropped receivers unsubscribe.
    fn subscribe(&self, channel: EventChannel) -> Result<mpsc::Receiver<HostEvent>, Self::Error>;
}
