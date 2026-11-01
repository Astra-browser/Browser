/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Live watching: `notify` first, polling when the platform refuses.
//!
//! Choice of backend: [`notify::recommended_watcher`] (inotify on Linux,
//! FSEvents on macOS, ReadDirectoryChanges on Windows) delivers external
//! edits in milliseconds with no idle cost, which is what "external edits
//! appear live" needs. A polling fallback covers the cases native watching
//! cannot: network mounts that never fire events, sandboxes that deny
//! watches, and file-descriptor exhaustion. Both paths funnel into the same
//! [`NoteLibrary::sync_index`], so live and polling modes behave
//! identically — only latency differs — and a missed native event still
//! converges on the next pass.
//!
//! The watcher owns a thread and an `Arc<Store>`; consumers read batches of
//! [`NoteEvent`] off the returned channel. Tests that need determinism
//! should call [`NoteLibrary::sync_index`] (or [`NoteWatcher::sync_now`])
//! directly instead of waiting on the thread.

use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::{NoteEvent, NoteLibrary, NotesError};

/// How often polling mode rescans when native watching is unavailable.
/// Slow enough to idle cheaply on thousands of notes, fast enough that an
/// external edit still "appears" without the user wondering.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Which mechanism is delivering live updates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatcherMode {
    /// Native OS events via `notify`, debounced into rescans.
    Live,
    /// Periodic [`NoteLibrary::sync_index`]; native watching failed.
    Polling,
}

/// Background watcher keeping one notes folder indexed.
///
/// The thread ends when the handle is shut down or dropped.
pub struct NoteWatcher {
    mode: WatcherMode,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    library: NoteLibrary,
    store: Arc<astra_store::Store>,
}

