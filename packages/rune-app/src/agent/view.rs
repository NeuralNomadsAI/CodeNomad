use crate::{Phase, State, launcher_view::button, strings::t};
use rune::{Cx, El, col, text};
use rune_theme_codenomad::interruption;
use rune_theme_codenomad::{
    Space,
    layout::{Layout, input},
};
pub fn view(s: &State, cx: &Cx<State>) -> El {
    let Some(a) = &s.agent else { return rune::el() };
    let label = a
        .models
        .iter()
        .find(|m| Some(&m.reference) == a.current.as_ref())
        .map(|m| m.label.as_str())
        .unwrap_or(t("model"));
    let pending = !a.ids().is_empty();
    let mut body = interruption::panel(cx, a.picker, pending).child(
        rune_theme_codenomad::layout::action_row()
            .key("agent-actions")
            .separate(Space::Sm)
            .child(
                button("model-picker", label, a.busy).on_press(|s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.toggle_picker()
                    }
                }),
            )
            .child(
                button("controls-refresh", t("refresh_controls"), a.busy).on_press(
                    |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.refresh_controls()
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
        let mut list = col().key("model-items").full_width().separate(Space::Xs);
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
                        a.choose_model(reference.clone())
                    }
                }),
            );
        }
        body = body.child(
            input(&a.search)
                .key("model-search")
                .label(t("find_model"))
                .single_line()
                .full_width()
                .on_edit(|s: &mut State| &mut s.agent.as_mut().unwrap().search),
        );
        body = body.child(interruption::scroll_region().key("model-list").child(list));
    }
    let ids = a.ids();
    if !ids.is_empty() {
        let i = ids.iter().position(|id| *id == a.selected).unwrap_or(0);
        let prev = ids[i.saturating_sub(1)].clone();
        let next = ids[(i + 1).min(ids.len() - 1)].clone();
        body = body.child(
            rune_theme_codenomad::layout::action_row()
                .key("pending-navigation")
                .separate(Space::Sm)
                .child(
                    button("pending-prev", t("previous_request"), i == 0).on_press(
                        move |s: &mut State| s.agent.as_mut().unwrap().select_request(prev.clone()),
                    ),
                )
                .child(text(format!("{} / {}", i + 1, ids.len())))
                .child(
                    button("pending-next", t("next_request"), i + 1 == ids.len()).on_press(
                        move |s: &mut State| s.agent.as_mut().unwrap().select_request(next.clone()),
                    ),
                ),
        );
        let (content, footer) = if let Some(p) = a.permissions.iter().find(|p| p.id == a.selected) {
            let mut panel = col()
                .separate(Space::Xs)
                .full_width()
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
                input(&a.reasons[&p.id])
                    .key(format!("reason-{id}"))
                    .label(t("reason"))
                    .full_width()
                    .on_edit(move |s: &mut State| {
                        s.agent.as_mut().unwrap().reasons.get_mut(&id).unwrap()
                    }),
            );
            let mut actions = rune_theme_codenomad::layout::action_row().separate(Space::Sm);
            for (key, decision) in [
                ("allow_once", "once"),
                ("allow_always", "always"),
                ("reject", "reject"),
            ] {
                let id = p.id.clone();
                actions = actions.child(button(key, t(key), a.locked() || !p.supported).on_press(
                    move |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.reply_permission(id.clone(), decision)
                        }
                    },
                ));
            }
            (panel, actions)
        } else if let Some(f) = a.forms.iter().find(|f| f.id == a.selected) {
            (
                crate::agent_form_view::fields(s, f),
                crate::agent_form_view::actions(s, f),
            )
        } else {
            (rune::el(), rune::el())
        };
        body = body
            .child(
                interruption::scroll_region()
                    .key(format!("pending-content-{}", a.selected))
                    .child(content.key("pending-fields")),
            )
            .child(footer.key("pending-actions"));
    }
    body
}
