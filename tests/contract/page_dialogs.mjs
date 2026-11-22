#!/usr/bin/env node
// ASTRA-0020 contract: page alert/confirm/prompt/beforeunload belong to Astra.
//
// Drives the chrome-side controller with fakes only:
//   - install publishes `win.__astraPageDialogs`; uninstall removes it
//   - present -> one `page-dialog-prompt-changed` event with the page's facts
//   - answer -> the engine-shaped result (confirmed/buttonNum/value/checked)
//   - silence -> cancelled after the timeout, never a blocked page
//   - a wrong request token or another window's stamp is refused
//   - a second window keeps its own request and never answers the first's
//   - select, HTTP auth and non-beforeunload confirmEx stay on the engine path
//   - the event carries a host only, never a path or query
//
// Usage: node tests/contract/page_dialogs.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const { PageDialogs, pageDialogKind } = await import(
  pathToFileURL(path.join(HOST, "PageDialogs.sys.mjs")).href
);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);
const { Operations, __resetOperationsForTests } = await import(
  pathToFileURL(path.join(HOST, "Operations.sys.mjs")).href
);

const seen = [];
const off = Events.addEventListener((event) => {
  if (event.type === "page-dialog-prompt-changed") seen.push(event);
});
const prompts = () => seen.filter((event) => event.data.closed !== true);
const closed = () => seen.filter((event) => event.data.closed === true);
const last = () => prompts().at(-1)?.data;

function fakeWindow(id) {
  return {
    __astraWindowId: id,
    addEventListener() {},
    removeEventListener() {},
  };
}

function reset() {
  PageDialogs.__resetForTests();
  __resetOperationsForTests();
  seen.length = 0;
}

async function reason(admission) {
  return (await Operations.status(admission)).disposition?.reason ?? "";
}

const alertArgs = {
  promptType: "alert",
  title: "The page at 127.0.0.1:2874 says:",
  text: "hello from the page",
  modalType: 2,
};

// === Ownership ===
{
  check("alert is an Astra dialog", pageDialogKind(alertArgs) === "alert");
  check(
    "confirm is an Astra dialog",
    pageDialogKind({ promptType: "confirm" }) === "confirm",
  );
  check(
    "prompt is an Astra dialog",
    pageDialogKind({ promptType: "prompt", value: "x" }) === "prompt",
  );
  check(
    "beforeunload is an Astra dialog",
    pageDialogKind({ promptType: "confirmEx", inPermitUnload: true }) === "beforeunload",
  );
  check("select keeps the engine dialog", pageDialogKind({ promptType: "select" }) === null);
  check(
    "HTTP auth keeps the engine dialog",
    pageDialogKind({ promptType: "promptUserAndPass" }) === null &&
      pageDialogKind({ promptType: "promptPassword" }) === null,
  );
  check(
    "repost/folder confirmEx keeps the engine dialog",
    pageDialogKind({ promptType: "confirmEx", inPermitUnload: false }) === null,
  );
  check("garbage args own nothing", pageDialogKind(null) === null);
}

// === install / uninstall ===
{
  reset();
  const win = fakeWindow("win-1");
  check("install publishes the controller", PageDialogs.install({ window: win }) === true);
  check("window carries the controller", typeof win.__astraPageDialogs?.present === "function");
  const again = PageDialogs.install({ window: win });
  check("install is idempotent", again === true && win.__astraPageDialogs === win.__astraPageDialogs);
  check("uninstall removes it", PageDialogs.uninstall({ window: win }) === true);
  check("expando is gone", win.__astraPageDialogs === undefined);
}

// === present -> event -> answer ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  const promise = win.__astraPageDialogs.present(alertArgs, { host: "127.0.0.1:2874" });
  const event = last();
  check("present emits one event", prompts().length === 1);
  check("event carries the kind", event?.kind === "alert");
  check("event carries the host", event?.host === "127.0.0.1:2874");
  check("event carries the text", event?.text === "hello from the page");
  check("event carries a request token", typeof event?.request === "string" && event.request.length > 10);
  check("alert has no default value", event?.defaultValue === "");
  check("alert has no checkbox label", event?.checkboxLabel === "");
  check("event carries no path or query", !JSON.stringify(event).includes("?"));
  check("present is pending until answered", typeof promise.then === "function");

  const bad = await PageDialogs.answer({
    request: "page-dialog-nope",
    confirmed: true,
    window_id: "win-1",
  });
  check("unknown request is refused", (await reason(bad)) === "invalid_scope");
  check("refusal leaves the request pending", win.__astraPageDialogs.pending().length === 1);

  const admission = await PageDialogs.answer({
    request: event.request,
    confirmed: true,
    window_id: "win-1",
  });
  check("answer is admitted", admission.accepted === true && admission.operation_id !== null);
  const result = await promise;
  check("alert answer confirms", result.confirmed === true && result.buttonNum === 0);
  check("answer clears the request", win.__astraPageDialogs.pending().length === 0);
  check("answer emits the closed notice", closed().some((entry) => entry.data.request === event.request));
  check("a second answer is refused", (await reason(
    await PageDialogs.answer({ request: event.request, confirmed: true, window_id: "win-1" }),
  )) === "invalid_scope");
}

