//! Matching content from packages/ui/tests/browser/fixtures/git-history.tsx.
use crate::git::{Mode, Ui};
use codenomad_client::{
    backend::Backend,
    git::{
        Change, Commit, CommitFile, Details, Diff, Page, Repository, Status, Worktree, Worktrees,
    },
};
use rune_theme_codenomad::{Space, git_panel, layout::Layout};

pub fn view(s: &crate::State) -> rune::El {
    let width = crate::platform::setting("RUNE_GIT_PANEL_WIDTH")
        .and_then(|width| width.parse::<f32>().ok())
        .filter(|width| width.is_finite() && *width > 0.0)
        .unwrap_or(360.0);
    view_with_width(s, width)
}

pub(super) fn view_with_width(s: &crate::State, width: f32) -> rune::El {
    rune::col()
        .full_width()
        .full_height()
        .reading_surface()
        .child(rune::text("CodeNomad").pad(Space::Md))
        .child(
            rune::row()
                .full_width()
                .remaining()
                .child(
                    git_panel::conversation_column()
                        .child(crate::git::reader(s))
                        .child(crate::composer::view::view(
                            s,
                            rune_theme_codenomad::interruption::SessionLayout::default(),
                            crate::chat::ComposerCaretPins::default(),
                            None,
                            rune::el(),
                        )),
                )
                .child(crate::git::panel(s, width, rune::el())),
        )
}

pub fn changes(s: &mut crate::State) {
    setup(s, Mode::Changes);
}

#[cfg(test)]
pub(super) fn changes_explicit(s: &mut crate::State) {
    setup_with(s, Mode::Changes, None, false, None);
}

pub fn commits(s: &mut crate::State) {
    setup(s, Mode::History);
}

fn setup(s: &mut crate::State, mode: Mode) {
    let empty = crate::platform::setting("RUNE_GIT_PANEL_STATE");
    let long_subject = crate::platform::setting("RUNE_GIT_LONG_SUBJECT").as_deref() == Some("1");
    let detail =
        crate::platform::setting("RUNE_GIT_COMMIT_DETAIL").filter(|_| mode == Mode::History);
    setup_with(s, mode, empty.as_deref(), long_subject, detail.as_deref());
}

fn setup_with(
    s: &mut crate::State,
    mode: Mode,
    empty: Option<&str>,
    long_subject: bool,
    detail: Option<&str>,
) {
    const PATH: &str = "src/components/git-panel.tsx";
    let Ok(client) = codenomad_client::http::Http::new() else {
        return;
    };
    let backend = Backend {
        client,
        base: "http://127.0.0.1:1/".into(),
        workspace: "git-prototype".into(),
        session: "session".into(),
        client_id: "git-fixture".into(),
        session_directory: None,
        fresh_mode: false,
    };
    let mut ui = Ui::new(
        backend,
        Some("/CodeNomad".into()),
        s.reads.clone(),
        s.wake.clone(),
    );
    let inventory = Worktrees {
        repository: match empty {
            Some("no-git") => Repository::NoGit,
            Some("uninitialized") => Repository::Uninitialized,
            _ => Repository::Git,
        },
        trees: vec![
            Worktree {
                slug: "root".into(),
                label: None,
                directory: "/CodeNomad".into(),
                branch: Some("feat/git-history".into()),
                head: empty.is_none().then(|| "1".repeat(40)),
                service_directory: None,
                missing: false,
            },
            Worktree {
                slug: "review".into(),
                label: None,
                directory: "/CodeNomad/.codenomad/worktrees/review".into(),
                branch: Some("dev".into()),
                head: None,
                service_directory: None,
                missing: false,
            },
        ],
    };
    let statuses = vec![
        Status {
            path: PATH.into(),
            original_path: None,
            staged: Some(Change {
                kind: "modified".into(),
                additions: 4,
                deletions: 2,
            }),
            unstaged: None,
            whitespace_only: false,
        },
        Status {
            path: "src/styles/panels/git-history.css".into(),
            original_path: None,
            staged: None,
            unstaged: Some(Change {
                kind: "untracked".into(),
                additions: 34,
                deletions: 0,
            }),
            whitespace_only: false,
        },
    ];
    let subject = if long_subject {
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    } else {
        "Make Git history the starting point"
    };
    let commits: Vec<_> = [
        (subject, "HEAD -> feat/git-history"),
        (
            "Open file diffs beside the Git navigator",
            "origin/feat/git-history",
        ),
        ("Preserve conversation drafts when opening a preview", ""),
        ("Merge pull request #788: qualify OpenCode 2.0.18", "dev"),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, (subject, refs))| Commit {
        id: (i + 1).to_string().repeat(40),
        subject: subject.into(),
        refs: refs.into(),
        author: "Pascal André".into(),
        date: format!("2026-09-{}T12:00:00Z", 26 - i),
    })
    .collect();
    let page = Page {
        head: empty.is_none().then(|| "1".repeat(40)),
        commits,
        has_more: false,
    };
    ui.load_scene(mode, inventory, statuses, page, PATH, Diff::Text {
        before: "export function openGitPanel() {\n  return {\n    title: \"Git Changes\",\n    view: \"changes\",\n    diffPlacement: \"sidebar\",\n  }\n}\n".into(),
        after: "export function openGitPanel() {\n  return {\n    title: \"Git\",\n    view: \"history\",\n    diffPlacement: \"conversation\",\n    preserveDraft: true,\n  }\n}\n".into(),
    });
    if let Some(detail) = detail {
        ui.load_commit_scene(Details {
            id: "1".repeat(40),
            message: if detail == "hash" {
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()
            } else {
                "Make Git history the starting point\n\nKeep history and local changes as two simple paths to the central diff.".into()
            },
            files: vec![
                CommitFile { path: PATH.into(), kind: "M".into(), original_path: None },
                CommitFile { path: "src/styles/panels/git-history.css".into(), kind: "A".into(), original_path: None },
            ],
        });
    }
    if let Some(state) = empty {
        ui.load_empty_scene(state);
    }
    s.git.owner = Some(ui);
    s.git.scene = true;
    s.phase = crate::Phase::Ready;
}
