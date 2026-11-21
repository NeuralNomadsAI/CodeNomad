use crate::{Phase, State, agent_api::Action, launcher_view::button, strings::t};
use rune::{El, ScrollSpec, col, row, text, text_input, tok::type_};
pub fn view(s: &State) -> El {
    let Some(a) = &s.agent else { return rune::el() };
    let label = a
        .models
        .iter()
        .find(|m| Some(&m.reference) == a.current.as_ref())
        .map(|m| m.label.as_str())
        .unwrap_or(t("model"));
    let mut body = col().w_full().gap(8.0).padding(10.0).child(
        row()
            .gap(10.0)
            .child(
                button("model-picker", label, a.busy).on_press(|s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.picker = !a.picker;
                        if a.picker {
                            a.refresh(true)
                        }
                    }
                }),
            )
            .child(
                button("controls-refresh", t("refresh_controls"), a.busy).on_press(
                    |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.error = false;
                            a.refresh(true)
                        }
                    },
                ),
            )
            .child(
                button(
                    "stop-response",
                    t("stop"),
                    a.stopping || !(a.running || s.phase == Phase::Streaming),
                )
                .on_press(|s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.stop()
                    }
                }),
            ),
    );
    if a.error {
        body = body.child(text(t("control_error")))
    }
    if a.picker {
        let mut list = col().w_full().gap(4.0);
        let query = a.search.text.to_lowercase();
        for model in a
            .models
            .iter()
            .filter(|m| m.label.to_lowercase().contains(&query))
        {
            let reference = model.reference.clone();
            list = list.child(
                button(
                    &format!("model-{}", reference),
                    &model.label,
                    a.locked() || s.phase != Phase::Ready,
                )
                .on_press(move |s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.act(Action::Model(reference.clone()));
                        a.picker = false
                    }
                }),
            );
        }
        body = body.child(
            text_input(&a.search, type_::BODY)
                .key("model-search")
                .label(t("find_model"))
                .single_line()
                .w_full()
                .on_edit(|s: &mut State| &mut s.agent.as_mut().unwrap().search),
        );
        body = body.child(list.h(160.0).scroll(ScrollSpec {
            stick_bottom: false,
        }));
    }
    let ids = a.ids();
    if !ids.is_empty() {
        let i = ids.iter().position(|id| *id == a.selected).unwrap_or(0);
        let prev = ids[i.saturating_sub(1)].clone();
        let next = ids[(i + 1).min(ids.len() - 1)].clone();
        body = body.child(
            row()
                .gap(10.0)
                .child(
                    button("pending-prev", t("previous_request"), i == 0).on_press(
                        move |s: &mut State| s.agent.as_mut().unwrap().selected = prev.clone(),
                    ),
                )
                .child(text(format!("{} / {}", i + 1, ids.len())))
                .child(
                    button("pending-next", t("next_request"), i + 1 == ids.len()).on_press(
                        move |s: &mut State| s.agent.as_mut().unwrap().selected = next.clone(),
                    ),
                ),
        );
        let content = if let Some(p) = a.permissions.iter().find(|p| p.id == a.selected) {
            let mut panel = col()
                .gap(6.0)
                .w_full()
                .child(text(t("permission")))
                .child(text(&p.action));
            for resource in &p.resources {
                panel = panel.child(text(resource).wrap().selectable(true))
            }
            if !p.message.is_empty() {
                panel = panel.child(text(&p.message).wrap().selectable(true))
            }
            let id = p.id.clone();
            panel = panel.child(
                text_input(&a.reasons[&p.id], type_::BODY)
                    .key(format!("reason-{id}"))
                    .label(t("reason"))
                    .w_full()
                    .on_edit(move |s: &mut State| {
                        s.agent.as_mut().unwrap().reasons.get_mut(&id).unwrap()
                    }),
            );
            let mut actions = row().gap(8.0);
            for (key, decision) in [
                ("allow_once", "once"),
                ("allow_always", "always"),
                ("reject", "reject"),
            ] {
                let id = p.id.clone();
                actions = actions.child(button(key, t(key), a.locked() || !p.supported).on_press(
                    move |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            let message = a
                                .reasons
                                .get(&id)
                                .map(|v| v.text.clone())
                                .unwrap_or_default();
                            a.act(Action::Permission(id.clone(), decision.into(), message))
                        }
                    },
                ));
            }
            panel.child(actions)
        } else if let Some(f) = a.forms.iter().find(|f| f.id == a.selected) {
            crate::agent_form_view::view(s, f)
        } else {
            rune::el()
        };
        body = body.child(
            col()
                .key(format!("pending-content-{}", a.selected))
                .w_full()
                .max_h(240.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .child(content),
        );
    }
    body
}
