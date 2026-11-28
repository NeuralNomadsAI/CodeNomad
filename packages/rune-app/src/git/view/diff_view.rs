use super::*;
use crate::{
    components::{
        diff::{self, LineRange, Side},
        window_close_button,
    },
    git::{Source, diff::Hidden},
};
use codenomad_client::git::Diff;
use rune::row;
use rune_theme_codenomad::{git_diff::image as image_view, git_panel::ButtonLook::Flat};

pub(crate) fn reader(s: &State) -> El {
    let Some(ui) = &s.git.owner else {
        return el();
    };
    let Some(target) = &ui.preview else {
        return el();
    };
    let path = &target.path;
    let preferences = crate::git::diff_preferences(s);
    let split = preferences.split;
    let label = match &target.source {
        Source::Local(section) => section_label(*section).into(),
        Source::Commit { id, subject } => format!(
            "{} · {subject} · {}",
            id.chars().take(8).collect::<String>(),
            t("gitPanel.parentDiff")
        ),
    };
    let image = matches!(&ui.reader.content, Some(Diff::Image { .. }));
    let mut header = theme::chrome()
        .child(
            col()
                .remaining()
                .separate(Space::Xs)
                .child(theme::clipped(path, TextRole::Body).literal_direction())
                .child(theme::clipped(
                    format!("{} · {label}", ui.slug),
                    TextRole::Label,
                )),
        )
        .child(icon(
            "git-diff-mode",
            if split { &theme::COLUMNS } else { &theme::ROWS },
            t(if split {
                "instanceShell.diff.switchToUnified"
            } else {
                "instanceShell.diff.switchToSplit"
            }),
            false,
            Some(split),
            run(s, move |s, _| {
                crate::git::set_diff_preferences(
                    s,
                    crate::git::DiffPreferences {
                        split: !split,
                        ..crate::git::diff_preferences(s)
                    },
                );
            }),
        ));
    if !image {
        let full = preferences.full;
        let wrap = preferences.wrap;
        header = header
            .child(icon(
                "git-diff-context",
                if full {
                    &theme::FOLD_VERTICAL
                } else {
                    &theme::UNFOLD_VERTICAL
                },
                t(if full {
                    "instanceShell.diff.hideUnchanged"
                } else {
                    "instanceShell.diff.showFull"
                }),
                false,
                Some(full),
                run(s, move |s, _| {
                    crate::git::set_diff_preferences(
                        s,
                        crate::git::DiffPreferences {
                            full: !full,
                            ..crate::git::diff_preferences(s)
                        },
                    );
                }),
            ))
            .child(icon(
                "git-diff-wrap",
                &theme::WRAP_TEXT,
                t(if wrap {
                    "instanceShell.filesShell.disableWordWrap"
                } else {
                    "instanceShell.filesShell.enableWordWrap"
                }),
                split,
                Some(wrap),
                run(s, move |s, _| {
                    crate::git::set_diff_preferences(
                        s,
                        crate::git::DiffPreferences {
                            wrap: !wrap,
                            ..crate::git::diff_preferences(s)
                        },
                    );
                }),
            ));
    }
    header = header.child(window_close_button::close_button(
        &s.git.close,
        "git-diff-close",
        dark(),
        Some(t("gitPanel.backChat")),
        |s: &mut State| &mut s.git.close,
        run(s, |s, tx| {
            let had_preview = crate::git::has_preview(s);
            crate::git::close_preview(s);
            crate::git::restore_reading_if_closed(s, had_preview, tx);
            tx.focus("composer", tx.focus_visible());
        }),
    ));

    let mut root = col()
        .full_width()
        .remaining()
        .reading_surface()
        .key(format!("git-reader-{}", ui.preview_revision))
        .role("region")
        .label(t("gitPanel.diff"))
        .child(header);
    let lane = ui.requests.slot(Lane::Preview);
    if let Some(error) = &lane.error {
        root = root.child(theme::note(error.localized(), "alert")).child(
            button(
                s,
                t("instanceShell.rightPanel.actions.refresh"),
                Neutral,
                !ui.online,
                |ui, _| {
                    ui.dirty(&[Lane::Preview]);
                    ui.demand();
                },
            )
            .key("git-diff-retry"),
        );
    }
    if let Some(notice) = ui.reader.notice {
        root = root.child(theme::note(
            t(match notice {
                Hidden::Whitespace => "instanceShell.diff.whitespaceOnly",
                Hidden::Invisible => "instanceShell.diff.lineEndingsOnly",
            }),
            "status",
        ));
    }
    let target = target.clone();
    root.child(match &ui.reader.content {
        Some(Diff::Binary) => theme::note(t("instanceShell.gitChanges.binaryViewer"), "status"),
        Some(Diff::Image { .. }) => image_diff(ui, path, split),
        Some(Diff::Text { .. }) => {
            let can_insert = !s.screen.is_launcher();
            let selected = can_insert.then(|| ui.reader.state.selection()).flatten();
            let comment = run_for_lines(s, target.clone());
            let action = selected
                .filter(|range| range.start.side == Side::New && range.end.side == Side::New)
                .map(|range| {
                    theme::button(
                        t("instanceShell.gitChanges.actions.insertContext"),
                        Flat,
                        false,
                        move |s, tx| comment(s, range, tx),
                    )
                })
                .unwrap_or_else(el);
            col()
                .remaining()
                .full_width()
                .child(action)
                .child(diff::view(
                    s,
                    format!("git-diff-{}", ui.preview_revision),
                    |s: &State| {
                        s.git
                            .owner
                            .as_ref()
                            .map_or(&s.git.detached_diff, |ui| &ui.reader.state)
                    },
                    |s: &mut State| {
                        s.git
                            .owner
                            .as_mut()
                            .map_or(&mut s.git.detached_diff, |ui| &mut ui.reader.state)
                    },
                    if can_insert {
                        Some(std::rc::Rc::new(run_for_lines(s, target)))
                    } else {
                        None
                    },
                ))
        }
        None if lane.error.is_none() => theme::note(t("instanceInfo.loading"), "status"),
        None => el(),
    })
}

