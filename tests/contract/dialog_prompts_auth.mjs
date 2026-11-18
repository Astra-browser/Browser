#!/usr/bin/env node
// P6c-1 contract test: HTTP auth becomes the app's sign-in card.
//
//   - a basic challenge publishes page_request and waits for an answer
//   - Sign In sets authInfo and resolves true; Cancel resolves false
//   - a stale/wrong-tab answer is refused and leaves the engine promise alone
//   - unsupported schemes are cancelled, never handed to Firefox's dialog
//   - credentials never enter an event or the tab projection
//   - navigation/tab close cancels the pending challenge
//
// Usage: node tests/contract/dialog_prompts_auth.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { DialogPrompts } = await import(pathToFileURL(path.join(HOST, "DialogPrompts.sys.mjs")).href);
const { Tabs, __resetTabsForTests } = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href);
const { __resetOperationsForTests, Operations } = await import(pathToFileURL(path.join(HOST, "Operations.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const disposition = async (admission) => (await Operations.status(admission)).disposition;

function reset() {
  DialogPrompts.__resetForTests();
  __resetOperationsForTests();
  __resetTabsForTests();
}

function fakeBrowser(tabId) {
  const tab = { getAttribute: (name) => (name === "astra-tab-id" ? tabId : null) };
  const win = { gBrowser: { getTabForBrowser: () => tab } };
  return { ownerDocument: { defaultView: win } };
}

function authInfo(overrides = {}) {
  return {
    authenticationScheme: "basic",
    realm: "Astra Probe",
    flags: 0,
    username: "",
    password: "",
    ...overrides,
  };
}

const seen = [];
const off = Events.addEventListener((event) => seen.push(event));

reset();
await Tabs.bootstrap({ request_id: "boot" });
const tabId = (await Tabs.list({ request_id: "list" })).tabs[0].astra_tab_id;
const eventsBefore = seen.length;

{
  const browser = fakeBrowser(tabId);
  const channel = { URI: { schemeIs: () => false, host: "auth.example" } };
  const info = authInfo();
  const engine = DialogPrompts.promptAuth({ browser, channel, authInfo: info });
  check("a basic challenge is owned", engine instanceof Promise);
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("the card is pending", DialogPrompts.pending().length === 1);
  const pending = DialogPrompts.pending()[0];
  check("the card is fenced to the tab", pending.tab_id === tabId);
  const tab = (await Tabs.list({ request_id: "l" })).tabs[0];
  check("the tab carries the sign-in card", tab.page_request?.kind === "http_auth");
  check("the card names the host", tab.page_request?.host === "auth.example", tab.page_request);
  check("the card is not a retry yet", tab.page_request?.retry === false);

  const wrong = await DialogPrompts.answerAuth({
    astra_tab_id: "tab-other",
    request: pending.request,
    credentials: { username: "u", password: "p" },
  });
  check("a wrong tab is refused", (await disposition(wrong)).reason === "invalid_scope");
  check("a refused answer keeps the challenge", DialogPrompts.pending().length === 1);

  const admission = await DialogPrompts.answerAuth({
    astra_tab_id: tabId,
    request: pending.request,
    credentials: { username: "astra", password: "s3cret" },
  });
  check("an exact answer is applied", (await disposition(admission)).outcome === "applied");
  check("the engine gets the credentials", info.username === "astra" && info.password === "s3cret");
  check("the engine promise resolves true", (await engine) === true);
  check("the card closes", (await Tabs.list({ request_id: "l2" })).tabs[0].page_request === null);
  check("nothing is left pending", DialogPrompts.pending().length === 0);

  const double = await DialogPrompts.answerAuth({
    astra_tab_id: tabId,
    request: pending.request,
    credentials: { username: "astra", password: "s3cret" },
  });
  check("a replay is refused", (await disposition(double)).reason === "invalid_scope");

  const text = JSON.stringify(seen.slice(eventsBefore));
  check("credentials never enter an event", !text.includes("s3cret") && !text.includes("astra\""));
}

{
  // Cancel: the card closes, the engine gets false, nothing is stored.
  reset();
  __resetTabsForTests();
  await Tabs.bootstrap({ request_id: "boot2" });
  const id = (await Tabs.list({ request_id: "list2" })).tabs[0].astra_tab_id;
  const engine = DialogPrompts.promptAuth({
    browser: fakeBrowser(id),
    channel: { URI: { schemeIs: () => true, host: "plain.example" } },
    authInfo: authInfo({ flags: 16 /* PREVIOUS_FAILED */ }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = DialogPrompts.pending()[0];
  check("a plain-http challenge is marked insecure", (await Tabs.list({ request_id: "l3" })).tabs[0].page_request?.insecure === true);
  check("a retry is marked", (await Tabs.list({ request_id: "l3b" })).tabs[0].page_request?.retry === true);
  const admission = await DialogPrompts.answerAuth({
    astra_tab_id: id,
    request: pending.request,
    credentials: null,
  });
  check("cancel reports no_op", (await disposition(admission)).outcome === "no_op");
  check("cancel resolves the engine false", (await engine) === false);
  check("cancel closes the card", (await Tabs.list({ request_id: "l4" })).tabs[0].page_request === null);
}

{
  // Unsupported schemes are cancelled rather than handed to Firefox.
  reset();
  const engine = DialogPrompts.promptAuth({
    browser: fakeBrowser("tab-1"),
    channel: { URI: { schemeIs: () => false, host: "ntlm.example" } },
    authInfo: authInfo({ authenticationScheme: "ntlm" }),
  });
  check("ntlm is cancelled, not shown natively", (await engine) === false);
  check("ntlm publishes no card", DialogPrompts.pending().length === 0);
}

{
  // A navigation ends the challenge.
  reset();
  __resetTabsForTests();
  await Tabs.bootstrap({ request_id: "boot3" });
  const id = (await Tabs.list({ request_id: "list3" })).tabs[0].astra_tab_id;
  const engine = DialogPrompts.promptAuth({
    browser: fakeBrowser(id),
    channel: { URI: { schemeIs: () => false, host: "nav.example" } },
    authInfo: authInfo(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  Events.emit("nav.committed", { astra_tab_id: id, url: "https://next.example/" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("navigation cancels the challenge", (await engine) === false);
  check("navigation clears the card", DialogPrompts.pending().length === 0);
}

off();
console.log(
  `\ndialog prompts auth contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);
