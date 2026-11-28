use super::{El, Preview, State, Ui, file_count, handler, preview_button, t, theme};
use crate::git::Source;

pub(super) fn view(s: &State, ui: &Ui) -> El {
    let mut body = theme::saved_scroll::<State>("git-history-detail", &ui.detail_scroll).child(
        theme::history_back(
            t("filesPanel.commits"),
            handler(s, |ui, tx| {
                let id = ui.history.selected.clone();
                ui.back_to_history();
                if let Some(id) = id {
                    tx.focus(format!("git-commit-{id}"), tx.focus_visible());
                }
            }),
        )
        .key("git-history-back"),
    );
    if let Some(details) = &ui.history.details {
        body = body.child(
            theme::history_summary(
                &details.id,
                &details.message,
                file_count(details.files.len()),
            )
            .key("git-commit-summary"),
        );
        let subject = details
            .message
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned();
        for file in &details.files {
            let target = Preview {
                source: Source::Commit {
                    id: details.id.clone(),
                    subject: subject.clone(),
                },
                path: file.path.clone(),
                original_path: file.original_path.clone(),
            };
            let active = ui.preview.as_ref() == Some(&target);
            let selected = ui.history.file.as_ref() == Some(&file.path);
            let path = file.path.clone();
            let hover = file
                .original_path
                .as_ref()
                .map_or_else(|| path.clone(), |old| format!("{old} → {path}"));
            let main = theme::file(
                path.clone(),
                file.kind.clone(),
                None,
                hover,
                false,
                selected,
                handler(s, move |ui, _| ui.history.file = Some(path.clone())),
            );
            body = body.child(
                theme::file_row(selected)
                    .key(format!("git-commit-file-{}", file.path))
                    .child(main)
                    .child(
                        theme::file_row_actions(super::reveal_row_actions_at_rest(s) || active)
                            .key(format!("git-commit-file-actions-{}", file.path))
                            .child(preview_button(
                                s,
                                &format!("git-commit-file-preview-{}", file.path),
                                target,
                                ui.backend.session.is_empty(),
                                active,
                            )),
                    ),
            );
        }
    }
    if ui.loading() {
        body =
            body.child(theme::note(t("instanceInfo.loading"), "status").key("git-detail-loading"));
    }
    body
}
