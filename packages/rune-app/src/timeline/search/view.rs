use super::{close, is_open, select, state, visible};
use crate::{
    State, screen,
    strings::{locale, t},
};
use codenomad_client::search::{Kind, Ranked};
use rune::{Cx, El, Tx};
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
        .help(crate::settings::with_shortcut_label(
            s,
            t("messageSection.search.ariaLabel"),
            "session-search",
        ))
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

pub(crate) const HOST: &str = "history-search-host";
const WINDOW: &str = "history-search";
pub(super) const BODY: &str = "history-search-body";

fn drag(s: &mut State, gesture: search::WindowDrag, tx: &mut Tx) {
    let model = state(s);
    if matches!(gesture, search::WindowDrag::Start) {
        let [x, y, _, _] = model.frame.0.get();
        model.drag = Some(([x, y], model.position));
    } else if let Some(([x, y], original)) = model.drag {
        let delta = match gesture {
            search::WindowDrag::Start => return,
            search::WindowDrag::Move(at) => Some(at),
            search::WindowDrag::End(at) => {
                model.drag = None;
                at
            }
        };
        model.position = delta.map(|[dx, dy]| [x + dx, y + dy]).or(original);
        tx.instant();
    }
}

pub(crate) fn overlay(s: &State, cx: &Cx<State>, layers: &mut Vec<El>) {
    let mut picker = Vec::new();
    if let Some(panel) = panel(s, &mut picker) {
        let m = &s.transcript_display.timeline.search;
        let host = cx.window_layout(HOST).unwrap_or_default();
        let height = cx.layout_with(WINDOW, |rect| rect[3]).unwrap_or_default();
        layers.push(search::floating(panel, m.position, host, height));
        layers.extend(picker);
    }
}

fn panel(s: &State, layers: &mut Vec<El>) -> Option<El> {
    if !is_open(s) {
        return None;
    }
    let model = &s.transcript_display.timeline.search;
    let scope = s.input_scope.clone();
    let labels = [t("history.session"), t("history.workspace")];
    let selected = labels[usize::from(model.ranked)];
    let choose = scope.clone();
    let picker = search::scope_picker(
        "history-search-scope",
        &labels,
        format!("{}: {selected}", t("history.scope")),
    )
    .current(Some(selected))
    .open(model.scope_open)
    .on_toggle(screen::action(&scope, |s| {
        state(s).scope_open = !state(s).scope_open
    }))
    .on_close(screen::action(&scope, |s| state(s).scope_open = false))
    .on_choose(move |s: &mut State, label, _| {
        if !s.current_scope(&choose) {
            return;
        }
        let ranked = label == labels[1];
        state(s).scope_open = false;
        if ranked != state(s).ranked {
            super::clear_selection(s);
            let model = state(s);
            model.ranked = ranked;
            model.reset();
        }
    });
    let drag_scope = scope.clone();
    let title = search::drag_title(
        t("messageSection.search.ariaLabel"),
        move |s: &mut State, gesture, tx| {
            if s.current_scope(&drag_scope) {
                drag(s, gesture, tx)
            }
        },
    )
    .key("history-search-drag");
    let toolbar = layout::action_row()
        .child(title)
        .child(search::build_scope(picker, layers))
        .child(
            search::technical(
                model.technical,
                t("history.technical"),
                screen::action(&scope, |s| {
                    super::clear_selection(s);
                    let model = state(s);
                    model.technical = !model.technical;
                    model.reset();
                }),
            )
            .key("history-search-technical"),
        )
        .child(
            search::close(
                t("messageSection.search.closeAriaLabel"),
                screen::action_tx(&scope, |s, tx| {
                    close(s);
                    tx.focus("history-search-toggle", true);
                }),
            )
            .key("history-search-close"),
        );
    let change = screen::action_tx(&scope, super::query_changed);
    let input = layout::hinted_field(&model.query, t("messageSection.search.placeholder"))
        .label(t("messageSection.search.ariaLabel"))
        .input_mode(rune::InputMode::Search)
        .on_edit(move |s: &mut State| {
            if s.current_scope(&scope) {
                &mut state(s).query
            } else {
                &mut s.rejected_edit
            }
        })
        .on_change(change)
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
        .build(&field_kit(layout::dark()))
        .key(super::FIELD);
    let header = layout::action_row()
        .child(input.remaining())
        .children(model.minimum_hint().map(rune::text));
    let body_scroll = model.body_scroll.0.clone();
    let mut frame = search::body()
        .key(BODY)
        .drawn_rect_into(&model.body_frame.0)
        .on_scroll_offset(move |at| {
            body_scroll.set((at, None));
        })
        .child(header)
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
    if s.transcript_display.timeline.jump.filtered {
        frame = frame.child(
            rune::text(t("history.destinationFiltered"))
                .role("alert")
                .wrap(),
        );
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
            let groups = group_starts(&page.hits);
            frame = frame.child(
                search::results().children(page.hits.iter().enumerate().flat_map(|(i, hit)| {
                    let group = format!("history-result-group-{}", groups[i]);
                    let header = (model.ranked && groups[i] == i)
                        .then(|| {
                            let untitled = t("sessionList.session.untitled");
                            let (title, slug) = match model.labels.get(&hit.session) {
                                Some(Some((title, slug))) => (title.as_str(), Some(slug.as_str())),
                                Some(None) => (t("history.sessionUnavailable"), None),
                                None => (
                                    launch
                                        .and_then(|l| {
                                            l.sessions.iter().find(|r| r.id == hit.session)
                                        })
                                        .map_or(untitled, |row| row.title.as_str()),
                                    None,
                                ),
                            };
                            let title = if title.is_empty() { untitled } else { title };
                            let worktree =
                                slug.and_then(|slug| crate::git::history_worktree(s, slug));
                            rune::text(worktree.map_or_else(
                                || title.to_owned(),
                                |label| format!("{title} · {label}"),
                            ))
                            .text_role(TextRole::Label)
                        })
                        .map(|header| header.key(group.clone()));
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
                    let result =
                        search::result_button(&hit.excerpt, &terms, model.selected == Some(i))
                            .on_press_tx(click)
                            .on_key(move |s, event, tx| {
                                if event.key != rune::Key::Enter {
                                    return false;
                                }
                                keyboard(s, tx);
                                true
                            })
                            .key(key);
                    header.into_iter().chain(std::iter::once(if model.ranked {
                        result.described_by(group)
                    } else {
                        result.description_static(kind)
                    }))
                })),
            );
            if let Some(hit) = model.selected.and_then(|index| page.hits.get(index))
                && s.transcript_display
                    .timeline
                    .backend
                    .as_ref()
                    .is_some_and(|backend| backend.session != hit.session)
            {
                frame = frame.child(preview(s, model, hit, &terms));
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
                    move |s, tx| {
                        super::clear_selection(s);
                        state(s).cursor = Some(cursor.clone());
                        state(s).run();
                        tx.scroll_to_y(BODY, 0.);
                    },
                ));
            }
        }
        _ => {}
    }
    Some(
        search::panel()
            .key(WINDOW)
            .role("region")
            .label_static(t("messageSection.search.ariaLabel"))
            .drawn_rect_into(&model.frame.0)
            .child(toolbar)
            .child(frame),
    )
}

