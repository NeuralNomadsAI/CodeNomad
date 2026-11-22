use crate::{Phase, State, launcher_view::button, strings::t};
use rune::{Cx, El, col, text};
use rune_theme_codenomad::interruption;
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout, field, textarea},
};
pub fn view(s: &State, cx: &Cx<State>) -> El {
    let Some(a) = &s.agent else { return rune::el() };
    let scope = s.input_scope.clone();
    let label = a
        .models
        .iter()
        .find(|m| Some(&m.reference) == a.current.as_ref())
        .map(|m| m.label.as_str())
        .unwrap_or(t("rune.model"));
    let pending = !a.ids().is_empty();
    let mut body = interruption::panel(cx, a.picker, pending).child(
        rune_theme_codenomad::layout::action_row()
            .key("agent-actions")
            .separate(Space::Sm)
            .child(
                button("model-picker", label, a.busy).on_press(crate::screen::action(
                    &scope,
                    |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.toggle_picker()
                        }
                    },
                )),
            )
            .child(
                button("controls-refresh", t("rune.refresh_controls"), a.busy).on_press(
                    crate::screen::action(&scope, |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.refresh_controls()
                        }
                    }),
                ),
            )
            .child(
                button(
                    "stop-response",
                    t("rune.stop"),
                    a.stopping || !(a.running || s.phase == Phase::Streaming),
                )
                .on_press(crate::screen::action(&scope, |s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.stop()
                    }
                })),
            ),
    );
    if a.error {
        body = body.child(text(t("rune.control_error")))
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
                .on_press(crate::screen::action(&scope, move |s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.choose_model(reference.clone())
                    }
                })),
            );
        }
        body = body.child(
            field(&a.search)
                .label(t("rune.find_model"))
                .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Model))
                .build(field_kit(layout::dark()))
                .key("model-search"),
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
                    button("pending-prev", t("interruption.previous"), i == 0).on_press(
                        crate::screen::action(&scope, move |s| {
                            if let Some(a) = &mut s.agent {
                                a.select_request(prev.clone());
                            }
                        }),
                    ),
                )
                .child(text(format!("{} / {}", i + 1, ids.len())))
                .child(
                    button("pending-next", t("interruption.next"), i + 1 == ids.len()).on_press(
                        crate::screen::action(&scope, move |s| {
                            if let Some(a) = &mut s.agent {
                                a.select_request(next.clone());
                            }
                        }),
                    ),
                ),
        );
        let (content, footer) = if let Some(p) = a.permissions.iter().find(|p| p.id == a.selected) {
            let mut panel = col()
                .separate(Space::Xs)
                .full_width()
                .child(text(t("permissionApproval.kind.permission")))
                .child(text(&p.action));
            for resource in &p.resources {
                panel = panel.child(text(resource).wrap().selectable(true))
            }
            if !p.message.is_empty() {
                panel = panel.child(text(&p.message).wrap().selectable(true))
            }
            let id = p.id.clone();
            panel = panel.child(
                textarea(&a.reasons[&p.id])
                    .label(t("rune.reason"))
                    .on_edit(crate::screen::edit(
                        &scope,
                        crate::screen::Editor::Reason(id),
                    ))
                    .build(field_kit(layout::dark()))
                    .key(format!("reason-{}", p.id)),
            );
            let mut actions = rune_theme_codenomad::layout::action_row().separate(Space::Sm);
            for (key, label, decision) in [
                ("allow_once", "rune.allow_once", "once"),
                ("allow_always", "rune.allow_always", "always"),
                ("reject", "rune.reject", "reject"),
            ] {
                let id = p.id.clone();
                actions =
                    actions.child(button(key, t(label), a.locked() || !p.supported).on_press(
                        crate::screen::action(&scope, move |s: &mut State| {
                            if let Some(a) = s.agent.as_mut() {
                                a.reply_permission(id.clone(), decision)
                            }
                        }),
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
