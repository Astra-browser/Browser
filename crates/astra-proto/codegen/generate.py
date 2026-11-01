#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0.
"""astra-proto codegen (P2-T02): single source of truth is
docs/astra/ipc-surface.md (267 commands + 35 events).

Reads the markdown tables and emits, deterministically:
  schemas/commands.json, schemas/events.json,
  crates/astra-proto/src/generated.rs,
  crates/astra-proto/gen/astra-proto.ts,
  crates/astra-proto/fixtures/commands/*.json (minimal valid payloads).

schemas/envelope.json is hand-written (stable Appendix C contract) and is
NOT overwritten by this script.

Stdlib only -- no extra tooling dependencies by design (see README.md).
Usage: generate.py [--root DIR] [--out DIR]
  --root DIR : repo root (default: script's grand-grand-parent... resolved)
  --out DIR  : write outputs under DIR mirroring repo layout (drift check).
"""
import json
import os
import re
import sys

PROTOCOL_VERSION = 1
EXPECTED_COMMANDS = 267
EXPECTED_EVENTS = 35

# Channel rename rule for the 8 REN events (porting notes, ipc-surface.md):
# `prev:` prefix -> `astra:` prefix; TS `prevX` -> `astraX`.
RENAME_FROM = "prev:"
RENAME_TO = "astra:"

HANDLE_RE = re.compile(
    r"^(caller|app|shell|gate|overlay|updates|extensions)\s*:",
)


def split_top(s, sep=","):
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "<(":
            depth += 1
        elif ch in ">)":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return [p.strip().rstrip(",").strip() for p in parts if p.strip().rstrip(",").strip()]


def strip_option(ty):
    m = re.fullmatch(r"Option\s*<\s*(.+)\s*>", ty, re.S)
    if m:
        return m.group(1).strip(), True
    return ty, False


def strip_result(ty):
    m = re.fullmatch(r"Result\s*<\s*(.+?)\s*,\s*(.+?)\s*>", ty, re.S)
    if m:
        return m.group(1).strip()
    return ty


SCALARS = {
    "String": ({"type": "string"}, "string"),
    "bool": ({"type": "boolean"}, "boolean"),
    "f64": ({"type": "number"}, "number"),
    "f32": ({"type": "number"}, "number"),
    "u8": ({"type": "integer"}, "number"),
    "u16": ({"type": "integer"}, "number"),
    "u32": ({"type": "integer"}, "number"),
    "u64": ({"type": "integer"}, "number"),
    "usize": ({"type": "integer"}, "number"),
    "i8": ({"type": "integer"}, "number"),
    "i16": ({"type": "integer"}, "number"),
    "i32": ({"type": "integer"}, "number"),
    "i64": ({"type": "integer"}, "number"),
}


def map_type(ty):
    """Map a Rust param/return type to (json_schema, ts_type).

    Unknown named types (Tauri Specta structs, not available to this
    prototype) map to unconstrained schemas + `unknown` in TS, with the
    original spelling preserved in `x-astra-rust-type`. This is an explicit
    v1 fidelity limit, documented in README.md.
    """
    ty = strip_result(ty.strip())
    ty, optional = strip_option(ty)
    schema, ts = None, None
    if ty in SCALARS:
        schema, ts = {k: v for k, v in SCALARS[ty][0].items()}, SCALARS[ty][1]
    elif ty.startswith("Vec<") and ty.endswith(">"):
        inner = ty[4:-1].strip()
        isch, its, _ = map_type(inner)
        schema = {"type": "array", "items": isch}
        ts = f"Array<{its}>"
    else:
        schema = {}
        if re.fullmatch(r"[A-Za-z_][\w:]*", ty):
            schema["x-astra-rust-type"] = ty
        ts = "unknown"
    if optional:
        ts = f"({ts} | null)"
    return schema, ts, optional


def parse_params(cell):
    cell = cell.strip().strip("`").strip()
    if not cell:
        return []
    if cell.startswith("async "):
        cell = cell[len("async "):]
    out = []
    for part in split_top(cell):
        part = part.strip()
        if not part or HANDLE_RE.match(part):
            continue
        m = re.fullmatch(r"([A-Za-z_][\w]*)\s*:\s*(.+)", part, re.S)
        if not m:
            continue
        out.append((m.group(1), m.group(2).strip()))
    return out


