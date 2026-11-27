use super::*;
use codenomad_client::git::{Change, Commit, Status};
use codenomad_client::{git::Section, transport::WorkspaceEvent};

#[test]
fn history_uses_the_inventory_label_and_falls_back_to_branch_then_slug() {
    let mut state = crate::init();
    let mut owner = ui();
    owner.inventory = Some(Worktrees {
        repository: Repository::Git,
        trees: vec![
            Worktree {
                slug: "owned-review".into(),
                label: None,
                directory: "D:/repo/review".into(),
                service_directory: None,
                branch: Some("review/feature".into()),
                head: Some("not-a-label".into()),
                missing: false,
            },
            Worktree {
                slug: "detached".into(),
                label: Some("Review checkout".into()),
                directory: "D:/repo/detached".into(),
                service_directory: None,
                branch: None,
                head: Some("not-a-label".into()),
                missing: false,
            },
        ],
    });
    state.git.owner = Some(owner);
    assert_eq!(
        history_worktree(&state, "owned-review"),
        Some("review/feature")
    );
    assert_eq!(
        history_worktree(&state, "detached"),
        Some("Review checkout")
    );
    state
        .git
        .owner
        .as_mut()
        .unwrap()
        .inventory
        .as_mut()
        .unwrap()
        .trees[1]
        .label = None;
    assert_eq!(history_worktree(&state, "detached"), Some("detached"));
    assert_eq!(history_worktree(&state, "foreign"), None);
}

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
        session_directory: None,
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
                    label: None,
                    directory: "D:/repo".into(),
                    branch: Some("main".into()),
                    head: Some("a".repeat(40)),
                    service_directory: Some("/mnt/d/repo".into()),
                    missing: false,
                },
                Worktree {
                    slug: "other".into(),
                    label: None,
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
fn late_worktree_inventory_syncs_the_tree_without_closing_a_session_link() {
    for native in ["D:/other", "/mnt/d/other"] {
        let mut s = crate::init();
        let mut owner = ui();
        let mut inventory = owner.inventory.take().unwrap();
        inventory
            .trees
            .iter_mut()
            .find(|tree| tree.slug == "other")
            .unwrap()
            .service_directory = Some("/mnt/d/other".into());
        let mut backend = owner.backend.clone();
        backend.session_directory = Some(native.into());
        assert!(owner.bind_placed(&backend, Some("other")));
        s.files = Some(crate::files::Ui::new(
            backend.clone(),
            "D:/repo".into(),
            s.reads.clone(),
            s.wake.clone(),
        ));
        s.git.owner = Some(owner);
        let (_, directory) = super::file_link_scope(&s).unwrap();
        assert_eq!(directory, native);
        assert!(crate::files::open_session_path(
            &mut s,
            &backend,
            native.into(),
            "notes.txt".into()
        ));
        let scope = s.files.as_ref().unwrap().document.scope();

        let publish = |s: &mut crate::State, inventory| {
            s.git
                .owner
                .as_mut()
                .unwrap()
                .accept(Lane::Worktrees, Value::Worktrees(inventory));
            super::binding::sync_files(s);
        };
        publish(&mut s, inventory.clone());
        let files = s.files.as_ref().unwrap();
        assert_eq!(files.tree.directory(), "D:/other");
        assert_eq!(
            files
                .reader
                .target()
                .map(|target| target.directory.as_str()),
            Some(native)
        );
        assert_eq!(
            files.document.scope(),
            scope,
            "tree sync must not reopen the reader"
        );
        assert_eq!(super::file_link_scope(&s).unwrap().1, "D:/other");

        inventory.trees.retain(|tree| tree.slug == "root");
        publish(&mut s, inventory);
        assert!(
            !crate::files::has_preview(&s),
            "authoritative removal still closes the reader"
        );
    }
}

#[test]
#[cfg(feature = "test-support")]
fn removing_a_session_worktree_closes_the_hidden_workspace_reader_without_forgetting_edits() {
    let mut s = crate::init();
    let mut owner = ui();
    let backend = owner.backend.clone();
    assert!(owner.bind_placed(&backend, Some("other")));
    let linked = owner.tree().unwrap().directory.clone();
    let current = owner.inventory.clone().unwrap();
    let mut files = crate::files::Ui::new(
        backend.clone(),
        linked.clone(),
        s.reads.clone(),
        s.wake.clone(),
    )
    .with_documents(s.documents.clone(), "tab-0".into());
    files.online(true);
    files.open("draft.txt".into());
    files.reader.scene(Ok(codenomad_client::files::Preview {
        workspace_id: backend.workspace.clone(),
        path: "draft.txt".into(),
        bytes: b"original".to_vec(),
        version: Some("v1".into()),
    }));
    files.document.poll(&mut files.reader);
    let scope = files.document.scope();
    files
        .document
        .input(scope)
        .replace_text("unsaved linked draft");
    files.document.changed(scope);
    assert!(s.documents.has_tab_edits("tab-0"));
    s.files = Some(files);
    s.git.owner = Some(owner);

    let publish = |s: &mut crate::State, list: Worktrees| {
        s.git
            .owner
            .as_mut()
            .unwrap()
            .accept(Lane::Worktrees, Value::Worktrees(list));
        super::binding::sync_files(s);
    };
    publish(
        &mut s,
        Worktrees {
            trees: vec![],
            ..current.clone()
        },
    );
    assert!(
        crate::files::has_preview(&s),
        "empty inventory does not establish removal"
    );
    publish(&mut s, current.clone());
    assert!(
        crate::files::has_preview(&s),
        "an unchanged inventory keeps reading"
    );

    let mut removed = current;
    removed.trees.retain(|tree| tree.slug == "root");
    publish(&mut s, removed);
    assert!(!crate::files::has_preview(&s));
    assert!(
        s.git.owner.as_ref().unwrap().tree().is_none(),
        "inventory absence does not relabel a session"
    );
    assert!(s.documents.has_tab_edits("tab-0"));

    super::connected_placed(&mut s, &backend, "root");
    assert_eq!(s.files.as_ref().unwrap().tree.directory(), "D:/repo");
    assert!(!crate::files::has_preview(&s), "no implicit root-file read");
    let files = s.files.as_mut().unwrap();
    files.browse(linked);
    files.open("draft.txt".into());
    assert_eq!(files.document.edit().text, "unsaved linked draft");
}

#[test]
fn browsing_another_checkout_does_not_change_the_session_placement() {
    let mut s = crate::init();
    let mut owner = ui();
    owner.select_tree("other".into());
    assert_eq!(owner.tree().unwrap().slug, "other");
    s.git.owner = Some(owner);
    assert_eq!(placement(&s), Some("root"));
    assert!(placeable(&s, "other"));
    assert!(!placeable(&s, "root"));
    assert!(!placeable(&s, "unregistered"));
    let owner = s.git.owner.as_mut().unwrap();
    let confirmed = owner.backend.clone();
    assert!(owner.bind_placed(&confirmed, Some("other")));
    assert_eq!(placement(&s), Some("other"));
}

#[test]
fn reads_cannot_release_a_placement_without_a_terminal_reply() {
    let mut s = crate::init();
    let owner = ui();
    let base = owner.backend.base.clone();
    let members = std::collections::HashSet::from([owner.backend.session.clone()]);
    s.git.owner = Some(owner);
    let lost = PlacementHold {
        members: members.clone(),
        answered: false,
    };
    hold_placement(&mut s, lost.clone());
    release_placement(&mut s, &base, &lost);
    assert!(placement_unconfirmed(&s));
    let settled = PlacementHold {
        members,
        answered: true,
    };
    release_placement(&mut s, &base, &settled);
    assert!(placement_unconfirmed(&s));
    hold_placement(&mut s, settled.clone());
    release_placement(&mut s, &base, &settled);
    assert!(!placement_unconfirmed(&s));
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
fn a_git_receipt_after_reattachment_does_not_notify_on_the_new_connection() {
    use crate::files::test_http::{Http, wait};
    crate::platform::block_on(async {
        let http = Http::new().await;
        let mut ui = ui();
        let (wake, settled) = codenomad_client::bounded(1);
        ui.backend = http.backend.clone();
        ui.requests = Requests::new(
            ui.backend.clone(),
            Reads::default(),
            std::sync::Arc::new(move || {
                let _ = wake.try_send(());
            }),
        );
        let tree = ui.tree().unwrap().clone();
        ui.requests.mutate(
            ui.tree_epoch,
            tree,
            Mutation::Commit {
                message: "fixture".into(),
                draft: "fixture".into(),
            },
        );
        let request = http.accept().await;
        assert!(
            request.header.starts_with("POST ") && request.header.contains("/git-commit HTTP/")
        );
        ui.backend.client = codenomad_client::http::Http::new().unwrap();
        ui.requests.renew(ui.backend.clone());
        request.reply(204, serde_json::Value::Null).await;
        wait(settled.recv()).await.unwrap();
        assert!(ui.poll_results());
        assert!(ui.requests.mutation.is_none());
        assert!(ui.take_files_invalidation());
        assert!(ui.mutation_notice.is_none());
    });
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
    assert!(
        ui.mutation_notice
            .take()
            .is_some_and(|(success, _)| success)
    );
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
    assert!(ui.mutation_notice.is_none());
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

    // Switching to another session (including session-new) preserves a non-empty commit draft
    // in a manually selected checkout instead of resetting Changes.
    ui.select_tree("other".into());
    ui.changes.draft = rune::edit::TextEdit::new("wip commit");
    backend.session = "newer-session".into();
    assert!(ui.bind(&backend));
    assert_eq!(ui.tree().unwrap().slug, "other");
    assert_eq!(ui.changes.draft.text, "wip commit");
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

#[test]
fn closing_git_preview_restores_scrolled_up_reading_position() {
    use codenomad_client::git::Diff;
    use rune::{Env, ImageCache, Key, KeyEvent, Mods, Runtime};
    use std::sync::Arc;

    let mut state = crate::init();
    crate::gallery::shell::fixture(&mut state);
    let project = state.screen.launcher().unwrap().project.clone().unwrap();
    state.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::opened(&mut state, &project);
    crate::workspace::set_right_panel_tab(&mut state, crate::workspace::RightPanelTab::Files);
    state.messages = (0..32)
        .map(|i| {
            Arc::new(crate::Message {
                id: format!("git-msg-{i:02}"),
                role: if i % 2 == 0 { "user" } else { "assistant" }.into(),
                completed: true,
                body: format!(
                    "Git reading passage {i:02} — enough prose to span multiple lines in the transcript."
                ),
                parts: Vec::new(),
                usage: None,
            })
        })
        .collect();
    let mut git_ui = ui();
    git_ui.online = true;
    git_ui.shown = true;
    git_ui.mode = Mode::Changes;
    statuses(&mut git_ui, vec![change("src/lib.rs", false, false, 1)]);
    let preview_target = Preview::local(
        git_ui
            .changes
            .find(git_ui.changes.current.as_ref().unwrap())
            .unwrap(),
    );
    state.git.owner = Some(git_ui);

    let mut rt = Runtime::new(state, crate::view, (1400.0, 520.0), Env::new(false, 1.0));
    rt.on_key = Some(crate::shell::keys);
    for _ in 0..30 {
        rt.frame(0.02);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("git-msg-14", 12.0);
    });
    for _ in 0..30 {
        rt.frame(0.02);
    }
    let anchor_offset = |rt: &Runtime<crate::State>| {
        let elements = rt.elements();
        let hist = elements
            .iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .expect("history mounted");
        let msg = elements
            .iter()
            .find(|e| e.key.as_deref() == Some("git-msg-14"))
            .expect("git-msg-14 mounted");
        msg.rect[1] - hist.rect[1]
    };
    let before = anchor_offset(&rt);
    assert!(
        (before - 12.0).abs() <= 1.0,
        "expected git-msg-14 anchored at +12px, got {before}"
    );

    #[derive(Clone, Copy, Debug)]
    enum CloseMode {
        Escape,
        Button,
        Worktree,
        BackgroundNotice,
        PendingResumeEscape,
        WorkspaceStopped,
    }
    for close_mode in [
        CloseMode::Escape,
        CloseMode::PendingResumeEscape,
        CloseMode::Button,
        CloseMode::BackgroundNotice,
        CloseMode::Worktree,
        CloseMode::WorkspaceStopped,
    ] {
        let target = preview_target.clone();
        rt.update(move |s, _| {
            let cache = ImageCache::new(s.wake.clone());
            let ui = s.git.owner.as_mut().unwrap();
            ui.replace_preview(target.clone());
            let _ = ui.reader.replace(
                Diff::Text {
                    before: "fn a() {}\n".into(),
                    after: "fn a() { 1 }\n".into(),
                },
                "src/lib.rs",
                true,
                &cache,
            );
        });
        for _ in 0..20 {
            rt.frame(0.02);
        }
        assert!(has_preview(&rt.state));
        assert!(
            rt.find("history").is_none(),
            "Git diff preview must unmount transcript history"
        );
        match close_mode {
            CloseMode::Escape => {
                let esc = KeyEvent {
                    key: Key::Escape,
                    mods: Mods::default(),
                };
                rt.key(esc.clone());
                rt.key_up(esc);
            }
            CloseMode::Button => {
                let (x, y) = rt.find("git-diff-close").expect("git-diff-close button");
                rt.pointer_down(x, y);
                rt.pointer_up(x, y);
            }
            CloseMode::Worktree => {
                if rt.find("git-worktree-trigger").is_none() {
                    if let Some((rx, ry)) = rt.find("right-panel-tab-1") {
                        rt.pointer_down(rx, ry);
                        rt.pointer_up(rx, ry);
                    } else {
                        let (rx, ry) = rt.find("right-panel-toggle").expect("right-panel-toggle");
                        rt.pointer_down(rx, ry);
                        rt.pointer_up(rx, ry);
                        for _ in 0..20 {
                            rt.frame(0.02);
                        }
                        if let Some((tx, ty)) = rt.find("right-panel-tab-1") {
                            rt.pointer_down(tx, ty);
                            rt.pointer_up(tx, ty);
                        }
                    }
                    for _ in 0..20 {
                        rt.frame(0.02);
                    }
                }
                let (wx, wy) = rt
                    .find("git-worktree-trigger")
                    .expect("git-worktree-trigger picker button");
                rt.pointer_down(wx, wy);
                rt.pointer_up(wx, wy);
                for _ in 0..15 {
                    rt.frame(0.02);
                }
                let option = rt
                    .elements()
                    .into_iter()
                    .find(|e| {
                        e.role == "option"
                            && e.label.as_deref().is_some_and(|l| l.starts_with("other"))
                    })
                    .expect("other worktree option");
                let (ox, oy) = (
                    option.rect[0] + option.rect[2] / 2.0,
                    option.rect[1] + option.rect[3] / 2.0,
                );
                rt.pointer_down(ox, oy);
                rt.pointer_up(ox, oy);
            }
            CloseMode::BackgroundNotice => {
                rt.update(|s, tx| {
                    let ui = s.git.owner.as_mut().unwrap();
                    let rev = ui.index_revision;
                    ui.requests
                        .deliver_read(Lane::Changes, Ok(Value::Changes(vec![], None, rev)));
                    assert!(poll_notices(s, tx));
                });
            }
            CloseMode::PendingResumeEscape => {
                let (reader, _lane) = crate::chat::reader::Reader::open();
                rt.update(|s, tx| {
                    s.reader = Some(reader);
                    crate::chat::suspend(s);
                    crate::chat::resume(s, tx);
                });
                let esc = KeyEvent {
                    key: Key::Escape,
                    mods: Mods::default(),
                };
                rt.key(esc.clone());
                rt.key_up(esc);
            }
            CloseMode::WorkspaceStopped => {
                rt.update(|s, tx| {
                    let workspace_id = s.git.owner.as_ref().unwrap().backend.workspace.clone();
                    super::event(
                        s,
                        &WorkspaceEvent::Stopped {
                            workspace_id,
                            deleted: false,
                            temporary_retained: false,
                        },
                    );
                    assert!(super::poll(s, 1.0, tx));
                });
            }
        }
        for _ in 0..40 {
            rt.frame(0.02);
        }
        if matches!(close_mode, CloseMode::PendingResumeEscape) {
            rt.state.reader = None;
        }
        assert!(
            !has_preview(&rt.state),
            "preview must close for {close_mode:?}"
        );
        if matches!(close_mode, CloseMode::Worktree) {
            assert_eq!(rt.state.git.owner.as_ref().unwrap().slug, "other");
        }
        assert_eq!(
            rt.scroll_at_bottom("history"),
            Some(false),
            "closing Git preview ({close_mode:?}) must not snap back to bottom"
        );
        let after = anchor_offset(&rt);
        assert!(
            (after - before).abs() <= 1.0,
            "closing Git preview ({close_mode:?}) must preserve reading anchor: before={before}, after={after}"
        );
    }
}

#[test]
fn inactive_tab_git_preview_close_does_not_scroll_active_tab_and_session_moved_closes_preview() {
    use codenomad_client::git::Diff;
    use rune::{Env, ImageCache, Runtime};

    let make_tab_rows = |prefix: &str| -> Vec<crate::history::Row> {
        (0..32)
            .map(|i| {
                crate::Message {
                    usage: None,
                    id: format!("{prefix}-{i:02}"),
                    role: "assistant".into(),
                    completed: true,
                    body: format!("{prefix} passage {i:02} line one.\nLine two for scroll depth."),
                    parts: vec![],
                }
                .into()
            })
            .collect()
    };
    let tab_a_rows = make_tab_rows("git-tab-a");
    let tab_b_rows = make_tab_rows("git-tab-b");

    let mut s = crate::init();
    let mut ws = crate::workspace::Ui::new();
    ws.fixture_ready();
    s.workspace = Some(ws);
    s.phase = crate::Phase::Ready;
    s.messages = tab_a_rows.clone();
    let (reader_a, lane_a) = crate::chat::reader::Reader::open();
    s.reader = Some(reader_a);
    let mut git_ui = ui();
    git_ui.online = true;
    git_ui.shown = true;
    git_ui.mode = Mode::Changes;
    statuses(&mut git_ui, vec![change("src/lib.rs", false, false, 1)]);
    let preview_target = Preview::local(
        git_ui
            .changes
            .find(git_ui.changes.current.as_ref().unwrap())
            .unwrap(),
    );
    s.git.owner = Some(git_ui);
    let mut rt = Runtime::new(s, crate::view, (390.0, 420.0), Env::new(false, 1.0));
    for _ in 0..25 {
        rt.frame(0.02);
    }
    // Anchor Tab A on git-tab-a-12, then open its Git diff preview.
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("git-tab-a-12", -6.0);
    });
    for _ in 0..25 {
        rt.frame(0.02);
    }
    let top_row = |rt: &Runtime<crate::State>, prefix: &str| -> Option<(String, f32)> {
        let h = rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))?
            .rect;
        let probe = h[1] + 0.5;
        rt.elements().into_iter().find_map(|e| {
            let k = e.key?;
            (k.starts_with(prefix)
                && e.rect[3] > 0.0
                && e.rect[1] <= probe
                && e.rect[1] + e.rect[3] > probe)
                .then_some((k, e.rect[1] - h[1]))
        })
    };
    let (tab_a_before_id, tab_a_before_off) =
        top_row(&rt, "git-tab-a-").expect("Tab A anchored on git-tab-a-12");
    assert_eq!(tab_a_before_id, "git-tab-a-12");

    {
        let cache = ImageCache::new(rt.state.wake.clone());
        let owner = rt.state.git.owner.as_mut().unwrap();
        owner.replace_preview(preview_target.clone());
        let _ = owner.reader.replace(
            Diff::Text {
                before: "fn a() {}\n".into(),
                after: "fn a() { 1 }\n".into(),
            },
            "src/lib.rs",
            true,
            &cache,
        );
    }
    assert!(has_preview(&rt.state));

    // Switch to a second tab (Tab B), stashing Tab A in workspace cache with owner.active = false.
    rt.update(|s, tx| {
        crate::workspace::new_tab(s, tx);
        s.screen = crate::Screen::Chat { launcher: None };
        s.phase = crate::Phase::Ready;
        s.messages = tab_b_rows.clone();
        s.revision += 1;
    });
    for _ in 0..25 {
        rt.frame(0.02);
    }
    rt.update(|_, tx| {
        tx.instant();
        tx.scroll_key_to("git-tab-b-12", -6.0);
    });
    for _ in 0..25 {
        rt.frame(0.02);
    }
    let (before_b_id, before_b_off) =
        top_row(&rt, "git-tab-b-").expect("Tab B anchored on git-tab-b-12");
    assert_eq!(before_b_id, "git-tab-b-12");

    // Deliver an empty Changes read to cached Tab A (already stashed with owner.active = false),
    // then run real workspace::poll (poll_cached swaps Tab A's cache onto State with shared Tx,
    // closes Tab A's stale Git preview via git::poll, and restores Tab B).
    rt.update(|s, tx| {
        s.workspace
            .as_mut()
            .unwrap()
            .with_cached_git("tab-0", |git| {
                let owner = git.owner.as_mut().unwrap();
                assert!(!owner.active);
                let rev = owner.index_revision;
                owner
                    .requests
                    .deliver_read(Lane::Changes, Ok(Value::Changes(vec![], None, rev)));
            });
        assert!(crate::workspace::poll(s, 1.0, tx));
    });
    for _ in 0..25 {
        rt.frame(0.02);
    }
    let (after_b_id, after_b_off) = top_row(&rt, "git-tab-b-").expect("Tab B still visible");
    assert_eq!(
        after_b_id, before_b_id,
        "cached Tab A Git preview close via workspace::poll must not scroll active Tab B"
    );
    assert!((after_b_off - before_b_off).abs() <= 1.0);

    // Return to Tab A: its Git preview must already be closed and git-tab-a-12 must be restored.
    rt.update(|s, tx| {
        crate::workspace::select(s, "tab-0", tx);
    });
    assert!(
        !has_preview(&rt.state),
        "Tab A preview must have been closed while cached in workspace::poll"
    );
    let gen_return = rt.state.reader.as_ref().unwrap().generation();
    let conn_a = lane_a.connection.load(std::sync::atomic::Ordering::SeqCst);
    lane_a
        .events
        .try_send((
            gen_return,
            conn_a,
            crate::transport::Event::ReaderSync {
                page: crate::history::Page {
                    rows: tab_a_rows.clone(),
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                version: 1,
            },
        ))
        .unwrap();
    for _ in 0..25 {
        rt.update(|s, tx| {
            crate::poll(s, 2.0, tx);
        });
        rt.frame(0.02);
    }
    let (tab_a_after_id, tab_a_after_off) =
        top_row(&rt, "git-tab-a-").expect("Tab A restored on return");
    assert_eq!(tab_a_after_id, tab_a_before_id);
    assert!((tab_a_after_off - tab_a_before_off).abs() <= 1.0);

    // Exercise SessionMoved delivered through real chat::events::poll_chat closing an open preview
    // and preserving the saved bookmark across the subsequent rebind ReaderSync.
    let (tx_ev, rx_ev) = codenomad_client::bounded(4);
    rt.state.incoming = Some(rx_ev);
    let workspace_id = rt
        .state
        .git
        .owner
        .as_ref()
        .unwrap()
        .backend
        .workspace
        .clone();
    let session_id = rt.state.git.owner.as_ref().unwrap().backend.session.clone();
    {
        let cache = ImageCache::new(rt.state.wake.clone());
        let owner = rt.state.git.owner.as_mut().unwrap();
        owner.active = true;
        statuses(owner, vec![change("src/lib.rs", false, false, 1)]);
        owner.replace_preview(preview_target);
        let _ = owner.reader.replace(
            Diff::Text {
                before: "fn a() {}\n".into(),
                after: "fn a() { 1 }\n".into(),
            },
            "src/lib.rs",
            true,
            &cache,
        );
    }
    assert!(has_preview(&rt.state));
    tx_ev
        .try_send(crate::transport::Event::Workspace(
            WorkspaceEvent::SessionMoved {
                workspace_id,
                session_id,
            },
        ))
        .unwrap();
    assert!(crate::chat::events::poll_chat(&mut rt.state, 16));
    assert!(
        !has_preview(&rt.state),
        "SessionMoved delivered via poll_chat must close open Git preview"
    );
    assert!(rt.state.messages.is_empty());
    rt.update(|s, tx| {
        crate::chat::reader::resume(s, tx);
    });
    let gen_rebind = rt.state.reader.as_ref().unwrap().generation();
    lane_a
        .events
        .try_send((
            gen_rebind,
            conn_a,
            crate::transport::Event::ReaderSync {
                page: crate::history::Page {
                    rows: tab_a_rows,
                    older: None,
                    newer: None,
                    running: false,
                    user_file_references: false,
                },
                version: 2,
            },
        ))
        .unwrap();
    for _ in 0..25 {
        rt.update(|s, tx| {
            crate::poll(s, 3.0, tx);
        });
        rt.frame(0.02);
    }
    let (rebound_id, rebound_off) = top_row(&rt, "git-tab-a-")
        .expect("Tab A reading anchor restored after SessionMoved rebind");
    assert_eq!(rebound_id, tab_a_before_id);
    assert!((rebound_off - tab_a_before_off).abs() <= 1.0);
}

