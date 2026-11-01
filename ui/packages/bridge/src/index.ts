/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// `@astra/bridge` (P2-T08) — public surface.

export { PROTOCOL_VERSION, COMMANDS, EVENTS, EVENT_RENAMES, makeRequest, parseEnvelope } from "./proto.js";
export type { CommandName, EventChannel, Envelope, EnvelopeKind, ProtoError } from "./proto.js";
export { EventBus } from "./event-bus.js";
export { MockHost, mockCommandNames, mockEventChannels, renameChannel } from "./mock-host.js";
export type { MockResponder, MockFrameSink } from "./mock-host.js";
export { createHostDispatch, hostRoutedCommands } from "./host-transport.js";
export type { HostModules } from "./host-transport.js";
export { Bridge, BridgeError, configureBridge, getBridge, resetBridge } from "./bridge.js";
export type { BridgeEvent, BridgeMode, BridgeOptions, DispatchFn, EventHandler, SequenceGap, UnlistenFn } from "./bridge.js";
export { invoke, listen, once, emit, getCurrentWindow, setWindowLabel } from "./tauri-shim.js";
export type { TauriLikeEvent, TauriHandler, BridgeWindow } from "./tauri-shim.js";
export type { BridgeMode as Mode } from "./types.js";
export { defaultNewId } from "./types.js";
