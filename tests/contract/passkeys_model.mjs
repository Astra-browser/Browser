#!/usr/bin/env node
// Contract test for the passkey host module (Astra platform passkeys).
//
// Exercises the Settings seam and the WebAuthn prompt answer without a
// browser: a fake `@astra/passkeys;1` service and a fake prefs/observer
// service stand in for chrome. The real vault and the real `nsIWebAuthnService`
// are covered by the live Marionette probe.
import assert from "node:assert/strict";
import { check, passed, failed } from "./lib/harness.mjs";

const calls = [];
let status = {
  exists: true,
  has_pin: true,
  unlocked: false,
  system_unlock: false,
  system_auth_available: false,
  credential_count: 1,
  pin_retries_left: 5,
  locked_for_secs: 0,
};

const prefValues = new Map([
  ["security.webauthn.astra_passkeys", true],
]);

const vault = {
  get statusJson() {
    return JSON.stringify(status);
  },
  listJson() {
    return JSON.stringify([
      {
        id: "Y3JlZA==",
        rp_id: "example.com",
        user_name: "user@example.com",
        discoverable: true,
        created_at: 1700000000,
      },
    ]);
  },
  create(pin, systemUnlock) {
    calls.push(["create", pin, systemUnlock]);
    if (pin.length < 6) {
      const error = new Error("policy");
      error.result = 0x80070057;
      throw error;
    }
    status = { ...status, unlocked: true };
  },
  unlock(pin) {
    calls.push(["unlock", pin]);
    if (pin !== "123456") {
      status = { ...status, unlocked: false };
      const error = new Error("auth");
      error.result = 0x80530001;
      throw error;
    }
    status = { ...status, unlocked: true };
  },
  lock() {
    calls.push(["lock"]);
    status = { ...status, unlocked: false };
  },
  changePin(oldPin, newPin) {
    calls.push(["changePin", oldPin, newPin]);
  },
  setSystemUnlock(enabled) {
    calls.push(["setSystemUnlock", enabled]);
    status = { ...status, system_unlock: enabled };
  },
  removeCredential(id) {
    calls.push(["removeCredential", id]);
    return true;
  },
  removeAllCredentials() {
    calls.push(["removeAllCredentials"]);
  },
  destroy() {
    calls.push(["destroy"]);
  },
};

globalThis.Cc = {
  "@astra/passkeys;1": { getService: () => vault },
  "@mozilla.org/webauthn/service;1": {
    getService: () => ({
      cancel: (tid) => calls.push(["cancel", tid]),
      pinCallback: (tid, pin) => calls.push(["pin", tid, pin]),
      selectionCallback: (tid, selection) =>
        calls.push(["select", tid, selection]),
    }),
  },
};
globalThis.Ci = {
  nsIAstraPasskeys: {},
  nsIWebAuthnService: {},
  nsIFile: {},
};
globalThis.Cr = {
  NS_ERROR_FAILURE: 0x80004005,
  NS_ERROR_INVALID_ARG: 0x80070057,
  NS_ERROR_DOM_NOT_ALLOWED_ERR: 0x80530001,
  NS_ERROR_DOM_INVALID_STATE_ERR: 0x8053000b,
  NS_ERROR_NOT_IMPLEMENTED: 0x80004001,
  NS_ERROR_FILE_NOT_FOUND: 0x80520006,
};
let promptObserver = null;
globalThis.Services = {
  prefs: {
    getBoolPref: (name, fallback) =>
      prefValues.has(name) ? prefValues.get(name) : fallback,
    setBoolPref: (name, value) => prefValues.set(name, value),
    setStringPref: () => {},
  },
  dirsvc: { get: () => ({ path: "/tmp/astra-test-profile" }) },
  obs: {
    addObserver: (observer) => {
      promptObserver = observer;
    },
    removeObserver: () => {},
  },
};

const host = await import(
  new URL("../../overlay/astra/host/Passkeys.sys.mjs", import.meta.url)
);

host.activate();

const statusAnswer = host.call({ call: { kind: "status" } });
check("status is the vault's", statusAnswer.status.exists === true);
check("status carries the browser-wide switch", statusAnswer.status.enabled === true);
check("status has no credentials unless asked", statusAnswer.credentials.length === 0);

const listAnswer = host.call({ call: { kind: "list" } });
check("list answers one credential", listAnswer.credentials.length === 1);
check(
  "list carries the relying party and user",
  listAnswer.credentials[0].rp_id === "example.com" &&
    listAnswer.credentials[0].user_name === "user@example.com",
);

check(
  "unlock passes the PIN to the vault",
  host.call({ call: { kind: "unlock", pin: "123456" } }).ok === true,
);

const refused = host.call({ call: { kind: "unlock", pin: "000000" } });
check("a wrong PIN is reported as auth", refused.ok === false && refused.error === "auth");
check("a refused unlock keeps the vault locked", refused.status.unlocked === false);

const short = host.call({
  call: { kind: "enable", pin: "123", system_unlock: false },
});
check("a short PIN is refused by policy", short.error === "pin_policy");

