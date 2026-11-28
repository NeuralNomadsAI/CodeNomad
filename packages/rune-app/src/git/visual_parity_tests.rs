use super::*;
use crate::{State, strings};
use codenomad_client::git::{
    Change, Commit, CommitFile, Details, Diff, GitError, Page, Repository, Section, Status,
    Worktree, Worktrees,
};
use rune::{Cx, El, Env, Runtime};
use rune_theme_codenomad::{document_reader, field_kit, kit};
use serde_json::Value as Json;

fn render_panel(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || {
        crate::settings::render(s, cx, |_| super::view::panel(s, 360.0, rune::el()))
    })
}

fn render_reader(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || {
        crate::settings::render(s, cx, |_| super::view::reader(s))
    })
}

fn render_reader_rtl(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("he", || {
        crate::settings::render(s, cx, |_| super::view::reader(s))
    })
}

fn render_document_header_ref(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || {
        crate::settings::render(s, cx, |_| {
            document_reader::header("ref", "", None, vec![]).key("ref-doc-header")
        })
    })
}

fn document_header_ref_rt(dark: bool) -> Runtime<State> {
    let mut rt = Runtime::new(
        crate::init(),
        render_document_header_ref,
        (640.0, 120.0),
        Env::new(dark, 1.0),
    );
    settle(&mut rt);
    rt
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn has_state(node: &Json, state: &str) -> bool {
    node["states"]
        .as_array()
        .is_some_and(|states| states.iter().any(|entry| entry.as_str() == Some(state)))
}

fn find_node<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    if value.get("key").and_then(Json::as_str) == Some(key) {
        return Some(value);
    }
    if let Some(children) = value.get("children").and_then(Json::as_array) {
        for child in children {
            if let Some(found) = find_node(child, key) {
                return Some(found);
            }
        }
    }
    None
}