// === confirm cancel and prompt value/checkbox ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  const confirm = win.__astraPageDialogs.present(
    { promptType: "confirm", title: "t", text: "sure?" },
    { host: "example.test" },
  );
  await PageDialogs.answer({ request: last().request, confirmed: false, window_id: "win-1" });
  const cancelled = await confirm;
  check("confirm cancel is not confirmed", cancelled.confirmed === false);
  check("confirm cancel selects button 1", cancelled.buttonNum === 1);

  const prompt = win.__astraPageDialogs.present(
    {
      promptType: "prompt",
      title: "t",
      text: "name?",
      value: "initial",
      checkLabel: "Remember this",
      checked: false,
    },
    { host: "example.test" },
  );
  const promptEvent = last();
  check("prompt event carries the default", promptEvent.defaultValue === "initial");
  check("prompt event carries the checkbox label", promptEvent.checkboxLabel === "Remember this");
  await PageDialogs.answer({
    request: promptEvent.request,
    confirmed: true,
    value: "typed",
    checked: true,
    window_id: "win-1",
  });
  const answered = await prompt;
  check("prompt answer carries the value", answered.value === "typed");
  check("prompt answer carries the checkbox", answered.checked === true);
  check("prompt answer confirms", answered.confirmed === true && answered.buttonNum === 0);
}

// === beforeunload ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  const leave = win.__astraPageDialogs.present(
    {
      promptType: "confirmEx",
      inPermitUnload: true,
      title: "This page is asking you to confirm that you want to leave",
      text: "Changes you made may not be saved.",
    },
    { host: "example.test" },
  );
  check("beforeunload event names its kind", last().kind === "beforeunload");
  await PageDialogs.answer({ request: last().request, confirmed: true, window_id: "win-1" });
  const result = await leave;
  check("leave resolves button 0", result.buttonNum === 0 && result.confirmed === true);

  const stay = win.__astraPageDialogs.present(
    { promptType: "confirmEx", inPermitUnload: true, text: "stay?" },
    { host: "example.test" },
  );
  await PageDialogs.answer({ request: last().request, confirmed: false, window_id: "win-1" });
  check("stay resolves button 1", (await stay).buttonNum === 1);
}

// === timeout cancels, never blocks ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  PageDialogs.__setTimeoutForTests(20);
  const promise = win.__astraPageDialogs.present({ promptType: "alert", text: "never answered" });
  const request = last().request;
  const result = await promise;
  check("a silent dialog is cancelled", result.confirmed === false && result.buttonNum === 1);
  check("timeout clears the request", win.__astraPageDialogs.pending().length === 0);
  check("timeout emits the closed notice", closed().some((entry) => entry.data.request === request));
  PageDialogs.__setTimeoutForTests(60_000);
}

// === second window isolation ===
{
  reset();
  const one = fakeWindow("win-1");
  const two = fakeWindow("win-2");
  PageDialogs.install({ window: one });
  PageDialogs.install({ window: two });
  const firstRequest = one.__astraPageDialogs.present({ promptType: "alert", text: "one" });
  const first = last().request;
  const secondRequest = two.__astraPageDialogs.present({ promptType: "alert", text: "two" });
  const second = last().request;
  check("two windows raise two requests", first !== second);

  const leak = await PageDialogs.answer({
    request: second,
    confirmed: true,
    window_id: "win-1",
  });
  check("another window's token is refused", (await reason(leak)) === "invalid_scope");
  check("the second window still waits", two.__astraPageDialogs.pending().includes(second));
  check("the first window is untouched", one.__astraPageDialogs.pending().includes(first));

  await PageDialogs.answer({ request: second, confirmed: true, window_id: "win-2" });
  check("the owning window answers", (await secondRequest).confirmed === true);
  check("the first window still waits after that", one.__astraPageDialogs.pending().includes(first));

  await PageDialogs.answer({ request: first, confirmed: false, window_id: "win-1" });
  check("the first window answers its own", (await firstRequest).confirmed === false);
}

// === no window stamp, no answer ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  const promise = win.__astraPageDialogs.present({ promptType: "confirm", text: "?" });
  const request = last().request;
  const refused = await PageDialogs.answer({ request, confirmed: true });
  check("an unstamped answer is refused", (await reason(refused)) === "invalid_scope");
  await PageDialogs.answer({ request, confirmed: true, window_id: "win-1" });
  check("the request survives the refusal", (await promise).confirmed === true);
}

// === a host only, never a URL ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  const promise = win.__astraPageDialogs.present(
    { promptType: "alert", text: "x" },
    { host: "evil.example/path?token=secret" },
  );
  check("a host with a path is dropped", last().host === "");
  await PageDialogs.answer({ request: last().request, confirmed: false, window_id: "win-1" });
  await promise;
}

// === uninstall cancels what is pending ===
{
  reset();
  const win = fakeWindow("win-1");
  PageDialogs.install({ window: win });
  const promise = win.__astraPageDialogs.present({ promptType: "alert", text: "closing" });
  PageDialogs.uninstall({ window: win });
  const result = await promise;
  check("uninstall settles the pending dialog", result.confirmed === false);
  check("uninstall leaves nothing pending", PageDialogs.pending().length === 0);
}

off();

console.log(`\npage dialogs contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