fn run_for_lines(
    s: &State,
    target: Preview,
) -> impl Fn(&mut State, LineRange, &mut Tx) + Clone + 'static {
    action(s, move |s, range: LineRange, tx| {
        if s.screen.is_launcher() {
            return;
        }
        let Some(ui) = s
            .git
            .owner
            .as_ref()
            .filter(|ui| ui.preview.as_ref() == Some(&target))
        else {
            return;
        };
        let Some(tree) = ui.tree() else {
            return;
        };
        if range.start.side != Side::New || range.end.side != Side::New {
            return;
        }
        let revision = match &target.source {
            Source::Local(_) => String::new(),
            Source::Commit { id, .. } => format!("Commit: {id} : "),
        };
        let path = &target.path;
        let directory = tree.service_directory.as_ref().unwrap_or(&tree.directory);
        let (a, b) = (range.start.line, range.end.line);
        let location = format!(
            "Git Diff: {revision}Worktree: {directory} : File: {path} : {}-{}",
            a.min(b),
            a.max(b)
        );
        let separator = if s.draft.text.is_empty() { "" } else { "\n" };
        s.draft.insert(&format!("{separator}{location}\n"));
        crate::workspace::draft_changed(s, tx);
        tx.focus("composer", false);
    })
}

fn image_diff(ui: &Ui, path: &str, split: bool) -> El {
    let mut body = if split { row() } else { col() }
        .full_width()
        .pad(Space::Md)
        .separate(Space::Md);
    for (image, key) in ui
        .reader
        .images
        .iter()
        .zip(["filesPanel.image.before", "filesPanel.image.after"])
    {
        let Some(image) = image else {
            continue;
        };
        let label = t(key);
        let content = if let Some(image) = image_view(image) {
            image.role("image").label(format!("{path} · {label}"))
        } else {
            theme::note(
                t(if image.error().is_some() {
                    "filesPanel.binary"
                } else {
                    "instanceInfo.loading"
                }),
                "status",
            )
        };
        let side = col()
            .separate(Space::Sm)
            .child(text(label).text_role(TextRole::Label))
            .child(content);
        body = body.child(if split {
            side.remaining()
        } else {
            side.full_width()
        });
    }
    theme::scroll().key("git-image-diff").child(body)
}
