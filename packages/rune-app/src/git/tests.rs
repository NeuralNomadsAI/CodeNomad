use super::*;
use codenomad_client::git::{Change, Commit, Status};
use codenomad_client::{git::Section, transport::WorkspaceEvent};

fn change(path: impl Into<String>, staged: bool, whitespace: bool, score: u64) -> Status {
    let counts = Change {
        kind: "modified".into(),
        additions: score,
        deletions: 1,
    };
    Status {
        path: path.into(),
        original_path: None,
        whitespace_only: whitespace,
        staged: staged.then(|| counts.clone()),
        unstaged: Some(counts),
    }
}

fn statuses(ui: &mut Ui, rows: Vec<Status>) {
    ui.accept(Lane::Changes, Value::Changes(rows, None, ui.index_revision));
}

#[test]
fn large_status_preserves_sticky_rows_and_never_stages_hidden_whitespace() {
    let mut changes = Changes::default();
    let mut statuses: Vec<_> = (0..2700)
        .map(|n| {
            change(
                format!("{n:04}.rs"),
                n < 1000,
                n == 1001,
                (n == 2699) as u64,
            )
        })
        .collect();
    assert!(changes.replace(statuses.clone(), true));
    assert!(!changes.replace(statuses.clone(), true));
    assert_eq!(changes.count(), 2699);
    assert_eq!(changes.visible(Section::Staged).count(), 200);
    assert_eq!(changes.visible(Section::Unstaged).count(), 201);
    let last = changes.current.clone().unwrap();
    assert_eq!(last.path, "2699.rs");
    let first = Id {
        path: "0000.rs".into(),
        section: Section::Staged,
    };
    changes.select(first, false, false);
    changes.select(last.clone(), false, true);
    assert_eq!(changes.paths(&last).len(), 201);
    assert!(!changes.paths(&last).contains(&"1001.rs".into()));
    assert_eq!(
        changes.show_more(Section::Unstaged).unwrap().path,
        "0200.rs"
    );
    changes.select(
        Id {
            path: "0000.rs".into(),
            section: Section::Unstaged,
        },
        false,
        false,
    );
    assert_eq!(changes.visible(Section::Unstaged).count(), 401);
    statuses.pop();
    assert!(changes.replace(statuses, true));
    assert_eq!(changes.visible(Section::Unstaged).count(), 400);
}

fn ui() -> Ui {
    let backend = Backend {
        base: "http://127.0.0.1:1/".into(),
        workspace: "workspace".into(),
        session: "session".into(),
        client: codenomad_client::http::Http::new().unwrap(),
        client_id: "test".into(),
        fresh_mode: false,
    };
    let mut ui = Ui::new(
        backend,
        Some("D:/repo".into()),
        Reads::default(),
        std::sync::Arc::new(|| {}),
    );
    ui.accept(
        Lane::Worktrees,
        Value::Worktrees(Worktrees {
            repository: Repository::Git,
            trees: vec![
                Worktree {
                    slug: "root".into(),
                    directory: "D:/repo".into(),
                    branch: Some("main".into()),
                    head: Some("a".repeat(40)),
                    service_directory: Some("/mnt/d/repo".into()),
                    missing: false,
                },
                Worktree {
                    slug: "other".into(),
                    directory: "D:/other".into(),
                    branch: None,
                    head: None,
                    service_directory: None,
                    missing: false,
                },
            ],
        }),
    );
    ui
}

#[test]
fn the_linked_conversation_owns_the_git_target_without_a_root_fallback() {
    let mut ui = ui();
    let mut backend = ui.backend.clone();
    backend.session = "linked-session".into();
    assert!(ui.bind_placed(&backend, Some("other")));
    assert_eq!(ui.tree().unwrap().slug, "other");
    assert!(ui.bind(&backend));
    assert_eq!(ui.tree().unwrap().slug, "other");
    let mut inventory = ui.inventory.clone().unwrap();
    inventory.trees.retain(|tree| tree.slug == "root");
    ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
    assert!(ui.tree().is_none());
    assert!(!ui.can_mutate());
}