impl NoteWatcher {
    /// Start watching `root`, indexing into `store`.
    ///
    /// `debounce` is how long live mode waits for the filesystem to go
    /// quiet before rescanning (50–200ms suits editors that write in
    /// bursts: create, write, chmod, rename). Returns the handle plus the
    /// channel event batches arrive on; only non-empty batches are sent.
    pub fn spawn(
        root: impl AsRef<Path>,
        store: Arc<astra_store::Store>,
        debounce: Duration,
    ) -> Result<(Self, Receiver<Vec<NoteEvent>>), NotesError> {
        let library = NoteLibrary::open(root)?;
        let (batch_tx, batch_rx) = mpsc::channel::<Vec<NoteEvent>>();
        let (ping_tx, ping_rx) = mpsc::channel::<()>();
        let mode =
            match notify::recommended_watcher(move |_: Result<notify::Event, notify::Error>| {
                let _ = ping_tx.send(());
            }) {
                Ok(mut watcher) => {
                    use notify::Watcher;
                    match watcher.watch(library.root(), notify::RecursiveMode::Recursive) {
                        Ok(()) => {
                            std::mem::forget(watcher);
                            WatcherMode::Live
                        }
                        Err(e) => {
                            tracing::warn!(
                                "notes watcher: native watch failed ({e}), polling instead"
                            );
                            WatcherMode::Polling
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("notes watcher: notify unavailable ({e}), polling instead");
                    WatcherMode::Polling
                }
            };

        let stop = Arc::new(AtomicBool::new(false));
        let worker = Worker {
            library: library.clone(),
            store: Arc::clone(&store),
            stop: Arc::clone(&stop),
            mode,
            debounce,
            ping_rx,
            batch_tx,
        };
        let handle = thread::Builder::new()
            .name("astra-notes-watcher".to_owned())
            .spawn(move || worker.run())
            .map_err(std::io::Error::other)?;
        Ok((
            Self {
                mode,
                stop,
                handle: Some(handle),
                library,
                store,
            },
            batch_rx,
        ))
    }

    /// Which mechanism is delivering updates.
    pub fn mode(&self) -> WatcherMode {
        self.mode
    }

    /// Rescan now on the calling thread (deterministic; the background
    /// thread will simply find nothing new on its next pass).
    pub fn sync_now(&self) -> Result<Vec<NoteEvent>, NotesError> {
        self.library.sync_index(&self.store)
    }

    /// Stop the thread and wait for it. Dropping the handle does the same;
    /// prefer this in tests so a stuck thread fails loudly here.
    pub fn shutdown(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for NoteWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct Worker {
    library: NoteLibrary,
    store: Arc<astra_store::Store>,
    stop: Arc<AtomicBool>,
    mode: WatcherMode,
    debounce: Duration,
    ping_rx: mpsc::Receiver<()>,
    batch_tx: mpsc::Sender<Vec<NoteEvent>>,
}

impl Worker {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn sync_and_emit(&self) {
        match self.library.sync_index(&self.store) {
            Ok(events) if !events.is_empty() => {
                if self.batch_tx.send(events).is_err() {
                    self.stop.store(true, Ordering::SeqCst);
                }
            }
            Err(e) => tracing::warn!("notes watcher: rescan failed ({e})"),
            Ok(_) => {}
        }
    }

    fn run(self) {
        match self.mode {
            WatcherMode::Live => {
                while !self.stopped() {
                    // Wait for the first ping, then for quiet: editors save
                    // in bursts, and one rescan covers the whole burst.
                    match self.ping_rx.recv_timeout(POLL_INTERVAL) {
                        Ok(()) => {}
                        Err(RecvTimeoutError::Timeout) => {
                            if !self.stopped() {
                                self.sync_and_emit();
                            }
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                    while self.ping_rx.recv_timeout(self.debounce).is_ok() {}
                    if !self.stopped() {
                        self.sync_and_emit();
                    }
                }
            }
            WatcherMode::Polling => {
                while !self.stopped() {
                    thread::sleep(POLL_INTERVAL);
                    if !self.stopped() {
                        self.sync_and_emit();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NoteLibrary;

    fn test_store() -> Arc<astra_store::Store> {
        let store = astra_store::Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        Arc::new(store)
    }

    fn next_batch(rx: &Receiver<Vec<NoteEvent>>, what: &str) -> Vec<NoteEvent> {
        rx.recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("timed out waiting for watcher batch: {what}"))
    }

    #[test]
    fn external_write_arrives_live_and_updates_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let library = NoteLibrary::open(dir.path()).unwrap();
        library.create(&store, "live.md", "# Before\n").unwrap();

        let (watcher, rx) =
            NoteWatcher::spawn(dir.path(), Arc::clone(&store), Duration::from_millis(50)).unwrap();
        // Baseline is indexed already; an immediate quiet sync sends nothing.
        assert!(watcher.sync_now().unwrap().is_empty());

        // Concurrent external edit: another "process" rewrites the file.
        std::fs::write(dir.path().join("live.md"), "# After\n\nEdited outside.\n").unwrap();
        let batch = next_batch(&rx, "external edit");
        assert_eq!(batch.len(), 1);
        match &batch[0] {
            NoteEvent::Updated(meta) => {
                assert_eq!(meta.rel, "live.md");
                assert_eq!(meta.title, "After");
            }
            other => panic!("expected Updated, got {other:?}"),
        }

        // The store index picked it up: title and hash match the new file.
        let rows = store.note_list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "After");

        watcher.shutdown();
    }

    #[test]
    fn external_create_and_delete_arrive_as_batches() {
        let dir = tempfile::tempdir().unwrap();
        let store = test_store();
        let (watcher, rx) =
            NoteWatcher::spawn(dir.path(), Arc::clone(&store), Duration::from_millis(50)).unwrap();

        std::fs::write(dir.path().join("a.md"), "# A\n").unwrap();
        std::fs::write(dir.path().join("b.md"), "# B\n").unwrap();
        // One burst may arrive as one batch or two; collect until both
        // creations have been seen.
        let mut created = Vec::new();
        for _ in 0..5 {
            for event in next_batch(&rx, "external creates") {
                if let NoteEvent::Created(meta) = event {
                    created.push(meta.rel);
                }
            }
            created.sort();
            created.dedup();
            if created == ["a.md", "b.md"] {
                break;
            }
        }
        assert_eq!(created, ["a.md", "b.md"]);

        std::fs::remove_file(dir.path().join("a.md")).unwrap();
        let mut saw_removed = false;
        for _ in 0..5 {
            for event in next_batch(&rx, "external delete") {
                if event
                    == (NoteEvent::Removed {
                        rel: "a.md".to_owned(),
                    })
                {
                    saw_removed = true;
                }
            }
            if saw_removed {
                break;
            }
        }
        assert!(saw_removed, "watcher never reported the delete");

        watcher.shutdown();
    }
}