#[test]
fn git_read_mutation_and_open_errors_are_localized_without_raw_english_fallbacks() {
    use crate::{
        platform::workspace_open::OpenError,
        strings::{t, with_locale},
    };
    use codenomad_client::git::{GitError, Refusal};

    for lang in ["fr", "en"] {
        with_locale(lang, || {
            let mut owner = ui();
            let tree = owner.tree().unwrap().clone();
            let epoch = owner.tree_epoch;

            owner.read_failed(Lane::Changes, GitError::CheckoutUnavailable.into());
            assert_eq!(
                owner.requests.slot(Lane::Changes).error.as_deref(),
                Some(t("gitPanel.error.checkoutUnavailable"))
            );

            owner.read_failed(Lane::Changes, GitError::UnconfirmedMutation.into());
            assert_eq!(
                owner.requests.slot(Lane::Changes).error.as_deref(),
                Some(t("gitPanel.error.unconfirmedMutation"))
            );

            owner.read_failed(Lane::Preview, GitError::OversizedContent.into());
            assert_eq!(
                owner.requests.slot(Lane::Preview).error.as_deref(),
                Some(t("toolCall.output.tooLarge"))
            );

            owner.read_failed(Lane::Preview, GitError::UnsupportedImageType.into());
            assert_eq!(
                owner.requests.slot(Lane::Preview).error.as_deref(),
                Some(t("filesPanel.binary"))
            );

            owner.read_failed(Lane::Changes, "raw English transport failure".into());
            assert_eq!(
                owner.requests.slot(Lane::Changes).error.as_deref(),
                Some(t("rune.failed"))
            );

            owner.read_failed(
                Lane::Changes,
                Refusal::new(503, Some("git_required".into()), Some("Git missing".into())).into(),
            );
            assert_eq!(
                owner.requests.slot(Lane::Changes).error.as_deref(),
                Some(t("filesPanel.gitInit.gitRequired"))
            );

            owner.read_failed(
                Lane::Changes,
                Refusal::new(403, None, Some("Custom backend refusal".into())).into(),
            );
            assert_eq!(
                owner.requests.slot(Lane::Changes).error.as_deref(),
                Some("Custom backend refusal")
            );

            owner.read_failed(Lane::Changes, Refusal::new(502, None, None).into());
            assert_eq!(
                owner.requests.slot(Lane::Changes).error.as_deref(),
                Some(t("rune.failed"))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Commit {
                    message: "feat: test".into(),
                    draft: "feat: test".into(),
                },
                Err(GitError::UnconfirmedMutation.into()),
            );
            assert_eq!(
                owner.mutation_message,
                Some((false, t("gitPanel.error.unconfirmedMutation").into()))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Commit {
                    message: "feat: test".into(),
                    draft: "feat: test".into(),
                },
                Err("raw English commit failure".into()),
            );
            assert_eq!(
                owner.mutation_message,
                Some((false, t("instanceShell.gitChanges.commit.error").into()))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Commit {
                    message: "feat: test".into(),
                    draft: "feat: test".into(),
                },
                Err(Refusal::new(422, None, Some("pre-commit hook rejected".into())).into()),
            );
            assert_eq!(
                owner.mutation_message,
                Some((false, "pre-commit hook rejected".into()))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Paths(Section::Unstaged, vec!["a.rs".into()], 1),
                Err(GitError::UnconfirmedMutation.into()),
            );
            assert_eq!(
                owner.mutation_message,
                Some((false, t("gitPanel.error.unconfirmedMutation").into()))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Init("D:/repo".into()),
                Err(
                    Refusal::new(503, Some("git_required".into()), Some("Git missing".into()))
                        .into(),
                ),
            );
            assert_eq!(
                owner.mutation_message,
                Some((false, t("filesPanel.gitInit.gitRequired").into()))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Init("D:/repo".into()),
                Err(GitError::UnconfirmedMutation.into()),
            );
            assert_eq!(
                owner.mutation_message,
                Some((
                    false,
                    t("filesPanel.gitInit.error")
                        .replace("{message}", t("gitPanel.error.unconfirmedMutation"))
                ))
            );

            owner.settle_mutation(
                epoch,
                &tree,
                Mutation::Init("D:/repo".into()),
                Err("raw English init transport error".into()),
            );
            assert_eq!(
                owner.mutation_message,
                Some((
                    false,
                    t("filesPanel.gitInit.error").replace("{message}", t("rune.failed"))
                ))
            );

            assert_eq!(
                OpenError::CheckoutUnavailable.localized(lang),
                t("gitPanel.error.checkoutUnavailable")
            );
            assert_eq!(
                OpenError::WorktreeChanged.localized(lang),
                t("gitPanel.error.worktreeChanged")
            );
            assert_eq!(
                OpenError::Unavailable.localized(lang),
                t("gitPanel.error.nativeActionsUnavailable")
            );
            assert_eq!(OpenError::Failed.localized(lang), t("rune.failed"));

            if lang == "fr" {
                assert_ne!(
                    t("gitPanel.error.checkoutUnavailable"),
                    "Selected checkout is unavailable"
                );
                assert_ne!(
                    t("gitPanel.error.unconfirmedMutation"),
                    "Git change was not confirmed"
                );
                assert_ne!(t("gitPanel.error.worktreeChanged"), "Worktree changed");
                assert_ne!(
                    t("gitPanel.error.nativeActionsUnavailable"),
                    "Native workspace actions are unavailable"
                );
            }
        });
    }
}
