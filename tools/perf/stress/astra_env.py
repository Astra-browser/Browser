"""Resolve the Astra dev build for probes, on Linux and Windows.

One place for the engine objdir, the browser binary and geckodriver, so a probe
runs against whatever build this machine has instead of a hardcoded
``engine/obj-astra-linux``. Nothing here asserts anything: probes keep their
own checks, this module only replaces path plumbing.

Precedence for every value is the same: an environment override, then the
platform default under ``<repo>/engine``.

    ASTRA_ENGINE        engine objdir            engine/obj-astra-<os>
    ASTRA_BINARY        browser binary           <engine>/dist/bin/firefox[.exe]
    ASTRA_GECKODRIVER   marionette driver        <engine>/dist/host/bin/geckodriver[.exe]
    ASTRA_OBJDIR        objdir name, used only when ASTRA_ENGINE is unset

Usage from a probe:

    import astra_env
    FIREFOX = astra_env.BINARY

Probes under ``tools/perf/stress`` import it directly (the script's own
directory is on ``sys.path``). Probes under ``tools/marionette-probe`` add that
directory first:

    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "perf", "stress"))
    import astra_env
"""
import os

ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
IS_WINDOWS = os.name == "nt"

OBJDIR = os.environ.get("ASTRA_OBJDIR") or (
    "obj-astra-windows" if IS_WINDOWS else "obj-astra-linux"
)
ENGINE = os.path.abspath(
    os.environ.get("ASTRA_ENGINE") or os.path.join(ROOT, "engine", OBJDIR)
)

BINARY_NAME = "firefox.exe" if IS_WINDOWS else "firefox"
BINARY = os.path.abspath(
    os.environ.get("ASTRA_BINARY")
    or os.path.join(ENGINE, "dist", "bin", BINARY_NAME)
)
BIN_DIR = os.path.dirname(BINARY)

GECKODRIVER_NAME = "geckodriver.exe" if IS_WINDOWS else "geckodriver"
GECKODRIVER = os.path.abspath(
    os.environ.get("ASTRA_GECKODRIVER")
    or os.path.join(ENGINE, "dist", "host", "bin", GECKODRIVER_NAME)
)

# The packaged dev build's chrome directory (where astra-core and friends live).
DIST_DIR = os.path.join(ENGINE, "dist")


def missing_reason():
    """Why a live probe cannot start here, or None when the build is present."""
    if not os.path.isdir(ENGINE):
        return "engine objdir not found: %s" % ENGINE
    if not os.path.isfile(BINARY):
        return "browser binary not found: %s" % BINARY
    return None


def describe():
    """One line naming what this process will drive, for probe logs."""
    return (
        "%s (engine %s, %s)"
        % (BINARY, ENGINE, "windows" if IS_WINDOWS else "linux")
    )


def require():
    """Exit 2 (the suite's SKIP code) when the build is not there."""
    import sys

    reason = missing_reason()
    if reason:
        print("SKIP: %s" % reason)
        sys.exit(2)
