#!/usr/bin/env bash
# tools/blocker-wiring-check.sh — P4-T02 wiring test (no engine build required).
#
# Verifies the ASTRA-0003/0004/0005 patch series against the pinned ESR tree:
#   1. §6.3 headers (required fields, Patch-Id↔filename, order, Verified-On)
#   2. every modified-file hunk applies: context lines exist verbatim in ENGINE_DIR
#   3. every Upstream-Files entry is covered (modified files exist; new files
#      appear as `new file` hunks in the patch body — cf. BLOCKER_WIRING.md §6)
#   4. cross-consistency (crate name, extern crate, cbindgen, includes, adblock pin)
#   5. supply chain (pin == vendored third_party/rust/adblock == audits.toml entry)
#   6. footprint budgets (§6.7)
#   7. verdict parity: `cargo test -p astra-blocker` fixture corpus
#   8. rustfmt cleanliness of the new Rust sources (extracted from the patch)
#
# Usage: tools/blocker-wiring-check.sh [ENGINE_DIR]
#   ENGINE_DIR defaults to <repo>/engine. Reads only — never writes there.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${1:-$ROOT/engine}"
PATCHES=("$ROOT/patches/ASTRA-0003-astra-blocker-gkrust.patch"
         "$ROOT/patches/ASTRA-0004-astra-blocker-engine.patch"
         "$ROOT/patches/ASTRA-0005-astra-blocker-hook.patch")
PASS=0; FAIL=0; SKIP=0

ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
skip() { SKIP=$((SKIP+1)); echo "SKIP: $1"; }

[ -d "$ENGINE_DIR" ] || { echo "FAIL: ENGINE_DIR missing: $ENGINE_DIR (pass the engine checkout path explicitly; read-only use)"; exit 2; }

PINNED="$(grep -E '^version *=' "$ROOT/upstream.toml" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
echo "== blocker-wiring-check =="
echo "engine : $ENGINE_DIR"
echo "pinned : $PINNED"

# ---- 1. headers -----------------------------------------------------------
IDS=""
for p in "${PATCHES[@]}"; do
  [ -f "$p" ] || { bad "missing patch file $p"; continue; }
  hdr="$(awk '/^---$/{exit} {print}' "$p")"
  for f in Patch-Id Title Tier Upstream-Files Intent Risk Test Verified-On Removal-Plan; do
    echo "$hdr" | grep -qE "^$f: *[^ ]" || bad "$p: header field '$f' missing/empty"
  done
  id="$(echo "$hdr" | sed -nE 's/^Patch-Id: *//p')"
  base="$(basename "$p")"
  case "$base" in "$id"-*|"$id".patch) ok "$base: filename matches Patch-Id $id";; *) bad "$base: filename does not start with Patch-Id $id";; esac
  tier="$(echo "$hdr" | sed -nE 's/^Tier: *//p')"
  case "$tier" in P0|P1|P2|P3) ok "$base: Tier $tier valid";; *) bad "$base: bad Tier '$tier'";; esac
  ver="$(echo "$hdr" | sed -nE 's/^Verified-On: *//p')"
  [ "$ver" = "$PINNED" ] && ok "$base: Verified-On == pinned ($PINNED)" || bad "$base: Verified-On '$ver' != pinned '$PINNED'"
  IDS="$IDS $id"
done
IDS_NORM="$(echo "$IDS" | tr ' ' '\n' | grep . | tr '\n' ' ')"
sorted="$(echo "$IDS" | tr ' ' '\n' | grep . | sort | tr '\n' ' ')"
[ "$IDS_NORM" = "$sorted" ] && ok "patch series in Patch-Id order" || bad "patch series out of order:$IDS"

# The python block below prints its own PASS/FAIL lines; propagate failures:
MARK="$(mktemp)"
python3 - "$ENGINE_DIR" "${PATCHES[@]}" >"$MARK" 2>&1 <<'EOF'
import re, sys, subprocess
engine, patches = sys.argv[1], sys.argv[2:]
base = subprocess.run(["git", "-C", engine, "log", "--format=%H", "--grep=^baseline:", "--reverse"],
                       capture_output=True, text=True).stdout.split()[0]