fn sample_ui(repository: Repository) -> Ui {
    let backend = Backend {
        base: "http://127.0.0.1:9/".into(),
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
    ui.online = true;
    ui.shown = true;
    ui.accept(Lane::Preferences, Value::Preferences(true));
    ui.accept(
        Lane::Worktrees,
        Value::Worktrees(Worktrees {
            repository,
            trees: vec![
                Worktree {
                    slug: "root".into(),
                    label: None,
                    directory: "D:/repo".into(),
                    service_directory: None,
                    branch: (repository == Repository::Git).then(|| "feat/git-panel-parity".into()),
                    head: Some("abcdef123456".into()),
                    missing: false,
                },
                Worktree {
                    slug: "review".into(),
                    label: None,
                    directory: "D:/repo/.codenomad/worktrees/review".into(),
                    service_directory: None,
                    branch: (repository == Repository::Git).then(|| "review/branch".into()),
                    head: Some("123456abcdef".into()),
                    missing: false,
                },
            ],
        }),
    );
    ui
}

fn status_row(path: &str, staged: Option<&str>, unstaged: Option<&str>) -> Status {
    let mk = |kind: &str, add: u64, del: u64| Change {
        kind: kind.into(),
        additions: add,
        deletions: del,
    };
    Status {
        path: path.into(),
        original_path: None,
        staged: staged.map(|k| mk(k, 4, 1)),
        unstaged: unstaged.map(|k| mk(k, 2, 3)),
        whitespace_only: false,
    }
}

#[test]
fn git_header_modes_worktrees_and_uninitialized_states_match_solid_in_light_and_dark() {
    for dark in [false, true] {
        let mut s = crate::init();
        let mut owner = sample_ui(Repository::Git);
        owner.mode = Mode::Changes;
        owner.accept(
            Lane::Changes,
            Value::Changes(
                vec![status_row("src/lib.rs", Some("modified"), None)],
                None,
                owner.index_revision,
            ),
        );
        s.git.owner = Some(owner);

        let mut rt = Runtime::new(s, render_panel, (360.0, 640.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let elements = rt.elements();
        let panel = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-panel"))
            .expect("git-panel");
        assert_eq!(panel.fill, kit(dark).c.layer_01);
        assert!(
            elements
                .iter()
                .any(|el| el.help.as_deref() == Some("feat/git-panel-parity")),
            "branch title must carry hover tooltip in dark={dark}"
        );
        assert!(
            elements
                .iter()
                .any(|el| el.key.as_deref() == Some("git-refresh"))
        );
        assert!(
            elements
                .iter()
                .any(|el| el.key.as_deref() == Some("git-mode"))
        );
        assert!(
            elements
                .iter()
                .any(|el| el.key.as_deref() == Some("git-count"))
        );

        let tree = rt.accessibility_json();
        let mode_group = find_node(&tree, "git-mode").expect("git-mode switch");
        assert_eq!(mode_group["role"], "radio-group");
        let worktree = find_node(&tree, "git-worktree-trigger").expect("git-worktree picker");
        assert_eq!(worktree["description"], "D:/repo");

        // Uninitialized repository: suppresses stale Changes lane errors and offers Initialize Git.
        let mut uninit = crate::init();
        let mut owner = sample_ui(Repository::Uninitialized);
        owner.mode = Mode::Changes;
        owner.read_failed(Lane::Changes, GitError::UnexpectedResponse.into());
        uninit.git.owner = Some(owner);
        let mut rt = Runtime::new(uninit, render_panel, (360.0, 640.0), Env::new(dark, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        assert!(find_node(&tree, "git-error-changes").is_none());
        let note = find_node(&tree, "git-init-note").expect("git-init-note");
        assert_eq!(note["role"], "status");
        assert!(find_node(&tree, "git-init").is_some());

        // No-Git directory mode: branch falls back to folder basename and surfaces lane alert.
        let mut no_git = crate::init();
        let mut owner = sample_ui(Repository::NoGit);
        owner.mode = Mode::Changes;
        owner.read_failed(Lane::Changes, GitError::CheckoutUnavailable.into());
        no_git.git.owner = Some(owner);
        let mut rt = Runtime::new(no_git, render_panel, (360.0, 640.0), Env::new(dark, 1.0));
        settle(&mut rt);
        let elements = rt.elements();
        assert!(
            elements.iter().any(|el| el.help.as_deref() == Some("repo")),
            "NoGit branch label must fall back to folder basename"
        );
        let tree = rt.accessibility_json();
        let alert = find_node(&tree, "git-error-changes").expect("NoGit changes alert");
        assert_eq!(alert["role"], "alert");
        assert!(find_node(&tree, "git-section-staged").is_some());
        assert!(find_node(&tree, "git-commit-box").is_some());
        assert!(find_node(&tree, "git-section-unstaged").is_some());

        // Read failure before inventory arrives keeps Changes/Commits structure and no-session notice (E1).
        let mut failed = crate::init();
        let mut owner = sample_ui(Repository::Git);
        owner.inventory = None;
        owner.backend.session.clear();
        owner.mode = Mode::Changes;
        owner.read_failed(Lane::Worktrees, GitError::UnexpectedResponse.into());
        failed.git.owner = Some(owner);
        let mut rt = Runtime::new(failed, render_panel, (360.0, 640.0), Env::new(dark, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        assert!(find_node(&tree, "git-error-worktrees").is_some());
        assert!(find_node(&tree, "git-no-session").is_some());
        assert!(find_node(&tree, "git-section-staged").is_some());
        assert!(find_node(&tree, "git-commit-message").is_some());
        assert!(find_node(&tree, "git-commit").is_some());
        assert!(find_node(&tree, "git-section-unstaged").is_some());
        rt.update(|s, _| {
            let ui = s.git.owner.as_mut().unwrap();
            ui.mode = Mode::History;
            ui.read_failed(Lane::History, GitError::UnexpectedResponse.into());
        });
        settle(&mut rt);
        let tree = rt.accessibility_json();
        assert!(find_node(&tree, "git-error-history").is_some());
        assert!(find_node(&tree, "git-no-session").is_some());
        assert!(find_node(&tree, "git-filter").is_some());
        assert!(find_node(&tree, "git-history-empty").is_some());
    }
}

#[test]
fn git_changes_sections_commit_box_and_notices_match_solid_in_light_and_dark() {
    for dark in [false, true] {
        let mut s = crate::init();
        let mut owner = sample_ui(Repository::Git);
        owner.mode = Mode::Changes;
        let rows = vec![
            status_row("src/staged.rs", Some("added"), None),
            status_row("src/modified.rs", None, Some("modified")),
            status_row("src/untracked.rs", None, Some("untracked")),
        ];
        owner.accept(
            Lane::Changes,
            Value::Changes(rows, None, owner.index_revision),
        );
        owner.changes.draft = TextEdit::new("feat: align git panel");
        owner.changes.bulk.insert(changes::Id {
            section: Section::Staged,
            path: "src/staged.rs".into(),
        });
        owner.changes.bulk.insert(changes::Id {
            section: Section::Unstaged,
            path: "src/modified.rs".into(),
        });
        let preview_target = Preview {
            source: Source::Local(Section::Staged),
            path: "src/staged.rs".into(),
            original_path: None,
        };
        owner.replace_preview(preview_target);
        s.git.owner = Some(owner);

        let mut rt = Runtime::new(s, render_panel, (420.0, 720.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let elements = rt.elements();
        let commit_input = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-commit-message"))
            .expect("git-commit-message");
        assert_eq!(
            commit_input.fill,
            field_kit(dark).c.bg_base,
            "commit textarea must use --surface-field in dark={dark}"
        );
        let ref_rt = document_header_ref_rt(dark);
        let ref_els = ref_rt.elements();
        let ref_doc_header = ref_els
            .iter()
            .find(|el| el.key.as_deref() == Some("ref-doc-header"))
            .expect("ref-doc-header");
        let staged_group = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("staged"))
            .expect("staged section group");
        let unstaged_group = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("unstaged"))
            .expect("unstaged section group");
        assert_eq!(
            staged_group.border_color, ref_doc_header.border_color,
            "non-last section must draw --border-divider bottom border in dark={dark}"
        );
        assert_eq!(
            unstaged_group.border_color, None,
            "last section must omit bottom border matching Solid last:border-b-0 in dark={dark}"
        );
        let staged_section = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-section-staged"))
            .expect("staged section header");
        let unstaged_section = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-section-unstaged"))
            .expect("unstaged section header");
        assert!(staged_section.rect[1] < unstaged_section.rect[1]);
        for bulk_key in ["git-bulk-staged", "git-bulk-unstaged"] {
            let bulk = elements
                .iter()
                .find(|el| el.key.as_deref() == Some(bulk_key))
                .unwrap_or_else(|| panic!("missing {bulk_key}"));
            assert!(
                bulk.rect[2] > 200.0,
                "{bulk_key} must span full section width (got {})",
                bulk.rect[2]
            );
        }

        let tree = rt.accessibility_json();
        assert!(find_node(&tree, "git-commit-box").is_some());
        let commit_btn = find_node(&tree, "git-commit").expect("git-commit button");
        assert!(!has_state(commit_btn, "disabled"));
        let staged_preview =
            find_node(&tree, "git-row-staged:preview:src/staged.rs").expect("staged eye button");
        assert!(has_state(staged_preview, "checked"));

        // Empty changes + missing session notices carry clean status roles.
        let mut empty = crate::init();
        let mut owner = sample_ui(Repository::Git);
        owner.backend.session.clear();
        owner.mode = Mode::Changes;
        owner.accept(
            Lane::Changes,
            Value::Changes(vec![], None, owner.index_revision),
        );
        empty.git.owner = Some(owner);
        let mut rt = Runtime::new(empty, render_panel, (360.0, 640.0), Env::new(dark, 1.0));
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let empty_note = find_node(&tree, "git-changes-empty").expect("empty changes note");
        assert_eq!(empty_note["role"], "status");
        let no_session = find_node(&tree, "git-no-session").expect("no-session note");
        assert_eq!(no_session["role"], "status");
    }
}

#[test]
fn git_history_and_commit_detail_views_match_solid_in_light_and_dark() {
    for dark in [false, true] {
        let mut s = crate::init();
        let mut owner = sample_ui(Repository::Git);
        owner.mode = Mode::History;
        owner.accept(
            Lane::History,
            Value::History(
                Page {
                    head: Some("abcdef1234567890".into()),
                    commits: vec![Commit {
                        id: "abcdef1234567890".into(),
                        subject: "feat(git): align history panel".into(),
                        author: "Ada Lovelace".into(),
                        date: "2026-11-28T10:00:00Z".into(),
                        refs: "HEAD -> feat/git-panel-parity, origin/feat/rust-server".into(),
                    }],
                    has_more: true,
                },
                false,
            ),
        );
        s.git.owner = Some(owner);

        let mut rt = Runtime::new(s, render_panel, (380.0, 640.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let elements = rt.elements();
        let filter = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-filter"))
            .expect("git-filter");
        assert_eq!(filter.fill, field_kit(dark).c.bg_base);
        assert!(
            elements.iter().any(|el| {
                el.help.as_deref() == Some("HEAD -> feat/git-panel-parity, origin/feat/rust-server")
            }),
            "commit refs must expose full hover tooltip in dark={dark}"
        );
        let more = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-history-more"))
            .expect("git-history-more");
        assert!(more.rect[2] > 200.0, "more button should span full width");

        let tree = rt.accessibility_json();
        let commit_row = find_node(&tree, "git-commit-abcdef1234567890").expect("commit row node");
        let row_name = commit_row["name"].as_str().unwrap_or_default();
        assert!(
            row_name.contains("abcdef1"),
            "short 7-char hash expected in {row_name}"
        );
        assert!(row_name.contains("Ada Lovelace"));

        // Non-matching filter shows empty history notice with status role.
        rt.update(|s, _| {
            s.git.owner.as_mut().unwrap().filter = TextEdit::new("zzzz-no-match");
        });
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let empty_history = find_node(&tree, "git-history-empty").expect("empty filter notice");
        assert_eq!(empty_history["role"], "status");

        // Commit detail shows back button, summary, and file rows with preview eye toggle.
        rt.update(|s, _| {
            let owner = s.git.owner.as_mut().unwrap();
            owner.filter = TextEdit::new("");
            owner.history.selected = Some("abcdef1234567890".into());
            owner.accept(
                Lane::Details,
                Value::Details(Details {
                    id: "abcdef1234567890".into(),
                    message: "feat(git): align history panel\n\nBody line".into(),
                    files: vec![CommitFile {
                        path: "packages/rune-app/src/git/view.rs".into(),
                        original_path: Some("packages/rune-app/src/git/old.rs".into()),
                        kind: "R".into(),
                    }],
                }),
            );
        });
        settle(&mut rt);
        let tree = rt.accessibility_json();
        assert!(find_node(&tree, "git-history-back").is_some());
        assert!(find_node(&tree, "git-commit-summary").is_some());
        assert!(
            find_node(
                &tree,
                "git-commit-file-preview-packages/rune-app/src/git/view.rs"
            )
            .is_some()
        );
        let elements = rt.elements();
        assert!(
            elements.iter().any(|el| {
                el.help.as_deref()
                    == Some("packages/rune-app/src/git/old.rs → packages/rune-app/src/git/view.rs")
            }),
            "renamed commit file must carry old -> new tooltip"
        );
    }
}

#[test]
fn git_diff_reader_toolbar_surfaces_notices_and_rtl_match_solid_in_light_and_dark() {
    for dark in [false, true] {
        let mut s = crate::init();
        let mut owner = sample_ui(Repository::Git);
        owner.mode = Mode::Changes;
        owner.replace_preview(Preview {
            source: Source::Local(Section::Unstaged),
            path: "src/app.rs".into(),
            original_path: None,
        });
        owner.accept(
            Lane::Preview,
            Value::Preview(Diff::Text {
                before: "fn main() {\n    println!(\"hi\");\n}\n".into(),
                after: "fn main() {\n    println!(\"hi\");   \n}\n".into(),
            }),
        );
        s.git.owner = Some(owner);

        let mut rt = Runtime::new(s, render_reader, (720.0, 520.0), Env::new(dark, 1.0));
        settle(&mut rt);

        let ref_rt = document_header_ref_rt(dark);
        let ref_els = ref_rt.elements();
        let ref_doc_header = ref_els
            .iter()
            .find(|el| el.key.as_deref() == Some("ref-doc-header"))
            .expect("ref-doc-header");
        let k = kit(dark);
        let elements = rt.elements();
        let reader = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-reader-1"))
            .expect("git-reader");
        let header = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-diff-header"))
            .expect("git-diff-header");
        let mode_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-diff-mode"))
            .expect("git-diff-mode");
        let context_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-diff-context"))
            .expect("git-diff-context");
        let wrap_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-diff-wrap"))
            .expect("git-diff-wrap");
        let close_btn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-diff-close"))
            .expect("git-diff-close");
        let notice_el = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("git-diff-notice"))
            .expect("git-diff-notice element");

        assert_eq!(
            reader.fill, k.c.page,
            "diff reader must use --surface-canvas"
        );
        assert_eq!(
            header.fill, ref_doc_header.fill,
            "diff header must match document_reader --surface-chrome"
        );
        assert_eq!(
            header.border_color, ref_doc_header.border_color,
            "diff header must match document_reader --border-divider"
        );
        assert_eq!(
            notice_el.text_color,
            Some(k.c.text_muted),
            "diff notice must use --text-secondary"
        );
        assert_eq!(
            notice_el.border_color,
            Some(k.c.border_base),
            "diff notice must use --border-base"
        );
        assert!(
            mode_btn.rect[0] < context_btn.rect[0]
                && context_btn.rect[0] < wrap_btn.rect[0]
                && wrap_btn.rect[0] < close_btn.rect[0],
            "DiffToolbar + wrap + close order must match Solid in LTR"
        );
        assert!(
            (close_btn.rect[1] - mode_btn.rect[1]).abs() < 12.0,
            "close button must sit on the existing top toolbar row"
        );

        let tree = rt.accessibility_json();
        let notice = find_node(&tree, "git-diff-notice").expect("whitespace-only notice");
        assert_eq!(notice["role"], "status");

        // Toggling split & full context updates button checked states.
        click(&mut rt, "git-diff-mode");
        click(&mut rt, "git-diff-context");
        let tree = rt.accessibility_json();
        assert!(has_state(
            find_node(&tree, "git-diff-mode").unwrap(),
            "checked"
        ));
        assert!(has_state(
            find_node(&tree, "git-diff-context").unwrap(),
            "checked"
        ));

        // Image diff hides context & wrap buttons while keeping mode and close.
        rt.update(|s, _| {
            s.git.owner.as_mut().unwrap().accept(
                Lane::Preview,
                Value::Preview(Diff::Image {
                    mime: "image/png".into(),
                    before: None,
                    after: None,
                }),
            );
        });
        settle(&mut rt);
        let tree = rt.accessibility_json();
        assert!(find_node(&tree, "git-diff-mode").is_some());
        assert!(find_node(&tree, "git-diff-close").is_some());
        assert!(find_node(&tree, "git-diff-context").is_none());
        assert!(find_node(&tree, "git-diff-wrap").is_none());

        // Binary diff renders clean binary status notice.
        rt.update(|s, _| {
            s.git
                .owner
                .as_mut()
                .unwrap()
                .accept(Lane::Preview, Value::Preview(Diff::Binary));
        });
        settle(&mut rt);
        let tree = rt.accessibility_json();
        let binary = find_node(&tree, "git-diff-binary").expect("binary notice");
        assert_eq!(binary["role"], "status");
    }

    // RTL mirrors the diff toolbar controls while keeping close at the inline end.
    let mut s = crate::init();
    let mut owner = sample_ui(Repository::Git);
    owner.mode = Mode::Changes;
    owner.replace_preview(Preview {
        source: Source::Local(Section::Staged),
        path: "src/app.rs".into(),
        original_path: None,
    });
    owner.accept(
        Lane::Preview,
        Value::Preview(Diff::Text {
            before: "a\n".into(),
            after: "b\n".into(),
        }),
    );
    s.git.owner = Some(owner);
    let mut rt = Runtime::new(s, render_reader_rtl, (720.0, 520.0), Env::new(false, 1.0));
    settle(&mut rt);
    let elements = rt.elements();
    let mode_btn = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("git-diff-mode"))
        .expect("rtl git-diff-mode");
    let close_btn = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("git-diff-close"))
        .expect("rtl git-diff-close");
    assert!(
        close_btn.rect[0] < mode_btn.rect[0],
        "RTL diff toolbar must mirror controls: close={} mode={}",
        close_btn.rect[0],
        mode_btn.rect[0]
    );
}

#[test]
fn row_actions_stay_revealed_on_mobile_viewport_and_hidden_at_rest_on_desktop() {
    let mut rt_wide = Runtime::new(
        crate::init(),
        |s, cx| crate::settings::render(s, cx, |cx| crate::shell::view(s, cx, |_, _| rune::el())),
        (1280.0, 800.0),
        Env::new(true, 1.0),
    );
    settle(&mut rt_wide);
    assert!(rt_wide.state.shell.width() >= 768.0);
    assert!(
        !super::view::reveal_row_actions_at_rest(&rt_wide.state),
        "wide desktop viewport should keep inactive row actions hidden at rest"
    );

    let mut rt_narrow = Runtime::new(
        crate::init(),
        |s, cx| crate::settings::render(s, cx, |cx| crate::shell::view(s, cx, |_, _| rune::el())),
        (390.0, 844.0),
        Env::new(true, 1.0),
    );
    settle(&mut rt_narrow);
    assert!(rt_narrow.state.shell.width() > 0.0 && rt_narrow.state.shell.width() < 768.0);
    assert!(
        super::view::reveal_row_actions_at_rest(&rt_narrow.state),
        "touch/mobile viewport must keep row actions visible at rest"
    );
}
