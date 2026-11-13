#!/usr/bin/env bash
# tools/venv-python.sh — resolve the Python interpreter for repo tooling.
#
# Prints the repo venv interpreter when $ROOT/.venv exists, so probes and
# checks run against one pinned interpreter on both platforms:
#   Linux:            $ROOT/.venv/bin/python
#   Windows Git-Bash: $ROOT/.venv/Scripts/python.exe
# Otherwise falls back to `python3` (then `python`), so Linux behavior
# without a venv is unchanged.
#
# Usage in scripts:
#   PYTHON="$(bash "$ROOT/tools/venv-python.sh")"
#   "$PYTHON" tools/state-check.py
#
# Interactive activation (same interpreter):
#   Linux:   source .venv/bin/activate
#   Windows: .\.venv\Scripts\Activate.ps1   (PowerShell)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x "$ROOT/.venv/Scripts/python.exe" ]; then
  printf '%s\n' "$ROOT/.venv/Scripts/python.exe"
elif [ -x "$ROOT/.venv/bin/python" ]; then
  printf '%s\n' "$ROOT/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  command -v python3
else
  command -v python
fi
