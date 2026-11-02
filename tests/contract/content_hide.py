#!/usr/bin/env python3
"""P4-T03 contract test (protocol side): ContentHide schema + module shape.

No browser needed — validates that the P4-T03 artifacts exist and agree:
  - schemas/content-hide.json parses and declares every ContentHide method,
    the HideResult/HideError shapes, and the four content-hide.* events.
  - overlay/astra/host/ContentHide.sys.mjs exports the matching symbols and
    references (never reschemas) the blocker_overrides persistence story.
  - docs/astra/HIDING.md exists and documents the blocker_overrides mapping.

Usage: python3 tests/contract/content_hide.py
Exit 0 PASS, 1 FAIL. Stdlib only.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCHEMA = os.path.join(ROOT, "schemas", "content-hide.json")
MODULE = os.path.join(ROOT, "overlay", "astra", "host", "ContentHide.sys.mjs")
CONTENT = os.path.join(ROOT, "overlay", "astra", "host", "Content.sys.mjs")
FACADE = os.path.join(ROOT, "overlay", "astra", "host", "HostAPI.sys.mjs")
JAR = os.path.join(ROOT, "overlay", "astra", "jar.mn")
BRIDGE = os.path.join(ROOT, "ui", "packages", "bridge", "src", "content-hide.ts")
DOC = os.path.join(ROOT, "docs", "astra", "HIDING.md")

failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        failures.append(name)


try:
    with open(SCHEMA, encoding="utf-8") as f:
        schema = json.load(f)
    check("schema parses as JSON", True)
except (OSError, json.JSONDecodeError) as exc:
    check(f"schema parses as JSON ({exc})", False)
    schema = {}

props = schema.get("properties", {})
for method in ("hideForPage", "startPicking", "cancelPicking", "confirmPick",
               "addRule", "removeRule", "listRules", "clearSite"):
    check(f"schema declares {method}", method in props)
for shape in ("HideRule", "HideResult", "HideError"):
    check(f"schema declares {shape}", shape in props)

events = props.get("events", {}).get("properties", {})
for event in ("picking-started", "picking-cancelled", "rule-added", "rule-removed"):
    check(f"schema declares event {event}", event in events)

codes = props.get("HideError", {}).get("properties", {}).get("code", {}).get("enum", [])
for code in ("invalid_url", "invalid_host", "invalid_selector", "not_picking"):
    check(f"schema declares error code {code}", code in codes)

try:
    with open(MODULE, encoding="utf-8") as f:
        source = f.read()
    check("module exists", True)
except OSError as exc:
    check(f"module exists ({exc})", False)
    source = ""

for symbol in ("hideForPage", "applySelectors", "collectObserved",
               "selectorForElement", "buildStylesheet", "startPicking",
               "cancelPicking", "confirmPick", "addRule", "removeRule",
               "listRules", "clearSite", "host_api_version", "HOST_API_VERSION"):
    check(f"module defines {symbol}", re.search(r"\b%s\b" % re.escape(symbol), source) is not None)
check("module traverses shadow roots", "shadowRoot" in source)
check("module traverses iframes", "contentDocument" in source)
check("module references blocker_overrides (no reschema)", "blocker_overrides" in source)
check("module honours host_api_version 1", "HOST_API_VERSION = 1" in source)

# P4-T11 live wiring: content-script driver, provider/store adapters, actor
# registration, packaging, and bridge surface.
for symbol in ("installLiveHiding", "injectStylesheet",
               "createBlockerCosmeticProvider", "createOverrideStoreAdapter",
               "formatOverrideAction", "parseOverrideAction",
               "MutationObserver", "cosmetic_selectors", "blocker_override_set"):
    check(f"live module defines {symbol}", symbol in source)
check("live module documents the write-only store read gap",
      "write-only" in source or "no override getter" in source)

try:
    with open(CONTENT, encoding="utf-8") as f:
        content = f.read()
    check("Content.sys.mjs exists", True)
except OSError as exc:
    check(f"Content.sys.mjs exists ({exc})", False)
    content = ""
check("Content actor exposes ContentHide", "ContentHide" in content)
check("Content actor wires providers", "wireHiding" in content)
check("Content actor attaches live hiding", "attachHiding" in content)

try:
    with open(FACADE, encoding="utf-8") as f:
        facade = f.read()
    check("HostAPI.sys.mjs exists", True)
except OSError as exc:
    check(f"HostAPI.sys.mjs exists ({exc})", False)
    facade = ""
check("HostAPI facade exports ContentHide", "ContentHide" in facade)

try:
    with open(JAR, encoding="utf-8") as f:
        jar = f.read()
    check("jar.mn exists", True)
except OSError as exc:
    check(f"jar.mn exists ({exc})", False)
    jar = ""
check("jar.mn registers ContentHide.sys.mjs", "ContentHide.sys.mjs" in jar)

try:
    with open(BRIDGE, encoding="utf-8") as f:
        bridge = f.read()
    check("bridge content-hide.ts exists", True)
except OSError as exc:
    check(f"bridge content-hide.ts exists ({exc})", False)
    bridge = ""
for token in ("hide_for_page", "hide_pick_start", "hide_pick_confirm",
              "hide_rule_add", "hide_rule_list",
              "content-hide.picking-started", "content-hide.rule-added"):
    check(f"bridge declares {token}", token in bridge)

try:
    with open(DOC, encoding="utf-8") as f:
        doc = f.read()
    check("HIDING.md exists", True)
except OSError as exc:
    check(f"HIDING.md exists ({exc})", False)
    doc = ""
check("HIDING.md documents blocker_overrides mapping", "blocker_overrides" in doc)
check("HIDING.md documents click-to-hide", "click-to-hide" in doc.lower())

print(f"content_hide protocol: {'FAIL' if failures else f'PASS'}")
sys.exit(1 if failures else 0)
