/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The launcher's global shortcut.
//!
//! The browser can match a key while it is in front; a launcher that opens
//! from another app needs the desktop to deliver the key, which is what
//! `RegisterHotKey` does. The hotkey belongs to a thread with a message queue:
//! `WM_HOTKEY` is posted to the thread that registered it, so the registration
//! and the loop that receives it live together.
//!
//! The accelerator text is the same canonical form the keymap uses
//! (`CmdOrCtrl+Shift+Space`), so the browser and this process agree on what a
//! shortcut means.

use std::fmt;

/// A parsed accelerator: Win32 modifier flags and a virtual-key code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shortcut {
    pub modifiers: u32,
    pub vk: u32,
}

/// Why a shortcut could not be registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyError {
    /// The text is not an accelerator this parser knows.
    Invalid,
    /// Shift alone types a capital; it does not make a key global.
    NeedsModifier,
    /// Another application already holds the key.
    Unavailable,
    /// This platform has no global shortcuts.
    Unsupported,
}

impl fmt::Display for HotkeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            HotkeyError::Invalid => "invalid",
            HotkeyError::NeedsModifier => "needs_modifier",
            HotkeyError::Unavailable => "unavailable",
            HotkeyError::Unsupported => "unsupported",
        };
        f.write_str(text)
    }
}

// Win32 values, kept here so the parser is testable without the API bindings.
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
/// Windows' own modifier.
const MOD_WIN: u32 = 0x0008;
/// Do not auto-repeat while the key is held.
const MOD_NOREPEAT: u32 = 0x4000;

