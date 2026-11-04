// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Astra autoconfig entry (P1-T06). Shipped as dist/bin/defaults/pref/
// via JS_PREFERENCE_FILES in overlay/astra/moz.build. Points the
// autoconfig engine (Preferences.cpp, `general.config.filename`) at
// dist/bin/mozilla.cfg, which runs last and lockPrefs our privacy posture.
// `obscure_value 0` = plain-text cfg (no byte-shift obfuscation to hide behind).
pref("general.config.filename", "mozilla.cfg");
pref("general.config.obscure_value", 0);

// Optional Rust core process. Empty = auto: the shell uses `astra-core` next
// to the browser binary when it exists, otherwise answers an honest
// `unavailable`. Set an absolute path to override (dev builds).
pref("astra.core.command", "");