#[test]
fn the_index_is_read_only_until_a_conversation_can_observe_it() {
    let mut ui = ui();
    ui.online = true;
    ui.shown = true;
    ui.mode = Mode::Changes;
    ui.requests.slot_mut(Lane::Worktrees).dirty = false;
    ui.requests.slot_mut(Lane::Preferences).dirty = false;
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    statuses(&mut ui, vec![change("a.txt", true, false, 1)]);
    ui.changes.draft = TextEdit::new("commit");
    assert!(ui.can_commit());
    ui.backend.session.clear();
    assert!(!ui.can_change_index() && !ui.can_commit());
}

#[test]
fn commit_waits_for_index_display_to_catch_up_after_filesystem_changes() {
    let mut ui = ui();
    ui.online = true;
    ui.shown = true;
    ui.mode = Mode::Changes;
    for lane in [Lane::Worktrees, Lane::Preferences, Lane::Changes] {
        ui.requests.slot_mut(lane).dirty = false;
    }
    statuses(&mut ui, vec![change("a.txt", true, false, 1)]);
    ui.changes.draft = TextEdit::new("commit");
    assert!(ui.can_commit());
    ui.filesystem_hint();
    assert!(!ui.can_commit());
    ui.passive_due = None;
    ui.requests.slot_mut(Lane::Changes).dirty = true;
    assert!(!ui.can_commit());
    statuses(
        &mut ui,
        vec![
            change("a.txt", true, false, 1),
            change("b.txt", true, false, 1),
        ],
    );
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    assert!(ui.can_commit());
    ui.shown = false;
    ui.activate(false);
    ui.activate(true);
    ui.shown = true;
    assert!(!ui.can_commit());
}

#[test]
fn status_moves_an_open_file_without_opening_sidebar_selection() {
    let mut ui = ui();
    let unstaged = change("file.rs", false, false, 2);
    statuses(&mut ui, vec![unstaged]);
    let id = ui.changes.current.clone().unwrap();
    assert!(!ui.has_preview());
    ui.replace_preview(Preview::local(ui.changes.find(&id).unwrap()));
    let mut staged = change("file.rs", true, false, 2);
    staged.unstaged = None;
    statuses(&mut ui, vec![staged]);
    assert_eq!(
        ui.preview.as_ref().unwrap().source,
        Source::Local(Section::Staged)
    );
    statuses(&mut ui, vec![]);
    assert!(!ui.has_preview());
}

#[test]
fn history_refresh_retains_pinned_pages_until_head_changes() {
    fn page(head: &str, commits: &[&str], has_more: bool) -> Page {
        Page {
            head: Some(head.into()),
            has_more,
            commits: commits
                .iter()
                .map(|id| Commit {
                    id: (*id).into(),
                    subject: String::new(),
                    author: String::new(),
                    date: String::new(),
                    refs: String::new(),
                })
                .collect(),
        }
    }
    let mut ui = ui();
    ui.accept(
        Lane::History,
        Value::History(page("a", &["a"], true), false),
    );
    ui.accept(
        Lane::History,
        Value::History(page("a", &["b"], false), true),
    );
    ui.accept(
        Lane::History,
        Value::History(page("a", &["a"], true), false),
    );
    assert_eq!(
        ui.history.page.as_ref().unwrap(),
        &page("a", &["a", "b"], false)
    );
    ui.accept(
        Lane::History,
        Value::History(page("a", &["b"], false), true),
    );
    assert!(ui.requests.slot(Lane::History).error.is_some());
    ui.accept(
        Lane::History,
        Value::History(page("new", &["new", "a"], true), false),
    );
    assert_eq!(
        ui.history.page.as_ref().unwrap(),
        &page("new", &["new", "a"], true)
    );
}

