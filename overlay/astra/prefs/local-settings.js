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

// Optional Rust core process. Empty = no core; the shell asks Boot to
// launch it and gets an honest `unavailable` instead of a fake process.
pref("astra.core.command", "");

// Native gBrowser tabs are the product path (P4). Set false only to exercise
// the legacy standalone mount while P4.4b removes it.
pref("astra.gbrowser.enabled", true);