def parse_surface(root):
    md = open(os.path.join(root, "docs/astra/ipc-surface.md")).read()
    rows = [l for l in md.splitlines() if l.startswith("| `")]
    commands, events = [], []
    for row in rows:
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if len(cells) == 5:  # command row
            wire = cells[0].strip("` ")
            ts = cells[1].strip("` ")
            rust = cells[2].strip("` ")
            params = parse_params(cells[3])
            returns = cells[4].strip("` ").strip()
            commands.append(
                {"wire": wire, "ts": ts, "rust": rust,
                 "params": params, "returns": returns})
        elif len(cells) == 4:  # event row
            channel = cells[0].strip("` ")
            tsev = cells[1].strip("` ")
            payload = cells[2].strip("` ").strip()
            ren = cells[3].strip()
            renamed_from = None
            if channel.startswith(RENAME_FROM):
                renamed_from = channel
                channel = RENAME_TO + channel[len(RENAME_FROM):]
                if tsev.startswith("prev"):
                    tsev = "astra" + tsev[len("prev"):]
            events.append({"channel": channel, "ts": tsev,
                           "payload": payload, "renamed_from": renamed_from,
                           "ren": ren})
    assert len(commands) == EXPECTED_COMMANDS, f"commands: {len(commands)}"
    assert len(events) == EXPECTED_EVENTS, f"events: {len(events)}"
    return commands, events


def command_schema(cmd):
    props, required = {}, []
    ts_fields = []
    for name, ty in cmd["params"]:
        sch, ts, optional = map_type(ty)
        props[name] = sch
        if not optional:
            required.append(name)
        ts_fields.append((name, ts, optional, ty))
    payload = {"type": "object", "properties": props,
               "additionalProperties": False}
    if required:
        payload["required"] = required
    retsch, retts, _ = map_type(cmd["returns"]) if cmd["returns"] else ({}, "void", False)
    if not cmd["returns"]:
        retts = "void"
    return payload, retsch, retts, ts_fields


def pascal(s):
    return "".join(w[:1].upper() + w[1:] for w in re.split(r"[_\-\s]+", s) if w)


def ts_safe(name):
    return name  # wire names are snake_case identifiers already


def build_commands(commands):
    out = {}
    for cmd in commands:
        payload, retsch, retts, ts_fields = command_schema(cmd)
        out[cmd["wire"]] = {
            "ts": cmd["ts"],
            "rust": cmd["rust"],
            "payload": payload,
            "returns": {"schema": retsch, "ts": retts,
                        "rust": cmd["returns"]},
        }
    return out


def build_events(events):
    out, renames = {}, {}
    for ev in events:
        out[ev["channel"]] = {
            "ts": ev["ts"],
            "payload": ({"x-astra-rust-type": ev["payload"]}
                        if ev["payload"] else {}),
        }
        if ev["renamed_from"]:
            out[ev["channel"]]["renamed_from"] = ev["renamed_from"]
            renames[ev["renamed_from"]] = ev["channel"]
    return out, renames


def fixture_value(sch):
    t = sch.get("type")
    if t == "string":
        return "x"
    if t == "boolean":
        return True
    if t == "number":
        return 0.0
    if t == "integer":
        return 0
    if t == "array":
        return []
    return {}


def module_of(rust):
    m = re.fullmatch(r"d:(.+)\.rs", rust)
    return m.group(1).replace("/", "_") if m else "misc"


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, sort_keys=False)
        f.write("\n")