#[test]
fn only_live_history_with_a_different_head_revokes_index_authority() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.shown = true;
    ui.online = true;
    let rows = vec![change("a", true, false, 1)];
    statuses(&mut ui, rows.clone());
    ui.changes.draft = TextEdit::new("draft");
    assert!(ui.can_commit());
    let checked = ui.index_revision;
    let page = |head| Page {
        head,
        commits: vec![],
        has_more: true,
    };

    ui.mode = Mode::History;
    let current = ui.tree().unwrap().head.clone();
    ui.accept(Lane::History, Value::History(page(current), false));
    assert_eq!(ui.index_revision, checked);
    assert!(!ui.requests.slot(Lane::Worktrees).dirty);

    let previous = Some("b".repeat(40));
    ui.history.page = Some(page(previous.clone()));
    ui.accept(Lane::History, Value::History(page(previous.clone()), true));
    assert_eq!(ui.index_revision, checked);
    assert!(!ui.requests.slot(Lane::Worktrees).dirty);

    ui.accept(Lane::History, Value::History(page(previous.clone()), false));
    assert_eq!(ui.history.page.as_ref().unwrap().head, previous);
    assert!(ui.requests.slot(Lane::Worktrees).dirty);
    assert!(ui.requests.slot(Lane::Changes).dirty);

    ui.mode = Mode::Changes;
    let mut inventory = ui.inventory.clone().unwrap();
    inventory.trees[0].head = previous;
    ui.requests.slot_mut(Lane::Worktrees).dirty = false;
    ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
    ui.accept(Lane::Changes, Value::Changes(rows.clone(), None, checked));
    assert!(!ui.can_commit());
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    statuses(&mut ui, rows);
    assert!(ui.can_commit());
}

#[test]
fn mutation_settlement_preserves_edits_and_cannot_clear_another_checkout() {
    let mut ui = ui();
    let epoch = ui.tree_epoch;
    let original = ui.tree().unwrap().clone();
    ui.changes.draft = TextEdit::new("different");
    ui.settle_mutation(
        epoch,
        &original,
        Mutation::Commit {
            draft: "old".into(),
            message: "old".into(),
        },
        Ok(()),
    );
    assert_eq!(ui.changes.draft.text, "different");
    assert!(ui.take_files_invalidation());
    ui.select_tree("other".into());
    ui.changes.draft = TextEdit::new("old");
    ui.settle_mutation(
        epoch,
        &original,
        Mutation::Commit {
            draft: "old".into(),
            message: "old".into(),
        },
        Ok(()),
    );
    assert_eq!(ui.changes.draft.text, "old");
    assert!(ui.mutation_message.is_none());
    ui.select_tree("root".into());
    ui.changes.draft = TextEdit::new("old");
    ui.settle_mutation(
        epoch,
        &original,
        Mutation::Commit {
            draft: "old".into(),
            message: "old".into(),
        },
        Ok(()),
    );
    assert_eq!(ui.changes.draft.text, "old");
}

