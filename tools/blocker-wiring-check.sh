#!/usr/bin/env bash
# tools/blocker-wiring-check.sh — D-42 blocker source-of-truth gate.
#
# Verifies, without a build:
#   1. patch headers + apply order + filename/Patch-Id agreement;
#   2. ASTRA-0004 lists every component file and its body creates the new files;
#   3. blocker/engine is byte-identical to the staged in-tree component
#      (source of truth wins over the generated patch/engine tree);
#   4. adblock pin == the vendored third_party crate version;
#   5. the XPCOM service/IDL/components.conf wiring exists and every method the
#      Host module calls is present;
#   6. shipped catalog/resources carry no Brave source, reward, telemetry,
#      analytics or P3A strings (factual `upstream` provenance may name Brave);
#   7. sync.py --check and the astra-blocker parity fixtures.
#
# Usage: tools/blocker-wiring-check.sh [ENGINE_DIR]
#   ENGINE_DIR defaults to <repo>/engine. Reads only — never writes there.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${1:-$ROOT/engine}"
P3="$ROOT/patches/ASTRA-0003-astra-blocker-gkrust.patch"
P4="$ROOT/patches/ASTRA-0004-astra-blocker-engine.patch"
P5="$ROOT/patches/ASTRA-0005-astra-blocker-hook.patch"
SRC="$ROOT/blocker/engine"
STAGED="$ENGINE_DIR/toolkit/components/astra_blocker_engine"
HOST="$ROOT/overlay/astra/host/Blocker.sys.mjs"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

[ -d "$ENGINE_DIR" ] || { echo "FAIL: ENGINE_DIR missing: $ENGINE_DIR"; exit 2; }

echo "== blocker-wiring-check (D-42) =="
echo "engine : $ENGINE_DIR"
echo "source : $SRC"

# 1. headers / order --------------------------------------------------------
IDS=""
for p in "$P3" "$P4" "$P5"; do
  [ -f "$p" ] || { bad "missing patch $p"; continue; }
  hdr="$(awk '/^---$/{exit} {print}' "$p")"
  for f in Patch-Id Title Tier Upstream-Files Intent Risk Test Verified-On Removal-Plan; do
    echo "$hdr" | grep -qE "^$f: *[^ ]" || bad "$(basename "$p"): header '$f' missing/empty"
  done
  id="$(echo "$hdr" | sed -nE 's/^Patch-Id: *//p')"
  case "$(basename "$p")" in "$id"-*|"$id".patch) ok "$(basename "$p"): filename matches $id";; *) bad "$(basename "$p"): filename/Patch-Id mismatch";; esac
  IDS="$IDS $id"
done
[ "$(echo "$IDS" | tr ' ' '\n' | grep . | tr '\n' ' ')" = "$(echo "$IDS" | tr ' ' '\n' | grep . | sort | tr '\n' ' ')" ] \
  && ok "patch series in Patch-Id order" || bad "patch series out of order:$IDS"

# 2. ASTRA-0004 covers the component ---------------------------------------
for f in Cargo.toml moz.build cbindgen.toml components.conf nsIAstraBlockerService.idl src/lib.rs AstraBlocker.h AstraBlocker.cpp AstraBlockerService.h AstraBlockerService.cpp; do
  grep -q "toolkit/components/astra_blocker_engine/$f" "$P4" \
    && ok "ASTRA-0004 Upstream-Files lists $f" || bad "ASTRA-0004 missing $f"
  awk '/^---$/{p=1} p' "$P4" | grep -q "b/toolkit/components/astra_blocker_engine/$f" \
    && ok "ASTRA-0004 body carries $f" || bad "ASTRA-0004 body missing $f"
done

# 3. source of truth == staged tree ----------------------------------------
if [ -d "$STAGED" ]; then
  if diff -qr "$SRC" "$STAGED" >/tmp/astra-blocker-diff.$$ 2>&1; then
    ok "blocker/engine == engine/toolkit/components/astra_blocker_engine"
  else
    bad "blocker/engine differs from the staged component (run `forge overlay`):"
    sed 's/^/      /' /tmp/astra-blocker-diff.$$ | head -20
  fi
  rm -f /tmp/astra-blocker-diff.$$
else
  bad "staged component missing: $STAGED (run `forge overlay`)"
fi

