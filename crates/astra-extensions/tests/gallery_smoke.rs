/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Offline smoke coverage (P4-T04): every gallery entry is installable in
//! the manager model (or correctly blocked with its `none` reason), and the
//! enable/disable + permission-prompt flows run end to end per entry.
//! No network, no fixtures on disk — runs in CI.

use astra_extensions::manager::{AccessMode, PendingPermission};
use astra_extensions::{installable, load_gallery, ExtensionManager};

#[test]
fn every_gallery_entry_smokes_through_install_enable_disable() {
    let doc = load_gallery().expect("gallery.json must load");
    assert!(!doc.entries.is_empty());
    for entry in &doc.entries {
        let key = entry
            .firefox
            .slug
            .clone()
            .unwrap_or_else(|| entry.chrome_store_id.clone());
        let mut manager = ExtensionManager::new();
        if installable(entry) {
            manager.install(&key, &entry.name).expect("install");
            manager.set_enabled(&key, true).expect("enable");
            assert!(manager.get(&key).unwrap().enabled);
            manager
                .set_access(&key, AccessMode::Sites(vec!["example.com".to_string()]))
                .expect("site access");
            manager.queue_permission(PendingPermission {
                dialog_id: format!("dlg-{key}"),
                extension_id: key.clone(),
                permission: "tabs".to_string(),
                url: "https://example.com".to_string(),
            });
            assert_eq!(manager.pending().len(), 1);
            let decision = manager
                .answer_permission(&format!("dlg-{key}"), true)
                .expect("answer");
            assert!(decision.grant);
            manager.set_enabled(&key, false).expect("disable");
            assert!(!manager.get(&key).unwrap().enabled);
            manager.uninstall(&key).expect("uninstall");
            assert!(manager.get(&key).is_none());
        } else {
            // `none` entries carry the reason and must never produce an
            // installable artifact.
            assert!(entry.firefox.slug.is_none());
            assert!(entry.firefox.amo_url.is_none());
            assert!(!entry.firefox.note.is_empty());
        }
    }
}
