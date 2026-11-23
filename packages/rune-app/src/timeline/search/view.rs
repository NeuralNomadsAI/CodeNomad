use super::{close, is_open, select, state, visible};
use crate::{
    State, screen,
    strings::{locale, t},
};
use codenomad_client::search::{Kind, Ranked};
use rune::{El, Tx};
use rune_theme_codenomad::{
    TextRole, catalogue, field_kit,
    layout::{self, Layout},
    timeline::search,
};

pub(crate) fn trigger(s: &State) -> Option<El> {
    visible(s).then(|| {
        let keyboard = screen::action_tx(&s.input_scope, toggle);
        search::toggle(
            t("messageSection.search.ariaLabel"),
            screen::action_tx(&s.input_scope, toggle),
        )
        .key("history-search-toggle")
        .on_key(move |s, event, tx| {
            if event.key != rune::Key::Enter {
                return false;
            }
            keyboard(s, tx);
            true
        })
        .expanded(is_open(s))
    })
}

fn toggle(s: &mut State, tx: &mut Tx) {
    if is_open(s) {
        close(s);
    } else {
        state(s).open = true;
        state(s).query.focused = true;
        tx.focus_when_shown(super::FOCUS, true);
    }
}

fn button(s: &State, id: &str, label: &str, f: impl Fn(&mut State, &mut Tx) + 'static) -> El {
    layout::button_tx(t(label), false, screen::action_tx(&s.input_scope, f)).key(id)
}