#[test]
fn no_second_commit_until_status_reconciles_and_possible_new_selection_survives() {
    let mut ui = ui();
    let tree = ui.tree().unwrap().clone();
    ui.mode = Mode::Changes;
    ui.shown = true;
    ui.online = true;
    let changes = vec![change("a", true, false, 1), change("b", false, false, 0)];
    statuses(&mut ui, changes.clone());
    ui.changes.draft = TextEdit::new("commit draft");
    assert!(ui.can_commit());
    ui.settle_mutation(
        ui.tree_epoch,
        &tree,
        Mutation::Commit {
            draft: "commit draft".into(),
            message: "commit draft".into(),
        },
        Err("connection lost after dispatch".into()),
    );
    assert!(!ui.can_commit());
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    ui.requests.slot_mut(Lane::Changes).error = Some("read failed".into());
    assert!(!ui.can_commit());
    ui.requests.slot_mut(Lane::Changes).error = None;
    statuses(&mut ui, changes);
    assert!(ui.can_commit());
    let id = Id {
        section: Section::Unstaged,
        path: "b".into(),
    };
    let selection_revision = ui.changes.selection_revision;
    ui.changes.select(id.clone(), true, false);
    ui.settle_mutation(
        ui.tree_epoch,
        &tree,
        Mutation::Paths(Section::Staged, vec!["a".into()], selection_revision),
        Ok(()),
    );
    assert!(ui.changes.bulk.contains(&id));
    ui.settle_mutation(
        ui.tree_epoch,
        &tree,
        Mutation::Paths(
            Section::Staged,
            vec!["a".into()],
            ui.changes.selection_revision,
        ),
        Ok(()),
    );
    assert!(ui.changes.bulk.is_empty());
}

#[test]
fn changing_session_closes_preview_and_resets_manually_selected_worktree() {
    let mut ui = ui();
    ui.select_tree("other".into());
    ui.replace_preview(Preview {
        path: "a".into(),
        source: Source::Commit {
            id: "a".into(),
            subject: "a".into(),
        },
        original_path: None,
    });
    let mut backend = ui.backend.clone();
    backend.session = "new-session".into();
    assert!(ui.bind(&backend));
    assert!(!ui.has_preview());
    assert_eq!(ui.tree().unwrap().slug, "root");
}

#[test]
fn action_focus_reaches_same_file_in_its_new_section() {
    let mut ui = ui();
    let mut row = change("a-container", false, false, 2);
    let neighbor = change("a", true, false, 0);
    statuses(&mut ui, vec![neighbor.clone(), row.clone()]);
    let id = ui.changes.current.clone().unwrap();
    let focus = ui
        .changes
        .focus_order(Some(&id.action_key("stage")))
        .unwrap();
    row.staged = row.unstaged.take();
    statuses(&mut ui, vec![neighbor, row]);
    assert_ne!(
        Id {
            section: Section::Staged,
            path: "a".into()
        }
        .action_key("container"),
        Id {
            section: Section::Staged,
            path: "a-container".into()
        }
        .key()
    );
    assert_eq!(
        ui.changes.focus_after(focus.clone(), true),
        Some(
            Id {
                section: Section::Staged,
                path: id.path
            }
            .key()
        )
    );
    assert_eq!(
        ui.changes.focus_after(focus, false).as_deref(),
        Some("git-section-unstaged")
    );
}

#[test]
fn files_mode_uses_only_the_persisted_source_values() {
    for mode in [Mode::Workspace, Mode::Changes, Mode::History] {
        assert!(Mode::restore(mode.key()).is_some_and(|saved| saved == mode));
    }
    assert!(Mode::restore("other").is_none());
}

#[test]
fn status_before_a_reader_gesture_cannot_close_its_new_target() {
    let mut ui = ui();
    statuses(&mut ui, vec![change("a", false, false, 1)]);
    let revision = ui.preview_revision;
    let row = ui
        .changes
        .find(ui.changes.current.as_ref().unwrap())
        .unwrap();
    ui.replace_preview(Preview::local(row));
    ui.accept(
        Lane::Changes,
        Value::Changes(vec![], Some(revision), ui.index_revision),
    );
    assert!(ui.has_preview());
    statuses(&mut ui, vec![]);
    assert!(!ui.has_preview());
}

#[test]
fn passive_status_moves_a_reader_opened_during_the_read() {
    let mut ui = ui();
    let mut row = change("a", false, false, 1);
    statuses(&mut ui, vec![row.clone()]);
    let request_revision = ui.preview_revision;
    let selected = ui
        .changes
        .find(ui.changes.current.as_ref().unwrap())
        .unwrap();
    ui.replace_preview(Preview::local(selected));
    assert_ne!(ui.preview_revision, request_revision);
    row.staged = row.unstaged.take();
    ui.accept(
        Lane::Changes,
        Value::Changes(vec![row], None, ui.index_revision),
    );
    assert_eq!(
        ui.preview.as_ref().unwrap().source,
        Source::Local(Section::Staged)
    );
}