/// Virtual-key code for a key token, or None when the token is not one.
fn virtual_key(token: &str) -> Option<u32> {
    let upper = token.to_ascii_uppercase();
    if upper.chars().count() == 1 {
        let ch = upper.chars().next()?;
        if ch.is_ascii_uppercase() || ch.is_ascii_digit() {
            return Some(ch as u32);
        }
        let punctuation = match ch {
            ',' => Some(0xBC),
            '.' => Some(0xBE),
            '-' => Some(0xBD),
            '=' => Some(0xBB),
            '/' => Some(0xBF),
            '\\' => Some(0xDC),
            ';' => Some(0xBA),
            '\'' => Some(0xDE),
            '[' => Some(0xDB),
            ']' => Some(0xDD),
            '`' => Some(0xC0),
            _ => None,
        };
        if punctuation.is_some() {
            return punctuation;
        }
    }
    let named = match upper.as_str() {
        "SPACE" => Some(0x20),
        "ENTER" | "RETURN" => Some(0x0D),
        "ESCAPE" | "ESC" => Some(0x1B),
        "TAB" => Some(0x09),
        "BACKSPACE" => Some(0x08),
        "DELETE" => Some(0x2E),
        "UP" | "ARROWUP" => Some(0x26),
        "DOWN" | "ARROWDOWN" => Some(0x28),
        "LEFT" | "ARROWLEFT" => Some(0x25),
        "RIGHT" | "ARROWRIGHT" => Some(0x27),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" => Some(0x21),
        "PAGEDOWN" => Some(0x22),
        "COMMA" => Some(0xBC),
        "PERIOD" => Some(0xBE),
        "MINUS" => Some(0xBD),
        "EQUAL" | "PLUS" => Some(0xBB),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if let Some(rest) = upper.strip_prefix('F') {
        if let Ok(number) = rest.parse::<u32>() {
            if (1..=24).contains(&number) {
                return Some(0x70 + number - 1);
            }
        }
    }
    None
}

/// Parses the canonical accelerator text into a Win32 shortcut.
///
/// `CmdOrCtrl` is Control here: this process only runs on Windows.
pub fn parse(accelerator: &str) -> Result<Shortcut, HotkeyError> {
    let text = accelerator.trim();
    if text.is_empty() {
        return Err(HotkeyError::Invalid);
    }
    // "Ctrl++" names the plus key; splitting on '+' would lose the key itself.
    let (modifier_text, key_text) = if let Some(head) = text.strip_suffix("++") {
        (head, "+")
    } else {
        match text.rfind('+') {
            Some(at) => (&text[..at], &text[at + 1..]),
            None => ("", text),
        }
    };
    if key_text.is_empty() {
        return Err(HotkeyError::Invalid);
    }
    let vk = virtual_key(key_text).ok_or(HotkeyError::Invalid)?;
    let mut modifiers = 0u32;
    let mut has_action_modifier = false;
    for part in modifier_text.split('+').filter(|part| !part.is_empty()) {
        match part.to_ascii_uppercase().as_str() {
            "CMDORCTRL" | "CTRL" | "CONTROL" => {
                modifiers |= MOD_CONTROL;
                has_action_modifier = true;
            }
            "CMD" | "COMMAND" | "META" | "SUPER" | "WIN" => {
                modifiers |= MOD_WIN;
                has_action_modifier = true;
            }
            "ALT" | "OPTION" => {
                modifiers |= MOD_ALT;
                has_action_modifier = true;
            }
            "SHIFT" => modifiers |= MOD_SHIFT,
            _ => return Err(HotkeyError::Invalid),
        }
    }
    if !has_action_modifier {
        return Err(HotkeyError::NeedsModifier);
    }
    Ok(Shortcut {
        modifiers: modifiers | MOD_NOREPEAT,
        vk,
    })
}

#[cfg(windows)]
mod platform {
    use super::{HotkeyError, Shortcut};
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetMessageW, PostThreadMessageW, MSG, WM_HOTKEY, WM_QUIT,
    };

    const HOTKEY_ID: i32 = 0x4153; // "AS"
    const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(2);

    struct Live {
        thread_id: u32,
        join: JoinHandle<()>,
    }

    /// Owns at most one registration. Setting a new shortcut stops the thread
    /// that held the old one first, so two lifetimes never overlap.
    #[derive(Default)]
    pub struct HotkeyService {
        live: Option<Live>,
    }

    impl HotkeyService {
        pub fn new() -> Self {
            Self::default()
        }

        /// Registers `shortcut` and calls `on_press` on each press.
        ///
        /// `on_press` runs on the hotkey thread; it must not block on the
        /// caller's lock or the next press waits behind it.
        pub fn set<F>(&mut self, shortcut: Shortcut, on_press: F) -> Result<(), HotkeyError>
        where
            F: Fn() + Send + 'static,
        {
            self.clear();
            let (ready, registered) = mpsc::channel::<(u32, bool)>();
            let join = thread::spawn(move || unsafe {
                let ok = RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_ID,
                    shortcut.modifiers,
                    shortcut.vk,
                ) != 0;
                let thread_id = GetCurrentThreadId();
                let _ = ready.send((thread_id, ok));
                if !ok {
                    return;
                }
                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    if message.message == WM_HOTKEY && message.wParam as i32 == HOTKEY_ID {
                        on_press();
                    }
                }
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
            });
            match registered.recv_timeout(REGISTRATION_TIMEOUT) {
                Ok((thread_id, true)) => {
                    self.live = Some(Live { thread_id, join });
                    Ok(())
                }
                Ok((_, false)) => {
                    let _ = join.join();
                    Err(HotkeyError::Unavailable)
                }
                Err(_) => {
                    let _ = join.join();
                    Err(HotkeyError::Unavailable)
                }
            }
        }

        /// Stops the thread that holds the shortcut, if any.
        pub fn clear(&mut self) {
            let Some(live) = self.live.take() else {
                return;
            };
            unsafe {
                PostThreadMessageW(live.thread_id, WM_QUIT, 0, 0);
            }
            let _ = live.join.join();
        }
    }

    impl Drop for HotkeyService {
        fn drop(&mut self) {
            self.clear();
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{HotkeyError, Shortcut};

    #[derive(Default)]
    pub struct HotkeyService;

    impl HotkeyService {
        pub fn new() -> Self {
            Self
        }

        pub fn set<F>(&mut self, _shortcut: Shortcut, _on_press: F) -> Result<(), HotkeyError>
        where
            F: Fn() + Send + 'static,
        {
            Err(HotkeyError::Unsupported)
        }

        pub fn clear(&mut self) {}
    }
}

pub use platform::HotkeyService;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_default_accelerator() {
        let shortcut = parse("CmdOrCtrl+Shift+Space").expect("default parses");
        // MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT
        assert_eq!(shortcut.modifiers & !MOD_NOREPEAT, MOD_CONTROL | MOD_SHIFT);
        assert_eq!(shortcut.vk, 0x20);
    }

    #[test]
    fn cmd_or_ctrl_is_control_on_windows() {
        assert_eq!(
            parse("CmdOrCtrl+K").expect("parses").modifiers & !MOD_NOREPEAT,
            MOD_CONTROL
        );
    }

    #[test]
    fn accepts_letters_digits_function_keys_and_punctuation() {
        assert_eq!(parse("Ctrl+Shift+Y").expect("letter").vk, 'Y' as u32);
        assert_eq!(parse("Alt+1").expect("digit").vk, '1' as u32);
        assert_eq!(parse("Ctrl+F12").expect("function").vk, 0x7B);
        assert_eq!(parse("Ctrl+,").expect("comma").vk, 0xBC);
        assert_eq!(parse("Ctrl+Plus").expect("plus").vk, 0xBB);
    }

    #[test]
    fn shift_alone_is_not_a_modifier() {
        assert_eq!(parse("Shift+Y"), Err(HotkeyError::NeedsModifier));
    }

    #[test]
    fn rejects_text_that_is_not_an_accelerator() {
        assert_eq!(parse(""), Err(HotkeyError::Invalid));
        assert_eq!(parse("Nonsense+K"), Err(HotkeyError::Invalid));
        assert_eq!(parse("Ctrl+Unknown"), Err(HotkeyError::Invalid));
        assert_eq!(parse("Ctrl+"), Err(HotkeyError::Invalid));
    }
}
