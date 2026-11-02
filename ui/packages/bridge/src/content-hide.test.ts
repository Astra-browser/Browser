/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Contract tests for the ContentHide bridge surface (P4-T11): route table
// shape, event channels, invoke helper arg mapping, and the MOCK rule
// round-trip. Run with `bun test ./src` from `ui/packages/bridge`.

import { describe, expect, test } from "bun:test";
import {
  CONTENT_HIDE_EVENTS,
  CONTENT_HIDE_ROUTES,
  contentHideCommands,
  contentHideEvents,
  invokeContentHide,
  registerContentHideMock,
} from "./content-hide.js";

describe("content-hide routes", () => {
  test("covers all eight ContentHide methods", () => {
    expect(contentHideCommands()).toHaveLength(8);
    for (const method of [
      "hideForPage",
      "startPicking",
      "cancelPicking",
      "confirmPick",
      "addRule",
      "removeRule",
      "listRules",
      "clearSite",
    ] as const) {
      expect(CONTENT_HIDE_ROUTES[method]).toBeString();
    }
  });

  test("declares the four picking/rule events", () => {
    expect(contentHideEvents()).toHaveLength(4);
    expect(Object.values(CONTENT_HIDE_EVENTS)).toContain("content-hide.picking-started");
    expect(Object.values(CONTENT_HIDE_EVENTS)).toContain("content-hide.picking-cancelled");
    expect(Object.values(CONTENT_HIDE_EVENTS)).toContain("content-hide.rule-added");
    expect(Object.values(CONTENT_HIDE_EVENTS)).toContain("content-hide.rule-removed");
  });

  test("invoke helper maps method -> command and forwards args", async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args });
      return { ok: true };
    };
    await invokeContentHide(invoke, "addRule", { host: "a.invalid", selector: ".x" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe(CONTENT_HIDE_ROUTES.addRule);
    expect(calls[0]!.args).toEqual({ host: "a.invalid", selector: ".x" });
  });
});

describe("content-hide mock", () => {
  test("rule add/list/remove round-trips per site", async () => {
    const table = new Map<
      string,
      (args: Record<string, unknown>) => unknown | Promise<unknown>
    >();
    registerContentHideMock((cmd, fn) => {
      table.set(cmd, fn);
    });
    expect(table.size).toBe(8);
    const call = (method: string, args: Record<string, unknown>) =>
      table.get(CONTENT_HIDE_ROUTES[method as keyof typeof CONTENT_HIDE_ROUTES])!(args) as {
        selectors: string[];
      };
    const added = call("addRule", { request_id: "r-1", host: "Shop.Fixture.Invalid.", selector: ".promo" });
    expect(added.selectors).toContain(".promo");
    const listed = call("listRules", { request_id: "r-2", host: "shop.fixture.invalid" });
    expect(listed.selectors).toContain(".promo");
    const removed = call("removeRule", {
      request_id: "r-3",
      host: "shop.fixture.invalid",
      selector: ".promo",
    });
    expect(removed.selectors).not.toContain(".promo");
  });

  test("hide_for_page echoes request_id and rejects bad urls", async () => {
    const table = new Map<
      string,
      (args: Record<string, unknown>) => unknown | Promise<unknown>
    >();
    registerContentHideMock((cmd, fn) => {
      table.set(cmd, fn);
    });
    const hide = table.get(CONTENT_HIDE_ROUTES.hideForPage)!;
    const good = (await hide({ request_id: "h-1", url: "https://a.invalid/x" })) as {
      request_id: string;
      host_api_version: number;
    };
    expect(good.request_id).toBe("h-1");
    expect(good.host_api_version).toBe(1);
    const bad = (await hide({ request_id: "h-2", url: "not a url" })) as {
      error: { code: string };
    };
    expect(bad.error.code).toBe("invalid_url");
  });
});