#[test]
fn whitespace_preference_does_not_close_a_diff_using_the_cached_status() {
    let mut ui = ui();
    ui.hide_whitespace = false;
    statuses(&mut ui, vec![change("a", false, true, 1)]);
    let selected = ui
        .changes
        .find(ui.changes.current.as_ref().unwrap())
        .unwrap();
    ui.replace_preview(Preview::local(selected));
    ui.set_hide_whitespace(true);
    assert_eq!(ui.changes.count(), 0);
    assert!(ui.has_preview());
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    statuses(&mut ui, vec![change("a", false, false, 1)]);
    assert!(ui.has_preview());
}

#[test]
fn branch_hint_holds_index_actions_until_the_new_label_is_read() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.shown = true;
    ui.online = true;
    statuses(&mut ui, vec![change("a", true, false, 1)]);
    ui.changes.draft = TextEdit::new("a");
    assert!(ui.can_commit());
    let row = ui
        .changes
        .find(ui.changes.current.as_ref().unwrap())
        .unwrap();
    ui.replace_preview(Preview::local(row));
    ui.shown = false;
    assert!(!ui.requests.slot(Lane::Preview).dirty);
    ui.event(&WorkspaceEvent::WorktreesChanged {
        workspace_id: "workspace".into(),
    });
    assert!(ui.requests.slot(Lane::Preview).dirty);
    ui.shown = true;
    assert!(!ui.can_commit());
    let mut inventory = ui.inventory.clone().unwrap();
    inventory.trees[0].branch = Some("feature".into());
    ui.requests.slot_mut(Lane::Worktrees).dirty = false;
    ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
    assert_eq!(ui.tree().unwrap().branch.as_deref(), Some("feature"));
    assert!(!ui.can_commit());
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    statuses(&mut ui, vec![change("a", true, false, 1)]);
    assert!(ui.can_commit());
}

#[test]
fn refresh_revalidates_the_checkout_even_when_the_inventory_was_cached() {
    let mut ui = ui();
    ui.select_tree("other".into());
    ui.replace_preview(Preview {
        path: "a".into(),
        source: Source::Commit {
            id: "a".into(),
            subject: "a".into(),
        },
        original_path: None,
    });
    let mut inventory = ui.inventory.clone().unwrap();
    inventory.trees.retain(|tree| tree.slug == "root");
    ui.mode = Mode::History;
    ui.refresh();
    assert!(ui.requests.slot(Lane::Worktrees).dirty);
    ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
    assert_eq!(ui.tree().unwrap().slug, "root");
    assert!(!ui.has_preview());
}

#[test]
fn refresh_in_every_mode_requires_status_even_when_the_checkout_is_unchanged() {
    for mode in [Mode::Workspace, Mode::History, Mode::Changes] {
        let mut ui = ui();
        ui.mode = Mode::Changes;
        let before = vec![change("a", true, false, 1)];
        statuses(&mut ui, before.clone());
        ui.changes.draft = TextEdit::new("draft");
        ui.shown = true;
        ui.online = true;
        assert!(ui.can_commit());

        let old_revision = ui.index_revision;
        let inventory = ui.inventory.clone().unwrap();
        // Manually settle the reads without dispatching HTTP.
        ui.online = false;
        ui.set_mode(mode);
        ui.refresh();
        ui.requests.slot_mut(Lane::Worktrees).dirty = false;
        ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
        ui.set_mode(Mode::Changes);
        ui.online = true;
        assert!(ui.requests.slot(Lane::Changes).dirty);
        assert!(!ui.can_commit());
        ui.accept(Lane::Changes, Value::Changes(before, None, old_revision));
        assert!(!ui.can_commit());

        ui.requests.slot_mut(Lane::Changes).dirty = false;
        statuses(&mut ui, vec![change("b", true, false, 1)]);
        assert_eq!(
            ui.changes.section(Section::Staged).next().unwrap().id.path,
            "b"
        );
        assert!(ui.can_commit());
    }
}