fn preview(
    s: &State,
    model: &super::Search,
    hit: &codenomad_client::search::Hit,
    terms: &[String],
) -> El {
    let data = model.preview.body.as_ref();
    let (title, slug) = data
        .map(|body| (body.title.as_str(), body.slug.as_str()))
        .or_else(|| {
            model
                .labels
                .get(&hit.session)
                .and_then(|label| label.as_ref())
                .map(|(title, slug)| (title.as_str(), slug.as_str()))
        })
        .unwrap_or_default();
    let title = if title.is_empty() {
        t("sessionList.session.untitled")
    } else {
        title
    };
    let worktree = (!slug.is_empty())
        .then(|| crate::git::history_worktree(s, slug))
        .flatten();
    let age = data
        .and_then(|data| data.created)
        .map(|created| super::preview::age(created, crate::platform::storage::unix_millis()));
    let body = search::results()
        .children(
            model
                .preview
                .pending()
                .then(|| rune::text(t("messageSection.search.searching")).role("status")),
        )
        .children(
            model
                .preview
                .failed
                .then(|| rune::text(t("messageSection.search.failed")).role("alert")),
        )
        .children(
            model
                .open_error
                .then(|| rune::text(t("history.openFailed")).role("alert")),
        )
        .children(
            super::preview::blocks(hit, data.map_or(&[], |data| data.blocks.as_slice()))
                .map(|block| search::excerpt(block, terms)),
        );
    let disabled = model.destination.is_some();
    let keyboard = screen::action_tx(&s.input_scope, super::open_result);
    let open = layout::button_tx(
        t("history.openSession"),
        disabled,
        screen::action_tx(&s.input_scope, super::open_result),
    )
    .key("history-search-open");
    let open = if disabled {
        open
    } else {
        open.on_key(move |s, event, tx| {
            if event.key != rune::Key::Enter || event.mods != rune::Mods::default() {
                return false;
            }
            if !tx.key_repeat() {
                keyboard(s, tx);
            }
            true
        })
    };
    search::preview(title, worktree.as_deref(), age, open, body)
        .key("history-inter-session-preview")
}

pub(super) fn group_starts(hits: &[codenomad_client::search::Hit]) -> Vec<usize> {
    let mut start = 0;
    hits.iter()
        .enumerate()
        .map(|(i, hit)| {
            if i == 0 || hits[i - 1].session != hit.session {
                start = i;
            }
            start
        })
        .collect()
}
