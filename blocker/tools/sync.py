#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Port Brave's adblock data into Astra-owned, rebranded data files.

This script is the bridge between the four upstream repositories the owner
supplied (cloned under ``folder_context/``) and the files Astra actually
ships. It is deterministic: running it twice with the same clones produces
byte-identical output.

Inputs (reference clones, git-ignored):
  folder_context/adblock-rust          engine source (version recorded only)
  folder_context/adblock-resources     dist/resources.json + list_catalog.json
  folder_context/adblock-lists         Brave-owned filter lists (never shipped)
  folder_context/adblock-lists-mirror  mirror metadata (version recorded only)

Outputs (committed, source of truth for the browser):
  blocker/lists/catalog.json    Astra list catalog (upstream community URLs only)
  blocker/resources/resources.json  filtered scriptlet/redirect resources
  blocker/seed/*.txt.gz         bundled offline seed (EasyList/EasyPrivacy)

Rules:
  * Brave-owned list sources are dropped. They carry Brave service filters,
    Brave update hosts and Brave analytics allowances that must not answer
    inside Astra.
  * No source URL, list title or resource name may contain Brave branding,
    rewards, telemetry or analytics endpoints. Provenance fields may name the
    upstream project (attribution is required by the licences).
  * Every shipped list keeps its upstream URL, title and licence attribution.

Usage:
  python3 blocker/tools/sync.py [--root DIR] [--check]
  --check  verify the committed output matches a fresh generation (no writes)
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

SCHEMA_VERSION = 1

# Groups used by the Settings UI. `default_enabled` is applied per entry.
GROUP_TITLES = {
    "ads": "Ads and annoyances",
    "privacy": "Trackers and privacy",
    "malware": "Malware and scams",
    "annoyances": "Optional annoyances",
    "regional": "Regional lists",
}

# Sources Brave ships that are not community lists. Dropped wholesale.
BRAVE_SOURCE_RE = re.compile(
    r"(?i)(?:^|/)(?:raw\.githubusercontent\.com/brave|github\.com/brave|"
    r"brave\.com|bravesoftware\.com|brave\.software|brave-experiments)/"
)

# Resource families that are Brave product features, not generic adblock data.
DROP_RESOURCE_PREFIXES = ("brave-", "async-sugarcoat-")
KEEP_RESOURCES = {
    "de-amp.js",
    "touch-fix.js",
    "trusted_types.js",
    "vaft-ublock-origin.js",
    "video-swap-new-ublock-origin.js",
}

# Strings that must never appear in shipped list metadata or resource names.
BANNED = re.compile(r"(?i)\b(?:brave|rewards|telemetry|p3a|analytics)\b")

# Catalog entry -> Astra group. Brave's own entries are dropped before this is
# consulted; the remaining entries are community subscriptions.
GROUP_BY_TITLE = [
    (re.compile(r"(?i)privacy"), "privacy"),
    (re.compile(r"(?i)(malware|phishing|badware|urlhaus|scam)"), "malware"),
    (re.compile(r"(?i)(cookie|annoyance|social|newsletter|mobile|distraction|"
                r"youtube|paywall|porn|chat|ai suggestions|tracking url)"), "annoyances"),
    (re.compile(r"(?i)(website ad blocker|website annoyances blocker|"
                r"adguard russian|ru adlist)"), "regional"),
]

DEFAULT_GROUPS = {"ads", "privacy", "malware"}
DEFAULT_TITLES = {
    "EasyList",
    "EasyPrivacy",
    "uBlock Origin Filters",
    "uBlock Origin filters - General",
    "uBlock Origin filters - Badware risks",
    "uBlock Origin filters – Resource abuse",
    "uBlock Origin filters - Unbreak",
    "uBlock Origin filters - Quick Fixes",
    "URLhaus Malicious URL Blocklist",
}

# Licences of the community sources we ship. The list text itself is data;
# the licence travels with the catalog entry.
LICENCES = {
    "easylist": {
        "license_expression": "CC-BY-SA-3.0",
        "attribution": "The EasyList authors (https://easylist.to/)",
        "url": "https://easylist.to/pages/licence.html",
    },
    "easyprivacy": {
        "license_expression": "CC-BY-SA-3.0",
        "attribution": "The EasyList authors (https://easylist.to/)",
        "url": "https://easylist.to/pages/licence.html",
    },
    "ublock": {
        "license_expression": "GPL-3.0-or-later",
        "attribution": "uBlock Origin contributors (https://github.com/uBlockOrigin/uAssets)",
        "url": "https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE",
    },
    "fanboy": {
        "license_expression": "CC-BY-SA-3.0",
        "attribution": "Fanboy, Rick Petnel and contributors",
        "url": "https://easylist.to/pages/licence.html",
    },
    "urlhaus": {
        "license_expression": "CC-BY-SA-4.0",
        "attribution": "abuse.ch URLhaus project",
        "url": "https://urlhaus.abuse.ch/",
    },
    "adguard": {
        "license_expression": "GPL-3.0-or-later",
        "attribution": "AdGuard Software Ltd.",
        "url": "https://github.com/AdguardTeam/FiltersRegistry",
    },
    "other": {
        "license_expression": "LicenseRef-unknown",
        "attribution": "Upstream filter-list author (see source_url)",
        "url": "https://easylist.to/pages/licence.html",
    },
}


def slug(text: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return value or "list"


def licence_for(url: str) -> dict:
    host = url.lower()
    if "easylist.to" in host or "easylist-downloads.adblockplus.org" in host:
        return LICENCES["easylist"]
    if "ublockorigin" in host:
        return LICENCES["ublock"]
    if "fanboy" in host:
        return LICENCES["fanboy"]
    if "urlhaus" in host or "malware-filter" in host:
        return LICENCES["urlhaus"]
    if "adguard" in host or "adtidy" in host:
        return LICENCES["adguard"]
    return LICENCES["other"]


def group_for(title: str, fallback: str) -> str:
    for pattern, group in GROUP_BY_TITLE:
        if pattern.search(title):
            return group
    return fallback


def git_head(repo: str) -> dict:
    try:
        out = subprocess.run(
            ["git", "-C", repo, "log", "-1", "--format=%H%x00%cs"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        sha, date = out.split("\0")
        return {"commit": sha, "date": date}
    except (OSError, subprocess.CalledProcessError, ValueError):
        return {}


def crate_version(repo: str) -> str | None:
    path = os.path.join(repo, "Cargo.toml")
    try:
        with open(path, encoding="utf-8") as handle:
            match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', handle.read())
        return match.group(1) if match else None
    except OSError:
        return None


def sanitize_title(title: str) -> str:
    value = re.sub(r"(?i)\bbrave(?:'s)?\b", "", title)
    value = re.sub(r"\s+", " ", value).strip(" -–—:")
    return value or title


def build_catalog(root: str) -> dict:
    resources_dir = os.path.join(root, "folder_context", "adblock-resources")
    catalog_path = os.path.join(resources_dir, "filter_lists", "list_catalog.json")
    with open(catalog_path, encoding="utf-8") as handle:
        brave = json.load(handle)

    lists: list[dict] = []
    seen_urls: set[str] = set()
    warned: list[str] = []

    for entry in brave:
        entry_title = sanitize_title(entry.get("title", ""))
        if BRAVE_SOURCE_RE.search(entry.get("uuid", "")):
            continue
        # Whole Brave product components never contribute a source.
        if re.search(r"(?i)\b(ios|android|first party|firstparty|sugarcoat)\b", entry_title):
            continue
        entry_default = entry.get("default_enabled") is True
        for source in entry.get("sources", []):
            url = source.get("url", "").strip()
            if not url or BRAVE_SOURCE_RE.search(url):
                continue
            if url in seen_urls:
                continue
            seen_urls.add(url)
            title = sanitize_title(source.get("title", "")) or entry_title
            if not title:
                title = slug(url)
            base_group = "annoyances"
            if entry_default and entry_title.lower().startswith(("ads", "default adblock")):
                base_group = "ads"
            elif entry_default and "privacy" in entry_title.lower():
                base_group = "privacy"
            group = group_for(title, base_group)
            default = entry_default and group in DEFAULT_GROUPS and (
                title in DEFAULT_TITLES or group in {"privacy", "malware"}
            )
            item = {
                "id": slug(title),
                "title": title,
                "group": group,
                "default_enabled": bool(default),
                "source_url": url,
                "support_url": source.get("support_url") or "",
                "format": source.get("format") or "Standard",
                "license": licence_for(url),
                "bundled": False,
            }
            if item["id"] in {row["id"] for row in lists}:
                item["id"] = f"{item['id']}-{len(lists)}"
            if BANNED.search(item["title"]) or BANNED.search(item["source_url"]):
                warned.append(item["id"])
                continue
            lists.append(item)

    # Bundled seed: the two offline lists the crate already carried. They
    # make first boot work with no network; the full set arrives on update.
    for list_id, title, url in (
        ("easylist", "EasyList", "https://easylist.to/easylist/easylist.txt"),
        ("easyprivacy", "EasyPrivacy", "https://easylist.to/easylist/easyprivacy.txt"),
    ):
        existing = next((row for row in lists if row["source_url"] == url), None)
        if existing is None:
            existing = {
                "id": list_id,
                "title": title,
                "group": "ads" if list_id == "easylist" else "privacy",
                "default_enabled": True,
                "source_url": url,
                "support_url": "https://easylist.to/",
                "format": "Standard",
                "license": LICENCES[list_id],
                "bundled": True,
            }
            lists.append(existing)
        existing["bundled"] = True

    lists.sort(key=lambda row: (row["group"], row["title"].lower()))

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_by": "blocker/tools/sync.py",
        "upstream": {
            "adblock_rust": {
                "repo": "https://github.com/brave/adblock-rust",
                "version": crate_version(os.path.join(root, "folder_context", "adblock-rust")),
                **git_head(os.path.join(root, "folder_context", "adblock-rust")),
            },
            "adblock_resources": {
                "repo": "https://github.com/brave/adblock-resources",
                **git_head(resources_dir),
            },
            "adblock_lists": {
                "repo": "https://github.com/brave/adblock-lists",
                **git_head(os.path.join(root, "folder_context", "adblock-lists")),
            },
            "adblock_lists_mirror": {
                "repo": "https://github.com/brave/adblock-lists-mirror",
                **git_head(os.path.join(root, "folder_context", "adblock-lists-mirror")),
            },
        },
        "groups": GROUP_TITLES,
        "lists": lists,
        "dropped_upstream_sources": sorted(warned),
    }


def build_resources(root: str) -> list[dict]:
    path = os.path.join(root, "folder_context", "adblock-resources", "dist", "resources.json")
    with open(path, encoding="utf-8") as handle:
        brave = json.load(handle)
    out = []
    for resource in brave:
        name = resource.get("name", "")
        if name in DROP_RESOURCE_PREFIXES or name.startswith("brave-"):
            continue
        if name not in KEEP_RESOURCES:
            continue
        if BANNED.search(name):
            continue
        content = resource.get("content", "")
        # Content is base64. Decode only to check for Brave product strings;
        # the generic scriptlets have none.
        try:
            import base64

            text = base64.b64decode(content).decode("utf-8", errors="ignore")
        except Exception:
            text = ""
        if re.search(r"(?i)brave\.(?:com|software)", text):
            continue
        out.append(resource)
    out.sort(key=lambda row: row["name"])
    return out


def seed_sources(root: str) -> list[tuple[str, str]]:
    """(target, source) pairs for the bundled offline seed."""
    canonical = os.path.join(root, "blocker", "seed")
    legacy = os.path.join(root, "crates", "astra-blocker", "seed", "v1")
    pairs = []
    for name in ("easylist", "easyprivacy"):
        target = f"{name}.txt.gz"
        source = os.path.join(canonical, target)
        if not os.path.exists(source):
            source = os.path.join(legacy, target)
        if os.path.exists(source) and os.path.abspath(source) != os.path.abspath(
            os.path.join(canonical, target)
        ):
            pairs.append((target, source))
    return pairs


def write_json(path: str, value: object) -> None:
    data = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(data)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = args.root

    required = [
        "folder_context/adblock-rust",
        "folder_context/adblock-resources",
        "folder_context/adblock-lists",
        "folder_context/adblock-lists-mirror",
    ]
    missing = [path for path in required if not os.path.isdir(os.path.join(root, path))]
    if missing:
        print("sync: missing reference clones:\n  " + "\n  ".join(missing), file=sys.stderr)
        print("sync: clone the four Brave repositories under folder_context/ first", file=sys.stderr)
        return 2

    catalog = build_catalog(root)
    resources = build_resources(root)

    if args.check:
        stale = []
        for rel, value in (
            ("blocker/lists/catalog.json", catalog),
            ("blocker/resources/resources.json", resources),
        ):
            path = os.path.join(root, rel)
            try:
                with open(path, encoding="utf-8") as handle:
                    current = json.load(handle)
            except OSError:
                stale.append(rel)
                continue
            if current != value:
                stale.append(rel)
        if stale:
            print("sync: STALE: " + ", ".join(stale), file=sys.stderr)
            print("sync: run python3 blocker/tools/sync.py", file=sys.stderr)
            return 1
        print("sync: clean")
        return 0

    os.makedirs(os.path.join(root, "blocker", "lists"), exist_ok=True)
    os.makedirs(os.path.join(root, "blocker", "resources"), exist_ok=True)
    os.makedirs(os.path.join(root, "blocker", "seed"), exist_ok=True)
    write_json(os.path.join(root, "blocker", "lists", "catalog.json"), catalog)
    write_json(os.path.join(root, "blocker", "resources", "resources.json"), resources)

    for target, source in seed_sources(root):
        destination = os.path.join(root, "blocker", "seed", target)
        shutil.copyfile(source, destination)
        with open(destination, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        print(f"sync: seed {target} sha256={digest}")

    print(f"sync: wrote {len(catalog['lists'])} lists, {len(resources)} resources")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
