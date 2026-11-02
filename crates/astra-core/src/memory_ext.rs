/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of this file was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Memory write guard + content helpers (P6-T08, thin facade).
//!
//! Memory writes go through the same private-scope contract as history,
//! sessions, favicons, and time tracking (see [`crate::private`]): private
//! windows persist nothing. The store layer cannot depend on `astra-core`,
//! so this module is the core-side half of that contract — a one-line gate
//! plus content sanitation. It owns no rows and adds no tables:
//!
//! - [`memory_allowed`] / [`gate_memory_write`]: the `PrivateScope` guard
//!   for the `"memory"` write path (unknown action names default to the
//!   private-safe master switch, so this path is blocked in private scope
//!   by construction).
//! - [`sanitize_memory_content`]: trim + empty-reject + char-boundary
//!   truncation to the caller-supplied cap, so agent summaries always
//!   validate before they reach the store.

use crate::private::PrivateScope;

/// Write path name used for memory persistence decisions.
pub const MEMORY_ACTION: &str = "memory";

/// Whether a memory write may persist in `scope`. False in private scope.
pub fn memory_allowed(scope: &PrivateScope) -> bool {
    scope.check(MEMORY_ACTION).persist()
}

/// Run `write` only in public scope; returns `None` (write skipped) in
/// private scope. Keeps memory call sites to one expression:
/// `gate_memory_write(&scope, || store.memory_create(…))`.
pub fn gate_memory_write<T>(scope: &PrivateScope, write: impl FnOnce() -> T) -> Option<T> {
    scope.gate(MEMORY_ACTION, write)
}

/// Trim `content` for storage: `None` when blank, otherwise the trimmed
/// text truncated to `max_chars` on a char boundary (never splits UTF-8).
/// Mirrors the agent layer's keep-policy so overlong run summaries are
/// filed truncated rather than dropped.
pub fn sanitize_memory_content(content: &str, max_chars: usize) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_scope_allows_memory_private_blocks_it() {
        assert!(memory_allowed(&PrivateScope::public()));
        assert!(!memory_allowed(&PrivateScope::private()));
        assert_eq!(gate_memory_write(&PrivateScope::public(), || 42), Some(42));
        let mut called = false;
        assert_eq!(
            gate_memory_write(&PrivateScope::private(), || {
                called = true;
                42
            }),
            None
        );
        assert!(!called, "gated memory write must not run in private scope");
    }

    #[test]
    fn sanitize_rejects_blank_and_truncates_on_char_boundary() {
        assert_eq!(sanitize_memory_content("   ", 16), None);
        assert_eq!(sanitize_memory_content("", 16), None);
        assert_eq!(
            sanitize_memory_content("  kept  ", 16).as_deref(),
            Some("kept")
        );
        // Multi-byte content truncates on char boundaries, never panics.
        let hearts = "♥".repeat(10);
        let cut = sanitize_memory_content(&hearts, 4).unwrap();
        assert_eq!(cut.chars().count(), 4);
        assert_eq!(cut, "♥♥♥♥");
    }
}