#[test]
fn refreshed_inventory_detects_a_branch_switch_without_a_stream_hint() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.online = true;
    ui.shown = true;
    statuses(&mut ui, vec![change("a", true, false, 1)]);
    ui.changes.draft = TextEdit::new("a");
    assert!(ui.can_commit());
    let row = ui
        .changes
        .find(ui.changes.current.as_ref().unwrap())
        .unwrap();
    ui.replace_preview(Preview::local(row));
    let mut inventory = ui.inventory.clone().unwrap();
    inventory.trees[0].branch = Some("new".into());
    ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
    assert!(ui.has_preview());
    assert!(ui.requests.slot(Lane::Preview).dirty);
    assert!(!ui.can_commit());
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    statuses(&mut ui, vec![change("a", true, false, 1)]);
    assert!(ui.can_commit());
}

#[test]
fn inventory_head_change_on_the_same_branch_invalidates_checkout_content() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.shown = true;
    ui.online = true;
    let rows = vec![change("a", true, false, 1)];
    statuses(&mut ui, rows.clone());
    ui.changes.draft = TextEdit::new("draft");
    assert!(ui.can_commit());
    let row = ui.changes.section(Section::Staged).next().unwrap();
    ui.replace_preview(Preview::local(row));

    let old_revision = ui.index_revision;
    let mut inventory = ui.inventory.clone().unwrap();
    let head = "b".repeat(40);
    inventory.trees[0].head = Some(head.clone());
    ui.accept(Lane::Worktrees, Value::Worktrees(inventory));
    assert_eq!(ui.tree().unwrap().head.as_deref(), Some(head.as_str()));
    assert_eq!(ui.tree().unwrap().branch.as_deref(), Some("main"));
    assert!(ui.has_preview());
    assert!(ui.requests.slot(Lane::Preview).dirty);
    assert!(ui.requests.slot(Lane::History).dirty);
    ui.accept(
        Lane::Changes,
        Value::Changes(rows.clone(), None, old_revision),
    );
    assert!(!ui.can_commit());
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    statuses(&mut ui, rows);
    assert!(ui.can_commit());
}

#[test]
fn invalidated_status_cannot_remove_the_diff_before_its_trailing_read() {
    let mut ui = ui();
    let row = change("a", false, false, 1);
    statuses(&mut ui, vec![row.clone()]);
    let selected = ui
        .changes
        .find(ui.changes.current.as_ref().unwrap())
        .unwrap();
    ui.replace_preview(Preview::local(selected));
    ui.filesystem_hint();
    statuses(&mut ui, vec![]);
    assert!(ui.has_preview());
    assert_eq!(ui.changes.count(), 0);
    ui.passive_due = None;
    statuses(&mut ui, vec![row]);
    assert!(ui.has_preview());
}

#[test]
fn repeated_file_hints_keep_rows_and_path_actions_but_suspend_commit() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.shown = true;
    ui.online = true;
    ui.changes.draft = TextEdit::new("a");
    let hint = WorkspaceEvent::FilesChanged {
        workspace_id: "workspace".into(),
        changes: vec![codenomad_client::transport::DirectoryChange {
            directory: "D:/repo".into(),
            path: ".".into(),
        }],
    };
    for step in 1..=4 {
        ui.clock = f64::from(step - 1);
        ui.event(&hint);
        statuses(
            &mut ui,
            (0..step)
                .map(|n| change(n.to_string(), true, false, 1))
                .collect(),
        );
        assert_eq!(ui.changes.count(), step as usize);
        assert!(ui.can_change_index());
        assert!(!ui.can_commit());
    }
}

