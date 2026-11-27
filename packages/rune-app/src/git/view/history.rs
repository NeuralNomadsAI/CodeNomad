use super::*;
use rune_theme_codenomad::git_panel::ButtonLook::Flat;

pub(super) fn view(s: &State, ui: &Ui) -> El {
    let name = t("gitPanel.filter");
    let mut body = theme::saved_scroll::<State>("git-history-list", &ui.history_scroll).child(
        theme::header().child(
            layout::hinted_field(&ui.filter, name)
                .label(name)
                .input_mode(rune::InputMode::Search)
                .on_edit(edit(s, |ui| &mut ui.filter))
                .build(&field_kit(dark()))
                .key("git-filter"),
        ),
    );
    let filter = ui.filter.text.to_lowercase();
    let dates = ui.history.dates(locale());
    let matches = ui
        .history
        .page
        .iter()
        .flat_map(|page| &page.commits)
        .zip(dates.iter())
        .filter(|(commit, _)| {
            format!("{} {} {}", commit.subject, commit.author, commit.id)
                .to_lowercase()
                .contains(&filter)
        });
    let mut empty = true;
    for (commit, date) in matches {
        empty = false;
        let id = commit.id.clone();
        let subject = commit.subject.clone();
        let refs = commit.refs.clone();
        let author = format!("{} · {date}", commit.author);
        let short = id.chars().take(7).collect::<String>();
        let key = format!("git-commit-{id}");
        let name = format!("{subject} · {author} · {short}");
        let content = col()
            .full_width()
            .separate(Space::Xs)
            .child(text(subject).text_role(TextRole::Button).wrap_anywhere())
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