const unknown = host.call({ call: { kind: "not_a_call" } });
check("an unknown call is a closed error", unknown.error === "unknown_call");

const disabled = host.call({ call: { kind: "set_enabled", enabled: false } });
check(
  "the browser-wide switch writes the pref",
  disabled.status.enabled === false &&
    prefValues.get("security.webauthn.astra_passkeys") === false,
);
check("disabling locks the vault", calls.some(([name]) => name === "lock"));

check(
  "removing one credential reaches the service",
  host.call({ call: { kind: "remove", id: "Y3JlZA==" } }).ok === true &&
    calls.some(([name, id]) => name === "removeCredential" && id === "Y3JlZA=="),
);

const webauthn = host.answer({ tid: "7", action: "pin", value: "123456" });
check("a PIN answer reaches the WebAuthn service", webauthn === true);
check(
  "a PIN answer carries the transaction",
  calls.some(([name, tid, pin]) => name === "pin" && tid === 7 && pin === "123456"),
);

host.answer({ tid: 8, action: "cancel" });
check(
  "a cancel reaches the WebAuthn service",
  calls.some(([name, tid]) => name === "cancel" && tid === 8),
);

// A prompt in a private browsing context is refused at the seam: the service
// is told to cancel before the token can create or use a credential.
globalThis.BrowsingContext = { get: () => ({ usePrivateBrowsing: true }) };
const before = calls.filter(([name]) => name === "cancel").length;
promptObserver(null, "webauthn-prompt", JSON.stringify({
  prompt: { type: "pin-required" },
  tid: 99,
  origin: "https://example.com",
  browsingContextId: 5,
}));
check(
  "a private-window prompt is cancelled before the token runs",
  calls.filter(([name]) => name === "cancel").length === before + 1 &&
    calls.some(([name, tid]) => name === "cancel" && tid === 99),
);
check("a private-window prompt is not shown", host.currentPrompt() === null);

globalThis.BrowsingContext = { get: () => ({ usePrivateBrowsing: false }) };
promptObserver(null, "webauthn-prompt", JSON.stringify({
  prompt: { type: "pin-required" },
  tid: 100,
  origin: "https://example.com",
  browsingContextId: 6,
}));
check("a normal prompt is forwarded", host.currentPrompt()?.tid === 100);

host.deactivate();

// --- A build that does not carry the vault class ---------------------------
// `@astra/passkeys;1` is missing (Windows today: passkeys are Windows Hello's),
// so `Cc[...]` throws. The module must resolve that once, answer every verb
// with one structured "not on this build", and never throw a dead sheet at the
// person or hide the browser's own prompt.
let vaultLookups = 0;
globalThis.Cc = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === "@astra/passkeys;1") {
        vaultLookups += 1;
        const error = new Error("NS_ERROR_FACTORY_NOT_REGISTERED");
        error.result = 0x80040111;
        throw error;
      }
      if (key === "@mozilla.org/webauthn/service;1") {
        return {
          getService: () => ({
            cancel: (tid) => calls.push(["cancel", tid]),
            pinCallback: (tid, pin) => calls.push(["pin", tid, pin]),
            selectionCallback: (tid, selection) => calls.push(["select", tid, selection]),
          }),
        };
      }
      return undefined;
    },
  },
);
prefValues.delete("astra.passkeys.ui");
const absent = await import(
  new URL("../../overlay/astra/host/Passkeys.sys.mjs?without-vault", import.meta.url)
);
const callsBeforeAbsent = calls.length;

absent.activate();
check(
  "a build without the vault keeps the browser's own prompt",
  prefValues.get("astra.passkeys.ui") === undefined,
);

const absentStatus = absent.status();
check(
  "status names the platform, not a generic failure",
  absentStatus.available === false && absentStatus.reason === "platform_unsupported",
);
check(
  "status keeps the full shape",
  absentStatus.exists === false &&
    absentStatus.has_pin === false &&
    absentStatus.unlocked === false &&
    absentStatus.system_auth_available === false &&
    absentStatus.error === "platform_unsupported",
);
let threw = false;
try {
  absent.call({ call: { kind: "status" } });
} catch {
  threw = true;
}
check("status does not throw without a vault", !threw);

const absentCreate = absent.call({ call: { kind: "enable", pin: "123456", system_unlock: false } });
check(
  "creating a vault is refused with the platform code",
  absentCreate.ok === false && absentCreate.error === "platform_unsupported",
);
check("the refusal carries the unavailable status", absentCreate.status.available === false);
check(
  "listing is empty instead of throwing",
  absent.call({ call: { kind: "list" } }).credentials.length === 0,
);
check("the switch is refused too", absent.call({ call: { kind: "set_enabled", enabled: false } }).ok === false);
check("the class is resolved once, not per call", vaultLookups === 1);
check(
  "no vault verb was attempted",
  !calls
    .slice(callsBeforeAbsent)
    .some(([name]) => name === "create" || name === "unlock" || name === "lock"),
);

absent.deactivate();

console.log(`\npasskey host contract: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
