#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Fetch the real-extension corpus from the Chrome Web Store update service.

Writes `corpus.json`, `downloads.json` and `packages/<chrome-id>.crx` under
the output directory. The store serves the same CRX3 package it serves to
Chrome; `extension_corpus_probe.py` verifies each signature before install.

  python3 tools/perf/stress/extension_corpus_fetch.py out/extension-corpus

Network-dependent and opt-in; no package is installed here.
"""
import concurrent.futures
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "out", "extension-corpus")
PACKAGES = os.path.join(OUT, "packages")
LIMIT = 100 * 1024 * 1024

# A broad set: the 45-entry gallery plus older MV2-era tools, privacy,
# devtools, shopping, new-tab and screenshot extensions from several years.
EXTRA = [
    ("uBlock Origin (classic)", "cjpalhdlnbpafiamejdnhcphjbkeiagm", "content blocker", "older"),
    ("uBlock Origin Lite", "ddkjiahejlhfcafbddmgiahcphecmpfh", "content blocker", "newer"),
    ("AdBlock Plus", "cfhdojbkjhnklbpkdaibdccddilifddb", "content blocker", "older"),
    ("AdGuard AdBlocker", "bgnkhhnnamicmpeenaelnjfhikgbkllg", "content blocker", "newer"),
    ("Privacy Badger", "pkehgijcmpdhfbdbbnkijodmdjhbjlgp", "privacy", "older"),
    ("ClearURLs", "lckanjgmijmafbedllaakclkaicjfmnk", "privacy", "older"),
    ("Cookie AutoDelete", "fhcgjolkccmbidfldomjliifgaodjagh", "privacy", "older"),
    ("Decentraleyes", "ldpochfccmkkmhdbclfhpagapcfdljkj", "privacy", "older"),
    ("Web Developer", "bfbameneiokkgbdmiekhjnmfkcnldhhm", "developers", "older"),
    ("JSON Viewer", "gbmdgpbipfallnflgajpaliibnhdgobh", "developers", "older"),
    ("WhatFont", "jabopobgcpjmedljpbcaablpmlmfcogm", "developers", "older"),
    ("Redux DevTools", "lmhkpmbekcpmknklioeibfkpmmfibljd", "developers", "newer"),
    ("Accessibility Insights for Web", "piffkaokaloakocefgllihmabfiinmh", "developers", "newer"),
    ("Lighthouse", "blipmdconlkpinefehnmjammfjpmpbjk", "developers", "newer"),
    ("axe DevTools", "lhdoppojpmngadmnindnejefpokejbdd", "developers", "newer"),
    ("Momentum", "laookkfknpbbblfpciffpaejjkokdgca", "new tab", "newer"),
    ("Awesome Screenshot", "alelhddbbhepgpmgidjdcjakblofbmce", "productivity", "older"),
    ("Honey", "bmnlcjabgnpnenekpadlanbbkooimhnj", "shopping", "newer"),
    ("Capital One Shopping", "nenlahapcbofgnanklpelkaejcehkggg", "shopping", "newer"),
    ("Rakuten", "chhjbpecpncaggjpdakmflnfcopglcmi", "shopping", "newer"),
    ("Pocket", "niloccemoadcdkdjlinkgdfekeahmflj", "saving", "older"),
    ("Toby", "hddnkoipeenegfoeaoibdmnaalmgkpip", "tabs", "newer"),
    ("Checker Plus for Gmail", "oeopbcgkkoapgobdbdjighnlmhihihmm", "productivity", "older"),
    ("News Feed Eradicator", "khncfooichmfjbepaaaebmommgaepoid", "productivity", "older"),
]


def fetch(entry, base):
    path = os.path.join(PACKAGES, f"{entry['id']}.crx")
    if os.path.isfile(path) and os.path.getsize(path) > 1024:
        return entry["id"], "cached", os.path.getsize(path)
    try:
        request = urllib.request.Request(
            base.format(entry["id"]), headers={"User-Agent": "Mozilla/5.0 Astra extension corpus"}
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read(LIMIT + 1)
        if len(data) > LIMIT:
            return entry["id"], "too_large", len(data)
        if not data.startswith(b"Cr24"):
            return entry["id"], "not_crx", len(data)
        with open(path, "wb") as fh:
            fh.write(data)
        return entry["id"], "ok", len(data)
    except Exception as error:
        return entry["id"], f"error:{getattr(error, 'code', type(error).__name__)}", 0


def main():
    os.makedirs(PACKAGES, exist_ok=True)
    gallery = json.load(open(os.path.join(ROOT, "crates", "astra-extensions", "gallery.json")))["entries"]
    corpus = [
        {"name": entry["name"], "id": entry["chrome_store_id"], "category": entry["category"], "era": "gallery"}
        for entry in gallery
    ]
    seen = {entry["id"] for entry in corpus}
    for name, chrome_id, category, era in EXTRA:
        if chrome_id not in seen:
            corpus.append({"name": name, "id": chrome_id, "category": category, "era": era})
            seen.add(chrome_id)
    with open(os.path.join(OUT, "corpus.json"), "w") as fh:
        json.dump(corpus, fh, indent=1)
    base = (
        "https://clients2.google.com/service/update2/crx?response=redirect"
        "&prodversion=131.0&acceptformat=crx2,crx3&x=id%3D{}%26uc"
    )
    downloads = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        for chrome_id, status, size in executor.map(lambda entry: fetch(entry, base), corpus):
            downloads[chrome_id] = {"status": status, "size": size}
            print(f"{chrome_id} {status} {size}", file=sys.stderr, flush=True)
    with open(os.path.join(OUT, "downloads.json"), "w") as fh:
        json.dump(downloads, fh, indent=1)
    usable = sum(1 for value in downloads.values() if value["status"] in ("ok", "cached"))
    print(json.dumps({"entries": len(corpus), "usable": usable}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