def gen_rust(commands, events):
    def var_name(w):
        v = pascal(w)
        return v + "_" if v in ("Self", "Type", "Kind", "Error") else v

    lines = []
    lines.append("/* This Source Code Form is subject to the terms of the Mozilla Public")
    lines.append(" * License, v. 2.0. If a copy of the MPL was not distributed with this")
    lines.append(" * file, You can obtain one at http://mozilla.org/MPL/2.0/. */")
    lines.append("")
    lines.append("//! GENERATED by crates/astra-proto/codegen/generate.py -- DO NOT EDIT.")
    lines.append("//! Source of truth: docs/astra/ipc-surface.md via schemas/*.json.")
    lines.append("//! Regenerate: `FIX=1 crates/astra-proto/check-drift.sh`.")
    lines.append("")
    lines.append("/// Number of commands in the v1 surface (ipc-surface.md: 267).")
    lines.append(f"pub const COMMAND_COUNT: usize = {len(commands)};")
    lines.append("/// Number of event channels in the v1 surface (ipc-surface.md: 35).")
    lines.append(f"pub const EVENT_COUNT: usize = {len(events)};")
    lines.append("")
    lines.append("/// Every command wire name (snake_case, stable).")
    lines.append("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]")
    lines.append("pub enum CommandName {")
    for c in commands:
        lines.append(f"    {var_name(c['wire'])},")
    lines.append("}")
    lines.append("")
    lines.append("/// Every event channel name (post-rename: `astra:` replaces `prev:`).")
    lines.append("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]")
    lines.append("pub enum EventChannel {")
    for e in events:
        v = "Evt" + pascal(e["channel"].replace(":", "_").replace("-", "_"))
        lines.append(f"    {v},")
    lines.append("}")
    lines.append("")
    lines.append("/// All command wire names, in surface order.")
    lines.append("pub const COMMANDS: &[&str] = &[")
    for c in commands:
        lines.append(f'    "{c["wire"]}",')
    lines.append("];")
    lines.append("/// All event channel names, in surface order.")
    lines.append("pub const EVENTS: &[&str] = &[")
    for e in events:
        lines.append(f'    "{e["channel"]}",')
    lines.append("];")
    lines.append("")
    lines.append("impl CommandName {")
    lines.append('    /// Canonical wire name, e.g. `CommandName::TabsOpen.as_str() == "tabs_open"`.')
    lines.append("    pub fn as_str(self) -> &'static str {")
    lines.append("        match self {")
    for c in commands:
        lines.append(f'            CommandName::{var_name(c["wire"])} => "{c["wire"]}",')
    lines.append("        }")
    lines.append("    }")
    lines.append("    /// Parse a wire name; unknown names fail (fail fast, Appendix C).")
    lines.append("    pub fn from_name(s: &str) -> Option<CommandName> {")
    lines.append("        match s {")
    for c in commands:
        lines.append(f'            "{c["wire"]}" => Some(CommandName::{var_name(c["wire"])}),')
    lines.append("            _ => None,")
    lines.append("        }")
    lines.append("    }")
    lines.append("}")
    lines.append("")
    lines.append("impl EventChannel {")
    lines.append("    /// Canonical channel name.")
    lines.append("    pub fn as_str(self) -> &'static str {")
    lines.append("        match self {")
    for e in events:
        v = "Evt" + pascal(e["channel"].replace(":", "_").replace("-", "_"))
        lines.append(f'            EventChannel::{v} => "{e["channel"]}",')
    lines.append("        }")
    lines.append("    }")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def gen_ts(commands_data, events_data, renames):
    L = []
    L.append("/* This Source Code Form is subject to the terms of the Mozilla Public")
    L.append(" * License, v. 2.0. If a copy of the MPL was not distributed with this")
    L.append(" * file, You can obtain one at http://mozilla.org/MPL/2.0/. */")
    L.append("")
    L.append("// GENERATED by crates/astra-proto/codegen/generate.py -- DO NOT EDIT.")
    L.append("// Source of truth: docs/astra/ipc-surface.md via schemas/*.json.")
    L.append("")
    L.append("/** Protocol version (Appendix C envelope `v`). Mismatch fails fast. */")
    L.append(f"export const PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;")
    L.append("")
    L.append("/** All 267 command wire names. */")
    L.append("export type CommandName =")
    for i, (wire) in enumerate(commands_data.keys()):
        sep = "  " if i == 0 else "  | "
        L.append(f'{sep}"{wire}"')
    L.append(";")
    L.append("")
    L.append("export const COMMANDS: readonly CommandName[] = [")
    for wire in commands_data.keys():
        L.append(f'  "{wire}",')
    L.append("] as const;")
    L.append("")
    L.append("/** All 35 event channel names (post-rename). */")
    L.append("export type EventChannel =")
    items = list(events_data.keys())
    for i, ch in enumerate(items):
        sep = "  " if i == 0 else "  | "
        L.append(f'{sep}"{ch}"')
    L.append(";")
    L.append("")
    L.append("export const EVENTS: readonly EventChannel[] = [")
    for ch in items:
        L.append(f'  "{ch}",')
    L.append("] as const;")
    L.append("")
    L.append("/** Old (`prev:`) -> new (`astra:`) channel renames (10 channels). */")
    L.append("export const EVENT_RENAMES: Readonly<Record<string, EventChannel>> = {")
    for old, new in renames.items():
        L.append(f'  "{old}": "{new}",')
    L.append("};")
    L.append("")
    L.append("// ---- Envelope (Appendix C) ----")
    L.append("export type EnvelopeKind = \"req\" | \"res\" | \"evt\";")
    L.append("")
    L.append("export interface ProtoError { code: string; message: string; }")
    L.append("")
    L.append("export interface Envelope {")
    L.append("  v: number;")
    L.append("  id: string;")
    L.append("  kind: EnvelopeKind;")
    L.append("  name: string;")
    L.append("  seq?: number;")
    L.append("  payload: unknown;")
    L.append("  error?: ProtoError;")
    L.append("}")
    L.append("")
    L.append("/** Build a request envelope. Unknown `name`s are allowed here -- the")
    L.append(" * core rejects them fail-fast at runtime (mirrors Rust FromStr). */")
    L.append("export function makeRequest(name: CommandName, payload: unknown, id: string): Envelope {")
    L.append("  return { v: PROTOCOL_VERSION, id, kind: \"req\", name, payload: payload ?? {} };")
    L.append("}")
    L.append("")
    L.append("/** Parse + version-gate an envelope. Unknown fields are ignored;")
    L.append(" * unknown protocol versions throw (fail fast, Appendix C). */")
    L.append("export function parseEnvelope(raw: unknown): Envelope {")
    L.append("  if (typeof raw !== \"object\" || raw === null) throw new Error(\"proto: envelope must be an object\");")
    L.append("  const o = raw as Record<string, unknown>;")
    L.append("  if (o[\"v\"] !== PROTOCOL_VERSION)")
    L.append("    throw new Error(`proto: unsupported version ${String(o[\"v\"])} (want ${PROTOCOL_VERSION})`);")
    L.append("  if (typeof o[\"id\"] !== \"string\") throw new Error(\"proto: envelope.id must be a string\");")
    L.append("  if (o[\"kind\"] !== \"req\" && o[\"kind\"] !== \"res\" && o[\"kind\"] !== \"evt\")")
    L.append("    throw new Error(\"proto: envelope.kind must be req|res|evt\");")
    L.append("  if (typeof o[\"name\"] !== \"string\") throw new Error(\"proto: envelope.name must be a string\");")
    L.append("  return {")
    L.append("    v: PROTOCOL_VERSION,")
    L.append("    id: o[\"id\"] as string,")
    L.append("    kind: o[\"kind\"] as EnvelopeKind,")
    L.append("    name: o[\"name\"] as string,")
    L.append("    ...(typeof o[\"seq\"] === \"number\" ? { seq: o[\"seq\"] as number } : {}),")
    L.append("    payload: o[\"payload\"] ?? {},")
    L.append("    ...(typeof o[\"error\"] === \"object\" && o[\"error\"] !== null")
    L.append("      ? { error: o[\"error\"] as ProtoError } : {}),")
    L.append("  };")
    L.append("}")
    L.append("")
    L.append("// ---- Per-command payloads (wire field names are snake_case) ----")
    for wire, meta in commands_data.items():
        iface = pascal(wire) + "Payload"
        rust_ty = meta["rust"]
        L.append(f"/** `{wire}` ({meta['ts']}, {rust_ty}). */")
        L.append(f"export interface {iface} {{")
        props = meta["payload"].get("properties", {})
        required = set(meta["payload"].get("required", []))
        if not props:
            L.append("  [key: string]: unknown;")
        else:
            for fname, fsch in props.items():
                ts = ts_type_of(fsch)
                opt = "" if fname in required else "?"
                ann = fsch.get("x-astra-rust-type")
                cmt = f" // {ann}" if ann else ""
                L.append(f"  {ts_safe(fname)}{opt}: {ts};{cmt}")
        L.append("}")
    L.append("")
    L.append("/** Payload type by command wire name. */")
    L.append("export interface CommandPayloads {")
    for wire in commands_data.keys():
        L.append(f'  "{wire}": {pascal(wire)}Payload;')
    L.append("}")
    L.append("")
    return "\n".join(L) + "\n"


