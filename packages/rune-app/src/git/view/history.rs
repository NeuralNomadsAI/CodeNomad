use super::*;

pub(super) fn view(s: &State, ui: &Ui) -> El {
    if ui.history.selected.is_some() {
        return details(s, ui);
    }
    let name = t("gitPanel.filter");
    let mut body = theme::saved_scroll::<State>("git-history-list", &ui.history_scroll).child(
        theme::header().child(
            layout::hinted_field(&ui.filter, name)
                .label(name)
                .on_edit(edit(s, |ui| &mut ui.filter))
                .build(field_kit(dark()))
                .key("git-filter"),
        ),
    );
    let filter = ui.filter.text.to_lowercase();
    let matches = ui
        .history
        .page
        .iter()
        .flat_map(|page| &page.commits)
        .filter(|commit| {
            format!("{} {} {}", commit.subject, commit.author, commit.id)
                .to_lowercase()
                .contains(&filter)
        });
    let mut empty = true;
    for commit in matches {
        empty = false;
        let id = commit.id.clone();
        let subject = commit.subject.clone();
        let refs = commit.refs.clone();
        let author = format!(
            "{} · {}",
            commit.author,
            commit.date.get(..10).unwrap_or(&commit.date)
        );
        let short = id.chars().take(7).collect::<String>();
        let key = format!("git-commit-{id}");
        let name = format!("{subject} · {author} · {short}");
        let content = col()
            .full_width()
            .separate(Space::Xs)
            .child(text(subject).text_role(TextRole::Button).wrap())
            .child(if refs.is_empty() {
                el()
            } else {
                theme::history_refs(refs)
            })
            .child(theme::history_meta(author, short));
        body = body.child(
            theme::history_row(
                name,
                content,
                !ui.online,
                run(s, move |s, tx| {
                    if let Some(ui) = &mut s.git.owner {
                        ui.select_commit(id.clone());
                        tx.focus("git-history-back", tx.focus_visible());
                    }
                }),
            )
            .key(key),
        );
    }
    if empty
        && !ui.loading()
        && ui.history.page.is_some()
        && ui.requests.slot(Lane::History).error.is_none()
    {
        body = body.child(theme::note(t("gitPanel.emptyHistory"), "status"));
    }
    if ui.history.page.as_ref().is_some_and(|page| page.has_more) {
        body = body.child(
            button(
                s,
                t("gitPanel.more"),
                Flat,
                ui.loading() || !ui.online,
                |ui, _| ui.more(),
            )
            .key("git-history-more"),
        );
    }
    if ui.loading() {
        body = body.child(theme::note(t("instanceInfo.loading"), "status"));
    }
    body
}

fn details(s: &State, ui: &Ui) -> El {
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
                source: super::super::Source::Commit {
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
                    .child(preview_button(
                        s,
                        &format!("git-commit-file-preview-{}", file.path),
                        target,
                        ui.backend.session.is_empty(),
                        active,
                    )),
            );
        }
    }
    if ui.loading() {
        body = body.child(theme::note(t("instanceInfo.loading"), "status"));
    }
    body
}
