use super::*;
use codenomad_client::git::{Change, Commit, Status};

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
                    service_directory: Some("/mnt/d/repo".into()),
                    missing: false,
                },
                Worktree {
                    slug: "other".into(),
                    directory: "D:/other".into(),
                    branch: None,
                    service_directory: None,
                    missing: false,
                },
            ],
        }),
    );
    ui
}

#[test]
fn status_moves_an_open_file_without_opening_sidebar_selection() {
    let mut ui = ui();
    let unstaged = change("file.rs", false, false, 2);
    ui.accept(Lane::Changes, Value::Changes(vec![unstaged.clone()]));
    let id = ui.changes.current.clone().unwrap();
    assert!(!ui.has_preview());
    ui.replace_preview(Preview::local(ui.changes.find(&id).unwrap()));
    let mut staged = change("file.rs", true, false, 2);
    staged.unstaged = None;
    ui.accept(Lane::Changes, Value::Changes(vec![staged]));
    assert_eq!(
        ui.preview.as_ref().unwrap().source,
        Source::Local(Section::Staged)
    );
    ui.accept(Lane::Changes, Value::Changes(vec![]));
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
    ui.accept(Lane::Changes, Value::Changes(changes.clone()));
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
    ui.accept(Lane::Changes, Value::Changes(changes));
    assert!(ui.can_commit());
    let id = Id {
        section: Section::Unstaged,
        path: "b".into(),
    };
    ui.changes.select(id.clone(), true, false);
    ui.settle_mutation(
        ui.tree_epoch,
        &tree,
        Mutation::Paths(Section::Staged, vec!["a".into()]),
        Ok(()),
    );
    assert!(ui.changes.bulk.contains(&id));
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
    let mut row = change("a-stage", false, false, 2);
    ui.accept(Lane::Changes, Value::Changes(vec![row.clone()]));
    let id = ui.changes.current.clone().unwrap();
    let focus = ui
        .changes
        .focus_order(Some(&id.action_key("stage")))
        .unwrap();
    row.staged = row.unstaged.take();
    ui.accept(Lane::Changes, Value::Changes(vec![row]));
    assert_eq!(
        ui.changes.focus_after(focus),
        Some(
            Id {
                section: Section::Staged,
                path: id.path
            }
            .key()
        )
    );
}
