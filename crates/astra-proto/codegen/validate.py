# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# P2-T02 acceptance: every fixture validates against its schema; the two
# `negative/` fixtures MUST fail. Counts pin the surface (270 + 35) so a
# dropped command or event breaks the gate instead of slipping through.
# Stdlib only.

import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CRATE = os.path.join(ROOT, "crates", "astra-proto")


def fail(msg):
    print(f"validate: FAIL: {msg}")
    return False


def check_type(v, sch, path, errors):
    """JSON-Schema subset: type/properties/required/additionalProperties/
    enum/const/minimum/items. `x-astra-*` annotations are ignored."""
    if not isinstance(sch, dict) or not sch:
        return True
    t = sch.get("type")
    ok = True
    if t == "object":
        if not isinstance(v, dict):
            errors.append(f"{path}: want object")
            return False
        for k in sch.get("required", []):
            if k not in v:
                errors.append(f"{path}: missing required `{k}`")
                ok = False
        props = sch.get("properties", {})
        for k, val in v.items():
            if k in props:
                ok = check_type(val, props[k], f"{path}.{k}", errors) and ok
            elif sch.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property `{k}`")
                ok = False
    elif t == "array":
        if not isinstance(v, list):
            errors.append(f"{path}: want array")
            return False
        for i, item in enumerate(v):
            ok = check_type(item, sch.get("items", {}), f"{path}[{i}]", errors) and ok
    elif t == "string":
        if not isinstance(v, str):
            errors.append(f"{path}: want string")
            ok = False
    elif t == "boolean":
        if not isinstance(v, bool):
            errors.append(f"{path}: want boolean")
            ok = False
    elif t in ("number", "integer"):
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            errors.append(f"{path}: want {t}")
            ok = False
        elif t == "integer" and isinstance(v, float) and not v.is_integer():
            errors.append(f"{path}: want integer")
            ok = False
    if "enum" in sch and v not in sch["enum"]:
        errors.append(f"{path}: {v!r} not in enum")
        ok = False
    if "const" in sch and v != sch["const"]:
        errors.append(f"{path}: want const {sch['const']!r}")
        ok = False
    if "minimum" in sch and isinstance(v, (int, float)) and v < sch["minimum"]:
        errors.append(f"{path}: below minimum {sch['minimum']}")
        ok = False
    return ok


def main():
    ok = True
    envelope = json.load(open(os.path.join(ROOT, "schemas/envelope.json")))
    commands = json.load(open(os.path.join(ROOT, "schemas/commands.json")))
    events = json.load(open(os.path.join(ROOT, "schemas/events.json")))

    if commands.get("count") != 270 or len(commands["commands"]) != 270:
        ok = fail("commands registry is not 270") and ok
    if events.get("count") != 35 or len(events["events"]) != 35:
        ok = fail("events registry is not 35") and ok
    if commands.get("version") != 1 or events.get("version") != 1:
        ok = fail("registry version != 1") and ok
    # Old channels must be gone; renames resolve into the live set.
    for old, new in events.get("renames", {}).items():
        if old in events["events"] or new not in events["events"]:
            ok = fail(f"bad rename {old} -> {new}") and ok

    fx = os.path.join(CRATE, "fixtures")
    positives = sorted(
        f for f in os.listdir(fx) if f.startswith("envelope-") and f.endswith(".json"))
    errors = []
    for f in positives:
        doc = json.load(open(os.path.join(fx, f)))
        if not check_type(doc, envelope, f, errors):
            ok = False
        name = doc.get("name")
        if doc.get("kind") == "req" and name in commands["commands"]:
            payload = commands["commands"][name]["payload"]
            if not check_type(doc.get("payload", {}), payload, f"{f}.payload", errors):
                ok = False
    for f in positives:
        if f == "envelope-unknown-fields.json":
            continue  # allowed extras are the point of that fixture

    negatives = {
        "negative/unknown-version.json": True,
        "negative/missing-name.json": True,
    }
    for rel in negatives:
        doc = json.load(open(os.path.join(fx, rel)))
        errs = []
        valid = check_type(doc, envelope, rel, errs)
        if valid:
            ok = fail(f"{rel} validated but must fail") and ok

    # Every generated per-module command fixture validates against its schema.
    cmddir = os.path.join(fx, "commands")
    checked = 0
    for f in sorted(os.listdir(cmddir)):
        doc = json.load(open(os.path.join(cmddir, f)))
        for case in doc["cases"]:
            name = case["command"]
            if name not in commands["commands"]:
                ok = fail(f"{f}: unknown command {name}") and ok
                continue
            payload = commands["commands"][name]["payload"]
            if not check_type(case["payload"], payload, f"{f}:{name}", errors):
                ok = False
            checked += 1
    if checked != 270:
        ok = fail(f"command fixtures cover {checked}, want 270") and ok

    for e in errors:
        print(f"validate: FAIL: {e}")
        ok = False
    print(f"validate: {'PASS' if ok else 'FAIL'} "
          f"(commands=270 events=35 fixtures={checked + len(positives)})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