# 3b. patch body == source of truth ---------------------------------------
python3 - "$ROOT" "$P4" <<'EOF' || FAIL=$((FAIL+1))
import re, sys
from pathlib import Path
root, patch = Path(sys.argv[1]), Path(sys.argv[2])
text = patch.read_text()
body = text.split("\n---\n", 1)[1]
bad = []
for chunk in re.split(r"(?m)^diff --git ", body)[1:]:
    lines = chunk.splitlines()
    match = re.search(r"^b/(\S+)", lines[0])
    if not match:
        continue
    target = match.group(1)
    if "new file mode" not in chunk:
        continue
    added = [line[1:] for line in lines if line.startswith("+") and not line.startswith("+++")]
    source = (root / "blocker" / "engine" / target.split("toolkit/components/astra_blocker_engine/", 1)[-1]).read_text().splitlines()
    if added != source:
        bad.append(target)
if bad:
    print("FAIL: ASTRA-0004 body is stale for: " + ", ".join(bad) + " (run `forge export`)")
    sys.exit(1)
print("PASS: ASTRA-0004 new-file bodies match blocker/engine")
EOF

# 4. dependency pin ---------------------------------------------------------
PIN="$(grep -E '^adblock *= ' "$SRC/Cargo.toml" | sed -nE 's/.*= *"=([^"]+)".*/\1/p')"
VENDORED="$(grep -E '^version *=' "$ENGINE_DIR/third_party/rust/adblock/Cargo.toml" 2>/dev/null | head -1 | sed -nE 's/.*"([^"]+)".*/\1/p')"
[ -n "$PIN" ] && [ "$PIN" = "$VENDORED" ] \
  && ok "adblock pin == vendored ($PIN)" || bad "adblock pin '$PIN' != vendored '$VENDORED'"

# 5. management seam --------------------------------------------------------
grep -q "nsIAstraBlockerService" "$SRC/nsIAstraBlockerService.idl" \
  && ok "nsIAstraBlockerService IDL present" || bad "IDL missing interface"
grep -q "@astra/blocker;1" "$SRC/components.conf" \
  && ok "components.conf registers @astra/blocker;1" || bad "components.conf contract id missing"
for method in installRules setResources setEnabled setSiteEnabled isSiteEnabled siteExceptions cosmeticFor stats resetStats; do
  grep -q "$method" "$HOST" && grep -q "$method" "$SRC/nsIAstraBlockerService.idl" \
    && ok "Host + IDL expose $method" || bad "Host/IDL method $method missing"
done
grep -q "AstraBlocker::ShouldBlockChannel" "$ENGINE_DIR/netwerk/url-classifier/AsyncUrlChannelClassifier.cpp" \
  && ok "channel hook calls AstraBlocker::ShouldBlockChannel" || bad "channel hook missing"

# 6. branding / telemetry in shipped data ----------------------------------
python3 - "$ROOT" <<'EOF' || FAIL=$((FAIL+1))
import json, re, sys
from pathlib import Path
root = Path(sys.argv[1])
catalog = json.loads((root / "blocker/lists/catalog.json").read_text())
resources = json.loads((root / "blocker/resources/resources.json").read_text())
banned = re.compile(r"(?i)\b(?:brave|rewards|telemetry|p3a|analytics)\b")
bad = []
for entry in catalog["lists"]:
    if banned.search(entry.get("title", "")) or banned.search(entry.get("source_url", "")):
        bad.append(entry.get("id", "?"))
    if "brave" in entry.get("source_url", "").lower():
        bad.append(entry.get("id", "?") + " (brave source)")
for resource in resources:
    name = resource.get("name", "")
    if banned.search(name) or name.startswith("brave-") or name.startswith("async-sugarcoat-"):
        bad.append(name)
if bad:
    print("FAIL: shipped blocker data still carries a banned brand/source: " + ", ".join(sorted(set(bad))))
    sys.exit(1)
print(f"PASS: shipped catalog ({len(catalog['lists'])} lists) and resources ({len(resources)}) are Astra-clean")
EOF

# 7. data + parity ---------------------------------------------------------
if python3 "$ROOT/blocker/tools/sync.py" --check >/dev/null 2>&1; then
  ok "sync.py --check (catalog/resources match the reference clones)"
else
  bad "sync.py --check failed (run python3 blocker/tools/sync.py)"
fi
if cargo test -q -p astra-blocker >/tmp/astra-blocker-test.$$ 2>&1; then
  ok "crates/astra-blocker parity fixtures"
else
  bad "crates/astra-blocker parity fixtures failed"
  tail -20 /tmp/astra-blocker-test.$$ | sed 's/^/      /'
fi
rm -f /tmp/astra-blocker-test.$$

echo
echo "blocker-wiring-check: $([ "$FAIL" -eq 0 ] && echo PASS || echo FAIL) ($PASS passed, $FAIL failed)"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