#[test]
fn retrying_a_failed_passive_status_cannot_rearm_the_old_index() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.shown = true;
    ui.online = true;
    ui.changes.draft = TextEdit::new("a");
    let rows = vec![change("a", true, false, 1)];
    statuses(&mut ui, rows.clone());
    assert!(ui.can_commit());
    ui.read_failed(Lane::Changes, "status unavailable".into());
    ui.requests.slot_mut(Lane::Changes).error = None;
    assert!(!ui.can_commit());
    statuses(&mut ui, rows);
    assert!(ui.can_commit());
}

#[test]
fn stage_or_unstage_a_rename_requires_both_paths_but_a_copy_requires_one() {
    let mut changes = Changes::default();
    let mut rename = change("new", true, false, 1);
    rename.original_path = Some("old".into());
    rename.staged.as_mut().unwrap().kind = "renamed".into();
    let mut copy = change("copy", true, false, 1);
    copy.original_path = Some("source".into());
    copy.staged.as_mut().unwrap().kind = "copied".into();
    changes.replace(vec![rename, copy], false);
    assert_eq!(
        changes.paths(&Id {
            section: Section::Staged,
            path: "new".into()
        }),
        ["old", "new"]
    );
    assert_eq!(
        changes.paths(&Id {
            section: Section::Staged,
            path: "copy".into()
        }),
        ["copy"]
    );
}

#[test]
fn surviving_preview_is_pinned_again_when_its_row_returns() {
    let mut ui = ui();
    let entries: Vec<_> = (0..=200)
        .map(|n| change(format!("{n:04}"), false, false, u64::from(n == 200)))
        .collect();
    statuses(&mut ui, entries.clone());
    let last = ui.changes.current.clone().unwrap();
    let row = ui.changes.find(&last).unwrap();
    ui.replace_preview(Preview::local(row));
    let first = ui
        .changes
        .visible(Section::Unstaged)
        .next()
        .unwrap()
        .id
        .clone();
    ui.changes.select(first, false, false);
    ui.filesystem_hint();
    statuses(&mut ui, entries[..200].to_vec());
    assert!(ui.has_preview());
    ui.passive_due = None;
    statuses(&mut ui, entries);
    assert!(
        ui.changes
            .visible(Section::Unstaged)
            .any(|row| row.id == last)
    );
}

#[test]
fn switching_modes_and_refresh_owe_failed_reads_but_stale_preferences_cannot_stage() {
    let mut ui = ui();
    ui.mode = Mode::Changes;
    ui.online = true;
    ui.shown = true;
    statuses(&mut ui, vec![change("a", true, false, 1)]);
    ui.changes.draft = TextEdit::new("a");
    assert!(ui.can_commit());
    ui.requests.slot_mut(Lane::Preferences).error = Some("preferences unreadable".into());
    assert!(!ui.can_commit());
    ui.online = false;
    ui.refresh();
    assert!(ui.requests.slot(Lane::Preferences).dirty);
    ui.requests.slot_mut(Lane::Changes).dirty = false;
    ui.requests.slot_mut(Lane::Changes).error = Some("status unreadable".into());
    ui.set_mode(Mode::History);
    assert!(!ui.requests.slot(Lane::Changes).dirty);
    ui.set_mode(Mode::Changes);
    assert!(ui.requests.slot(Lane::Changes).dirty);
}

#[test]
fn diff_preferences_follow_the_window_when_an_occurrence_is_restored() {
    let mut state = crate::init();
    state.git.owner = Some(ui());
    let previous = Binding::take(&mut state.git);
    let preferences = DiffPreferences {
        split: true,
        full: true,
        wrap: false,
    };
    set_diff_preferences(&mut state, preferences);
    state.git = previous;
    assert!(diff_preferences(&state) == preferences);
}