def ts_type_of(sch):
    t = sch.get("type")
    if t == "string":
        return "string"
    if t == "boolean":
        return "boolean"
    if t == "number" or t == "integer":
        return "number"
    if t == "array":
        return f"Array<{ts_type_of(sch.get('items', {}))}>"
    return "unknown"


def main():
    args = sys.argv[1:]
    root = None
    out = None
    i = 0
    while i < len(args):
        if args[i] == "--root" and i + 1 < len(args):
            root, i = args[i + 1], i + 2
        elif args[i] == "--out" and i + 1 < len(args):
            out, i = args[i + 1], i + 2
        else:
            i += 1
    if root is None:
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    if out is None:
        out = root

    commands, events = parse_surface(root)
    commands_data = build_commands(commands)
    events_data, renames = build_events(events)

    write_json(os.path.join(out, "schemas/commands.json"), {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "resource://astra/proto/commands",
        "title": "Astra protocol v1 -- command registry (P2-T02, generated)",
        "x-astra-generated": {
            "by": "crates/astra-proto/codegen/generate.py",
            "from": "docs/astra/ipc-surface.md",
            "version": PROTOCOL_VERSION,
        },
        "version": PROTOCOL_VERSION,
        "count": len(commands_data),
        "commands": commands_data,
    })
    write_json(os.path.join(out, "schemas/events.json"), {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "$id": "resource://astra/proto/events",
        "title": "Astra protocol v1 -- event channels (P2-T02, generated)",
        "x-astra-generated": {
            "by": "crates/astra-proto/codegen/generate.py",
            "from": "docs/astra/ipc-surface.md",
            "version": PROTOCOL_VERSION,
        },
        "version": PROTOCOL_VERSION,
        "count": len(events_data),
        "renames": renames,
        "events": events_data,
    })

    rs = gen_rust(commands, events)
    rsp = os.path.join(out, "crates/astra-proto/src/generated.rs")
    os.makedirs(os.path.dirname(rsp), exist_ok=True)
    with open(rsp, "w") as f:
        f.write(rs)

    ts = gen_ts(commands_data, events_data, renames)
    tsp = os.path.join(out, "crates/astra-proto/gen/astra-proto.ts")
    os.makedirs(os.path.dirname(tsp), exist_ok=True)
    with open(tsp, "w") as f:
        f.write(ts)

    # Minimal valid payload fixtures, grouped by source module.
    modules = {}
    for cmd in commands:
        payload = commands_data[cmd["wire"]]["payload"]
        props = payload.get("properties", {})
        required = set(payload.get("required", []))
        minimal = {k: fixture_value(v) for k, v in props.items() if k in required}
        modules.setdefault(module_of(cmd["rust"]), []).append(
            {"command": cmd["wire"], "payload": minimal})
    for mod, cases in modules.items():
        write_json(os.path.join(out, "crates/astra-proto/fixtures/commands",
                                f"{mod}.json"), {
            "$comment": "GENERATED minimal valid payloads (generate.py).",
            "cases": cases,
        })

    print(f"commands={len(commands_data)} events={len(events_data)} "
          f"renames={len(renames)} modules={len(modules)}")


if __name__ == "__main__":
    main()