def at_baseline(path):
    return subprocess.run(["git", "-C", engine, "cat-file", "-e", f"{base}:{path}"],
                          capture_output=True).returncode == 0
for p in patches:
    name = p.split('/')[-1]
    text = open(p).read()
    header, _, body = text.partition('\n---\n')
    files = [f.strip() for f in re.search(r'^Upstream-Files:\s*(.*)$', header, re.M).group(1).replace(',', ' ').split()]
    diffs = {}
    for chunk in re.split(r'(?m)^(?=diff --git )', body):
        if not chunk.startswith('diff --git'): continue
        m = re.search(r'diff --git a/(\S+) b/(\S+)', chunk)
        newfile = 'new file mode' in chunk
        if newfile:
            seq = [l[1:] for l in chunk.splitlines()
                   if l.startswith('+') and not l.startswith('+++')]
        else:
            seq = [l[1:] for l in chunk.splitlines()
                   if (l.startswith(' ') or l.startswith('-')) and not l.startswith('---')]
        diffs[m.group(1)] = (newfile, seq)
    if set(files) == set(diffs):
        print(f"PASS: {name}: Upstream-Files == body files ({len(files)})")
    else:
        print(f"FAIL: {name}: Upstream-Files/body mismatch: {sorted(set(files)^set(diffs))}")
    for f in files:
        newfile, seq = diffs[f]
        if newfile:
            # New files must NOT exist at the baseline commit (else the
            # patch would fail to apply and Upstream-Files would be wrong).
            # NB: the live worktree HAS them (patches applied) — that is
            # expected and is not what this checks.
            if at_baseline(f): print(f"FAIL: {name}: new file {f} exists at baseline")
            else: print(f"PASS: {name}: new file {f} absent at baseline, {len(seq)} lines")
            continue
        import os
        path = f"{engine}/{f}"
        if not os.path.exists(path):
            print(f"FAIL: {name}: modified file missing: {f}"); continue
        lines = open(path, errors='replace').read().splitlines()
        idx, hit = 0, 0
        for want in seq:
            while idx < len(lines) and lines[idx] != want: idx += 1
            if idx >= len(lines): break
            idx += 1; hit += 1
        if hit == len(seq): print(f"PASS: {name}: {f} hunk context matches ({hit}/{len(seq)})")
        else: print(f"FAIL: {name}: {f} hunk mismatch at line {hit+1}/{len(seq)}")
EOF
grep -E '^(PASS|FAIL|SKIP)' "$MARK"
NFAIL="$(grep -c '^FAIL' "$MARK" || true)"
FAIL=$((FAIL+NFAIL)); PASS=$((PASS+$(grep -c '^PASS' "$MARK" || true))); rm -f "$MARK"

# ---- 4. cross-consistency ---------------------------------------------------
P4="$ROOT/patches/ASTRA-0004-astra-blocker-engine.patch"
CRATE="$(grep -E '^\+name = ' "$P4" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
[ "$CRATE" = "astra_blocker_engine" ] && ok "crate name = $CRATE" || bad "crate name '$CRATE'"
grep -q '^+extern crate astra_blocker_engine;$' "$ROOT/patches/ASTRA-0003-astra-blocker-gkrust.patch" \
  && ok "ASTRA-0003 extern crate matches" || bad "ASTRA-0003 extern crate mismatch"
grep -q '^+astra_blocker_engine = { path = "../../../components/astra_blocker_engine" }$' "$ROOT/patches/ASTRA-0003-astra-blocker-gkrust.patch" \
  && ok "ASTRA-0003 path dep matches crate dir" || bad "ASTRA-0003 path dep mismatch"
grep -q 'inputs=\["/toolkit/components/astra_blocker_engine"\]' "$P4" \
  && ok "cbindgen inputs == crate dir" || bad "cbindgen inputs mismatch"
grep -q '"mozilla/AstraBlocker.h"' "$ROOT/patches/ASTRA-0005-astra-blocker-hook.patch" \
  && grep -q '^+    "astra_blocker_engine",$' "$P4" \
  && grep -q 'AstraBlocker.cpp' "$P4" \
  && ok "hook include / DIRS / UNIFIED_SOURCES consistent" || bad "bridge/hook consistency"
