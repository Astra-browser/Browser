// App-frame relay: the namespace check, the module surface the app may reach
// and the teardown contract. Runs against a fake chrome document, so no
// browser is needed: `node --test ui/shell/src`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mountAppFrame, SHELL_NS } from "./app-frame.js";

/** Minimal chrome document + window the frame builder accepts. */
function makeEnv() {
  const posted = [];
  const listeners = new Map();
  const win = {
    __astraRelayCount: 0,
    addEventListener(type, fn) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  const frame = {
    style: {},
    dataset: {},
    contentWindow: {
      postMessage: (message) => posted.push(message),
    },
    setAttribute() {},
    remove() {},
  };
  const container = {
    dataset: {},
    children: [],
    ownerDocument: {
      defaultView: win,
      createElementNS: () => frame,
    },
    appendChild(child) {
      container.children.push(child);
    },
  };
  /** Deliver a message the way the window dispatches one. */
  const deliver = (data, source = null) => {
    for (const fn of listeners.get("message") ?? []) {
      fn({ data, source });
    }
  };
  return { win, frame, container, posted, listeners, deliver };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeHost() {
  const calls = [];
  let off = 0;
  return {
    calls,
    Tabs: {
      list: async (args) => {
        calls.push(args);
        return { tabs: [] };
      },
      setTitle: async () => ({ ok: true }),
    },
    addEventListener: () => () => {
      off += 1;
    },
    get removed() {
      return off;
    },
  };
}

describe("mountAppFrame relay", () => {
  it("answers a host call from the embedded app", async () => {
    const env = makeEnv();
    const host = fakeHost();
    const api = mountAppFrame(env.container, host);
    try {
      env.deliver({ ns: SHELL_NS, kind: "req", id: 7, module: "Tabs", method: "list", args: {} });
      await tick();
      const reply = env.posted.find((message) => message.kind === "res");
      assert.ok(reply, "the app gets a reply");
      assert.equal(reply.id, 7);
      assert.deepEqual(reply.payload, { tabs: [] });
      assert.equal(reply.error, null);
    } finally {
      api.destroy();
    }
  });

  it("cannot reach prototypes or private members", async () => {
    const env = makeEnv();
    const host = fakeHost();
    const api = mountAppFrame(env.container, host);
    try {
      const calls = [
        { module: "Tabs", method: "constructor" },
        { module: "Tabs", method: "toString" },
        { module: "__proto__", method: "toString" },
        { module: "_state", method: "get" },
        { module: "addEventListener", method: "call" },
        { module: "Tabs", method: "hasOwnProperty" },
      ];
      for (const [index, call] of calls.entries()) {
        env.deliver({ ns: SHELL_NS, kind: "req", id: index, ...call, args: {} });
      }
      await tick();
      const replies = env.posted.filter((message) => message.kind === "res");
      assert.equal(replies.length, calls.length);
      for (const reply of replies) {
        assert.equal(reply.error?.code, "unknown_command");
        assert.equal(reply.payload, null);
      }
    } finally {
      api.destroy();
    }
  });

  it("reports a thrown host call without breaking the relay", async () => {
    const env = makeEnv();
    const host = {
      Tabs: {
        list: async () => {
          throw new Error("boom");
        },
        setTitle: async () => ({ ok: true }),
      },
    };
    const api = mountAppFrame(env.container, host);
    try {
      env.deliver({ ns: SHELL_NS, kind: "req", id: 1, module: "Tabs", method: "list", args: {} });
      await tick();
      const reply = env.posted.find((message) => message.kind === "res");
      assert.equal(reply.error?.code, "host_error");
      assert.match(reply.error?.message ?? "", /boom/);

      // The relay still serves the next call.
      env.deliver({ ns: SHELL_NS, kind: "req", id: 2, module: "Tabs", method: "setTitle", args: {} });
      await tick();
      const next = env.posted.filter((message) => message.kind === "res").at(-1);
      assert.equal(next.id, 2);
      assert.equal(next.error, null);
    } finally {
      api.destroy();
    }
  });

  it("ignores messages outside the shell namespace", async () => {
    const env = makeEnv();
    const api = mountAppFrame(env.container, fakeHost());
    try {
      env.deliver({ ns: "other", kind: "req", id: 1, module: "Tabs", method: "list" });
      env.deliver("not an object");
      env.deliver(null);
      await tick();
      assert.equal(env.posted.length, 0);
    } finally {
      api.destroy();
    }
  });

  it("tears down its listeners and the host subscription", async () => {
    const env = makeEnv();
    const host = fakeHost();
    const api = mountAppFrame(env.container, host);
    const listenersWhileMounted = env.listeners.get("message")?.size ?? 0;
    assert.equal(listenersWhileMounted, 3, "readiness + theme + relay");
    assert.equal(env.container.children.length, 1, "the frame is appended");

    api.destroy();
    assert.equal(env.listeners.get("message")?.size ?? 0, 0);
    assert.equal(host.removed, 1, "the event subscription is released");

    // A late call after teardown is dropped, not answered into a dead frame.
    env.deliver({ ns: SHELL_NS, kind: "req", id: 9, module: "Tabs", method: "list" });
    await tick();
    assert.equal(env.posted.length, 0);
  });
});
