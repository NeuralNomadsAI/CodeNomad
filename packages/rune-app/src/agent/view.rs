use crate::{Phase, State, components::button, strings::t};
use rune::{Cx, El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit, form_controls,
    git_panel::{self, ButtonLook},
    interruption,
    layout::{self, Layout, textarea},
    shell,
};

pub(crate) fn offline_status(a: &super::Ui) -> Option<El> {
    (!a.online && a.known).then(|| {
        form_controls::field_description(t("rune.reconnecting"))
            .role("status")
            .key("pending-offline-status")
    })
}
pub fn view(s: &State, cx: &Cx<State>, layout_viewport_height: Option<f32>) -> El {
    let Some(a) = &s.agent else { return rune::el() };
    let scope = s.input_scope.clone();
    let label = a
        .models
        .iter()
        .find(|m| Some(&m.reference) == a.current.as_ref())
        .map(|m| m.label.as_str())
        .unwrap_or(t("rune.model"));
    let ids = a.ids();
    let pending = !ids.is_empty();
    let mut body = interruption::panel(
        cx,
        a.picker,
        pending,
        ids.len() > 1,
        a.error,
        layout_viewport_height,
    )
    .child(
        rune_theme_codenomad::layout::action_row()
            .key("agent-actions")
            .separate(Space::Sm)
            .child(
                button(
                    "model-picker",
                    label,
                    a.busy,
                    crate::screen::action(&scope, |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.toggle_picker()
                        }
                    }),
                )
                .expanded(a.picker),
            )
            .child(button(
                "controls-refresh",
                t("rune.refresh_controls"),
                a.busy,
                crate::screen::action(&scope, |s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.refresh_controls()
                    }
                }),
            ))
            .child(button(
                "stop-response",
                t("rune.stop"),
                a.stopping || !(a.running || s.phase == Phase::Streaming),
                crate::screen::action(&scope, |s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        a.stop()
                    }
                }),
            )),
    );
    if a.error {
        body = body.child(form_controls::field_error(
            "agent-error",
            t("rune.control_error"),
        ));
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
            let selected = Some(&model.reference) == a.current.as_ref();
            list = list.child(
                git_panel::button(
                    &model.label,
                    if selected {
                        ButtonLook::Neutral
                    } else {
                        ButtonLook::Flat
                    },
                    a.model_locked() || s.phase != Phase::Ready,
                    crate::screen::action_tx(&scope, move |s: &mut State, _tx| {
                        if let Some(a) = s.agent.as_mut() {
                            a.choose_model(reference.clone())
                        }
                    }),
                )
                .checked(selected)
                .key(format!("model-{}", model.reference)),
            );
        }
        body = body.child(
            layout::hinted_field(&a.search, t("rune.find_model"))
                .label(t("rune.find_model"))
                .input_mode(rune::InputMode::Search)
                .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Model))
                .build(&field_kit(layout::dark()))
                .key("model-search"),
        );
        body = body.child(crate::chat::reading::track_other_scroller_hover(
            interruption::scroll_region().key("model-list").child(list),
            crate::chat::reading::HOVER_MODEL_LIST,
        ));
    }
    if !ids.is_empty() {
        if ids.len() > 1 {
            let i = ids.iter().position(|id| *id == a.selected).unwrap_or(0);
            let prev = ids[i.saturating_sub(1)].clone();
            let next = ids[(i + 1).min(ids.len() - 1)].clone();
            body = body.child(
                rune_theme_codenomad::layout::action_row()
                    .key("pending-navigation")
                    .separate(Space::Sm)
                    .child(
                        git_panel::icon_button(
                            &shell::icons::BACK,
                            t("interruption.previous"),
                            i == 0,
                            None,
                            crate::screen::action_tx(&scope, move |s: &mut State, _tx| {
                                if let Some(a) = &mut s.agent {
                                    a.select_request(prev.clone());
                                }
                            }),
                        )
                        .key("pending-prev"),
                    )
                    .child(
                        form_controls::field_description(&format!("{} / {}", i + 1, ids.len()))
                            .role("status")
                            .key("pending-position"),
                    )
                    .child(
                        git_panel::icon_button(
                            &shell::icons::FORWARD,
                            t("interruption.next"),
                            i + 1 == ids.len(),
                            None,
                            crate::screen::action_tx(&scope, move |s: &mut State, _tx| {
                                if let Some(a) = &mut s.agent {
                                    a.select_request(next.clone());
                                }
                            }),
                        )
                        .key("pending-next"),
                    ),
            );
        }
        let (content, footer) = if let Some(p) = a.permissions.iter().find(|p| p.id == a.selected) {
            let header = if p.action.is_empty() {
                form_controls::form_title(t("permissionApproval.kind.permission"))
                    .key("form-eyebrow")
            } else {
                form_controls::form_header(
                    t("permissionApproval.kind.permission"),
                    &p.action,
                    false,
                )
            };
            let mut panel = col().separate(Space::Sm).full_width().child(header);
            if let Some(status) = offline_status(a) {
                panel = panel.child(status);
            }
            if !p.resources.is_empty() {
                let mut resources = col()
                    .key("permission-resources")
                    .full_width()
                    .pad(Space::Sm)
                    .separate(Space::Xs)
                    .inset_surface();
                for resource in &p.resources {
                    resources = resources.child(
                        text(resource)
                            .text_role(TextRole::Mono)
                            .wrap_anywhere()
                            .selectable(true),
                    );
                }
                panel = panel.child(resources);
            }
            if !p.message.is_empty() {
                panel = panel.child(
                    form_controls::field_description(&p.message)
                        .selectable(true)
                        .key("permission-message"),
                );
            }
            let id = p.id.clone();
            panel = panel
                .child(form_controls::field_heading(t("rune.reason"), false).a11y_hidden())
                .child(
                    textarea(&a.reasons[&p.id])
                        .label(t("rune.reason"))
                        .on_edit(crate::screen::edit(
                            &scope,
                            crate::screen::Editor::Reason(id),
                        ))
                        .build(&field_kit(layout::dark()))
                        .key(format!("reason-{}", p.id)),
                );
            let mut actions = rune_theme_codenomad::layout::action_row().separate(Space::Sm);
            for (key, label, decision) in [
                ("allow_once", "rune.allow_once", "once"),
                ("allow_always", "rune.allow_always", "always"),
                ("reject", "rune.reject", "reject"),
            ] {
                let id = p.id.clone();
                let disabled = a.permissions_locked() || (!p.supported && decision != "reject");
                actions = actions.child(button(
                    key,
                    t(label),
                    disabled,
                    crate::screen::action(&scope, move |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.reply_permission(id.clone(), decision)
                        }
                    }),
                ));
            }
            (panel, actions)
        } else if let Some(f) = a.forms.iter().find(|f| f.id == a.selected) {
            crate::agent_form_view::form_panel(s, f)
        } else {
            (rune::el(), rune::el())
        };
        body = body
            .child(crate::chat::reading::track_other_scroller_hover(
                interruption::scroll_region()
                    .key(format!("pending-content-{}", a.selected))
                    .on_layout_tx(|s: &mut State, rect, tx| {
                        if !s.screen.is_launcher() {
                            crate::chat::ToolDiffPreferences::pending_content_layout(s, rect, tx);
                        } else {
                            tx.live_only();
                        }
                    })
                    .child(content.key("pending-fields").on_layout_tx(
                        |s: &mut State, rect, tx| {
                            if !s.screen.is_launcher() {
                                crate::chat::ToolDiffPreferences::pending_fields_layout(
                                    s, rect, tx,
                                );
                            } else {
                                tx.live_only();
                            }
                        },
                    )),
                crate::chat::reading::HOVER_PENDING_FIELDS,
            ))
            .child(footer.key("pending-actions"));
    }
    body
}