PIN="$(grep -E '^\+adblock = ' "$P4" | head -1 | sed -E 's/.*version = "=([0-9.]+)".*/\1/')"
[ "$PIN" = "0.12.1" ] && ok "in-tree adblock pin = $PIN" || bad "adblock pin '$PIN'"

# ---- 5. supply chain ---------------------------------------------------------
VEND="$(grep -E '^version = ' "$ENGINE_DIR/third_party/rust/adblock/Cargo.toml" | head -1 | sed -E 's/.*"([0-9.]+)".*/\1/')"
[ "$VEND" = "$PIN" ] && ok "vendored adblock == pin ($VEND)" || bad "vendored adblock $VEND != pin $PIN"
AUDIT="$(grep -A4 '^\[\[audits.adblock\]\]' "$ENGINE_DIR/supply-chain/audits.toml" | grep -E '^version = ' | sed -E 's/.*"([0-9.]+)".*/\1/')"
[ "$AUDIT" = "$PIN" ] && ok "audits.toml covers $AUDIT (safe-to-deploy)" || bad "audits.toml adblock version '$AUDIT' != pin $PIN"
grep -A6 '^\[\[audits.adblock\]\]' "$ENGINE_DIR/supply-chain/audits.toml" | grep -q 'safe-to-deploy' \
  && ok "audit criteria safe-to-deploy" || bad "audit criteria"

# ---- 6. footprint --------------------------------------------------------------
# modified lines in pre-existing files only (new-file hunks excluded)
MODLINES="$(python3 - "${PATCHES[@]}" <<'EOF'
import re, sys
n = 0
for p in sys.argv[1:]:
    body = open(p).read().partition('\n---\n')[2]
    for chunk in re.split(r'(?m)^(?=diff --git )', body):
        if chunk.startswith('diff --git') and 'new file mode' not in chunk:
            n += sum(1 for l in chunk.splitlines() if (l.startswith('+') or l.startswith('-')) and not l.startswith(('+++', '---')))
print(n)
EOF
)"
[ "$MODLINES" -le 1500 ] && ok "upstream footprint $MODLINES modified lines (budget 1500)" || bad "footprint $MODLINES > 1500"
P3COUNT="$(grep -h '^Tier: P3' "$ROOT"/patches/ASTRA-*.patch | wc -l)"
[ "$P3COUNT" -le 8 ] && ok "P3 count $P3COUNT (budget 8)" || bad "P3 count $P3COUNT"

# ---- 7. verdict parity (sidecar corpus; no engine build) ----------------------
if command -v cargo >/dev/null 2>&1; then
  if (cd "$ROOT" && timeout 100 cargo test -p astra-blocker --test fixtures 2>&1 | tail -3 | grep -q 'test result: ok'); then
    ok "astra-blocker fixture corpus green (parity baseline)"
  else
    bad "astra-blocker fixture corpus failed"
  fi
else
  skip "cargo missing — parity corpus not run"
fi

# ---- 8. rustfmt on new Rust sources -------------------------------------------
if command -v rustfmt >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  python3 - "$P4" "$TMP" <<'EOF'
import re, sys, os
body = open(sys.argv[1]).read().partition('\n---\n')[2]
for chunk in re.split(r'(?m)^(?=diff --git )', body):
    m = re.search(r'diff --git a/\S+ b/(\S+)', chunk)
    if not m or not m.group(1).endswith('.rs') or 'new file mode' not in chunk: continue
    content = '\n'.join(l[1:] for l in chunk.splitlines() if l.startswith('+') and not l.startswith('+++')) + '\n'
    p = os.path.join(sys.argv[2], os.path.basename(m.group(1)))
    open(p, 'w').write(content)
    print(p)
EOF
  FMTFAIL=0
  for f in "$TMP"/*.rs; do rustfmt --check "$f" >/dev/null 2>&1 || { echo "FAIL: rustfmt: $f"; FMTFAIL=1; }; done
  [ "$FMTFAIL" = 0 ] && ok "new Rust sources rustfmt-clean" || FAIL=$((FAIL+1))
  rm -rf "$TMP"
else
  skip "rustfmt missing"
fi

echo "== result: $PASS passed, $FAIL failed, $SKIP skipped =="
[ "$FAIL" = 0 ]