pub(crate) fn panel(s: &State) -> Option<El> {
    if !is_open(s) {
        return None;
    }
    let model = &s.transcript_display.timeline.search;
    let scope = s.input_scope.clone();
    let preferences = layout::action_row()
        .child(
            button(s, "history-search-session", "history.session", |s, _| {
                super::clear_selection(s);
                let model = state(s);
                if model.ranked {
                    model.ranked = false;
                    model.reset();
                }
            })
            .checked(!model.ranked),
        )
        .child(
            button(
                s,
                "history-search-workspace",
                "history.workspace",
                |s, _| {
                    super::clear_selection(s);
                    let model = state(s);
                    if !model.ranked {
                        model.ranked = true;
                        model.reset();
                    }
                },
            )
            .checked(model.ranked),
        )
        .child(
            button(
                s,
                "history-search-technical",
                "history.technical",
                |s, _| {
                    super::clear_selection(s);
                    let model = state(s);
                    model.technical = !model.technical;
                    model.reset();
                },
            )
            .checked(model.technical),
        );
    let input = layout::hinted_field(&model.query, t("messageSection.search.placeholder"))
        .label(t("messageSection.search.ariaLabel"))
        .on_edit(move |s: &mut State| {
            if s.current_scope(&scope) {
                &mut state(s).query
            } else {
                &mut s.rejected_edit
            }
        })
        .on_key(|s: &mut State, event, tx| {
            if event.key == rune::Key::Enter
                && !event.mods.alt
                && !event.mods.ctrl
                && !event.mods.cmd
            {
                super::move_match(s, tx, !event.mods.shift);
                return true;
            }
            super::keys(s, event, tx)
        })
        .build(field_kit(layout::dark()))
        .key(super::FIELD);
    let header = layout::action_row().child(input.remaining()).child(button(
        s,
        "history-search-close",
        "messageSection.search.closeAriaLabel",
        |s, tx| {
            close(s);
            tx.focus("history-search-toggle", true);
        },
    ));
    let mut frame = search::panel()
        .key("history-search")
        .role("region")
        .label_static(t("messageSection.search.ariaLabel"))
        .child(header)
        .child(preferences)
        .children(model.page().filter(|p| !p.hits.is_empty()).map(|_| {
            layout::action_row()
                .child(button(
                    s,
                    "history-search-prev",
                    "messageSection.search.previousAriaLabel",
                    |s, tx| super::move_match(s, tx, false),
                ))
                .child(button(
                    s,
                    "history-search-next",
                    "messageSection.search.nextAriaLabel",
                    |s, tx| super::move_match(s, tx, true),
                ))
        }));
    if model.flight.is_some() {
        frame = frame.child(rune::text(t("messageSection.search.searching")).role("status"));
    }
    if model.error {
        frame = frame.child(
            layout::action_row()
                .child(rune::text(t("messageSection.search.failed")).role("alert"))
                .child(button(
                    s,
                    "history-search-retry",
                    "messageSection.search.retry",
                    |s, _| state(s).run(),
                )),
        );
    }
    if model.open_error {
        frame = frame.child(rune::text(t("history.openFailed")).role("alert"));
    }
    match &model.results {
        Some(Ranked::Unsupported) => {
            frame = frame.child(rune::text(t("history.rankedUnsupported")).role("status"))
        }
        Some(Ranked::RestartRequired) => {
            frame = frame.child(
                layout::action_row()
                    .child(rune::text(t("history.rankedRestart")).role("status"))
                    .child(button(
                        s,
                        "history-search-fresh",
                        "history.searchFresh",
                        |s, _| state(s).reset(),
                    )),
            )
        }
        Some(Ranked::Ranked {
            page,
            capped,
            examined_before,
            exclusions,
            ..
        }) => {
            frame = frame.child(
                rune::text(catalogue::format(
                    locale(),
                    if model.ranked {
                        "history.rankedProgress"
                    } else {
                        "history.searchProgress"
                    },
                    &[
                        ("matches", &page.hits.len().to_string()),
                        ("messages", &page.scanned.to_string()),
                    ],
                ))
                .role("status"),
            );
            if model.ranked {
                let note = if page.scanned == 0 {
                    "history.rankedEmpty"
                } else if *examined_before == 0 {
                    "history.rankedRecent"
                } else {
                    "history.rankedRange"
                };
                frame = frame.child(rune::text(catalogue::format(
                    locale(),
                    note,
                    &[
                        ("messages", &page.scanned.to_string()),
                        ("start", &(examined_before + 1).to_string()),
                        ("end", &(examined_before + page.scanned).to_string()),
                    ],
                )));
            }
            if *capped {
                frame = frame.child(rune::text(t("history.rankedCapped")));
            }
            if !exclusions.is_empty() {
                frame = frame.child(rune::text(t("history.rankedExcluded")));
            }
            if page.skipped > 0 {
                frame = frame.child(rune::text(catalogue::format(
                    locale(),
                    "history.skipped",
                    &[("count", &page.skipped.to_string())],
                )));
            }
            if page.hits.is_empty() && model.flight.is_none() {
                frame = frame.child(rune::text(t("messageSection.search.count.none")));
            }
            let terms = if model.ranked {
                search::terms(&model.text)
            } else {
                Vec::new()
            };
            let launch = s.screen.launcher();
            frame = frame.child(
                search::results().children(page.hits.iter().enumerate().flat_map(|(i, hit)| {
                    let header = (model.ranked
                        && i.checked_sub(1)
                            .is_none_or(|before| page.hits[before].session != hit.session))
                    .then(|| {
                        if let Some((title, slug)) =
                            model.labels.get(&hit.session).and_then(Option::as_ref)
                        {
                            rune::text(if slug == "root" {
                                title.clone()
                            } else {
                                format!("{title} · {slug}")
                            })
                            .text_role(TextRole::Label)
                        } else {
                            let title = launch
                                .and_then(|l| l.sessions.iter().find(|r| r.id == hit.session))
                                .map(|r| r.title.as_str())
                                .unwrap_or_else(|| {
                                    if model.labels.get(&hit.session) == Some(&None) {
                                        t("history.sessionUnavailable")
                                    } else {
                                        t("sessionList.session.untitled")
                                    }
                                });
                            rune::text(title).text_role(TextRole::Label)
                        }
                    });
                    let kind = t(match hit.kind {
                        Kind::Text => "history.text",
                        Kind::Tool => "history.tool",
                        Kind::Reasoning => "history.reasoning",
                    });
                    let key = format!("history-hit-{}-{}", hit.session, hit.message);
                    let id = hit.clone();
                    let activate = move |s: &mut State, tx: &mut Tx| {
                        if state(s).page().and_then(|p| p.hits.get(i)) == Some(&id) {
                            select(s, i, tx);
                        }
                    };
                    let click = screen::action_tx(&s.input_scope, activate.clone());
                    let keyboard = screen::action_tx(&s.input_scope, activate);
                    header.into_iter().chain(std::iter::once(
                        search::result_button(&hit.excerpt, &terms, model.selected == Some(i))
                            .on_press_tx(click)
                            .on_key(move |s, event, tx| {
                                if event.key != rune::Key::Enter {
                                    return false;
                                }
                                keyboard(s, tx);
                                true
                            })
                            .key(key)
                            .description_static(kind),
                    ))
                })),
            );
            if let Some(hit) = model.selected.and_then(|index| page.hits.get(index))
                && s.transcript_display
                    .timeline
                    .backend
                    .as_ref()
                    .is_some_and(|backend| backend.session != hit.session)
            {
                frame = frame
                    .child(
                        search::results().children(
                            super::preview::blocks(hit, &model.preview.blocks)
                                .map(|block| search::excerpt(block, &terms)),
                        ),
                    )
                    .children(
                        model
                            .preview
                            .failed
                            .then(|| rune::text(t("messageSection.search.failed")).role("status")),
                    )
                    .child(button(
                        s,
                        "history-search-open",
                        "history.openSession",
                        super::open_result,
                    ));
            }
            if model.flight.is_none()
                && let Some(cursor) = &page.cursor
            {
                let cursor = cursor.clone();
                frame = frame.child(button(
                    s,
                    "history-search-more",
                    if model.ranked {
                        "history.furtherBack"
                    } else {
                        "history.more"
                    },
                    move |s, _| {
                        super::clear_selection(s);
                        state(s).cursor = Some(cursor.clone());
                        state(s).run();
                    },
                ));
            }
        }
        _ => {}
    }
    Some(frame)
}
