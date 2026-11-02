/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! P5-T05 combined fixture: tasks, notes and time seeded together in one
//! database, exported per domain, imported into a fresh database/folder,
//! and verified equal — the cross-domain round-trip behind the per-domain
//! unit tests.

use astra_core::private::PrivateScope;
use astra_notes::{NoteLibrary, NotesBundle};
use astra_store::Store;
use astra_tasks::{NewTask, Priority, Tasks, TasksBundle};
use astra_time::{export_time_bundle, export_time_json, import_time_json, TimeBundle, TimeService};

struct Seeded {
    _dir: tempfile::TempDir,
    tasks_json: String,
    tasks_markdown: String,
    notes_json: String,
    time_json: String,
}

fn seed() -> Seeded {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("astra.db");
    let tasks = Tasks::open(&db).unwrap();
    // A second handle on the same file for the notes/time domains (the
    // store serialises through its mutex; sequential use is safe).
    let store = Store::open(&db).unwrap();
    store.migrate().unwrap();
    let notes = NoteLibrary::open(dir.path().join("notes")).unwrap();

    let work = tasks.create_list("Work", 1).unwrap();
    let parent = tasks
        .create_task(NewTask {
            list_id: Some(work.id),
            title: "Plan trip".to_owned(),
            notes: "ask about Friday".to_owned(),
            due_at: Some(1_700_000_000),
            priority: Priority::High,
            parent_id: None,
            position: 0,
        })
        .unwrap();
    let child = tasks
        .create_task(NewTask {
            list_id: Some(work.id),
            title: "Book flights".to_owned(),
            notes: String::new(),
            due_at: None,
            priority: Priority::None,
            parent_id: Some(parent.id),
            position: 0,
        })
        .unwrap();
    tasks
        .add_link(child.id, "https://example.com/flights", "Flights")
        .unwrap();
    let done = tasks
        .create_task(NewTask {
            list_id: Some(work.id),
            title: "Done thing".to_owned(),
            notes: String::new(),
            due_at: None,
            priority: Priority::Low,
            parent_id: None,
            position: 1,
        })
        .unwrap();
    tasks.complete_task(done.id).unwrap();

    notes
        .create(&store, "ideas/plan.md", "# Plan\n\nShip it.\n")
        .unwrap();
    notes
        .create(&store, "log.md", "plain text, no heading\n")
        .unwrap();

    let time = TimeService::new(&store, PrivateScope::public());
    let first = time
        .start_session("https://a.example/x", "X", 100)
        .expect("public scope writes")
        .expect("time_start");
    time.end_session(first.id, 160)
        .expect("public writes")
        .expect("time_end");
    time.set_focus_rule("a.example", "block")
        .expect("public scope writes")
        .expect("focus_rule_set");

    Seeded {
        tasks_json: tasks.export_json().unwrap(),
        tasks_markdown: tasks.export_markdown().unwrap(),
        notes_json: notes.export_json(&store).unwrap(),
        time_json: export_time_json(&store).unwrap(),
        _dir: dir,
    }
}

fn zero_mtimes(bundle: &mut NotesBundle) {
    for note in &mut bundle.notes {
        note.mtime = 0;
    }
}

#[test]
fn combined_json_round_trip_across_domains() {
    let seeded = seed();

    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("astra.db");
    let tasks = Tasks::open(&db).unwrap();
    let store = Store::open(&db).unwrap();
    store.migrate().unwrap();
    let notes = NoteLibrary::open(dir.path().join("notes")).unwrap();

    let tasks_report = tasks.import_json(&seeded.tasks_json).unwrap();
    assert_eq!(tasks_report.tasks, 3);
    assert_eq!(tasks_report.links, 1);
    let notes_count = notes.import_json(&store, &seeded.notes_json).unwrap();
    assert_eq!(notes_count, 2);
    let time_report = import_time_json(&store, &seeded.time_json).unwrap();
    assert_eq!(time_report.sessions, 1);

    // Every domain re-exports to the payload it imported.
    let tasks_bundle: TasksBundle = serde_json::from_str(&seeded.tasks_json).unwrap();
    assert_eq!(tasks.export_bundle().unwrap(), tasks_bundle);

    let mut notes_bundle: NotesBundle = serde_json::from_str(&seeded.notes_json).unwrap();
    let mut reimported: NotesBundle =
        serde_json::from_str(&notes.export_json(&store).unwrap()).unwrap();
    zero_mtimes(&mut notes_bundle);
    zero_mtimes(&mut reimported);
    assert_eq!(reimported, notes_bundle);

    let time_bundle: TimeBundle = serde_json::from_str(&seeded.time_json).unwrap();
    assert_eq!(export_time_bundle(&store).unwrap(), time_bundle);
    assert_eq!(store.time_for_host("a.example").unwrap(), 60);
}

#[test]
fn combined_markdown_path_restores_the_same_tasks() {
    let seeded = seed();

    let dir = tempfile::tempdir().unwrap();
    let tasks = Tasks::open(dir.path().join("astra.db")).unwrap();
    let report = tasks.import_markdown(&seeded.tasks_markdown).unwrap();
    assert_eq!(report.tasks, 3);
    assert_eq!(report.links, 1);

    // The Markdown path converges on the same bundle as the JSON path,
    // and re-exports byte-identically.
    let tasks_bundle: TasksBundle = serde_json::from_str(&seeded.tasks_json).unwrap();
    assert_eq!(tasks.export_bundle().unwrap(), tasks_bundle);
    assert_eq!(tasks.export_markdown().unwrap(), seeded.tasks_markdown);
}
