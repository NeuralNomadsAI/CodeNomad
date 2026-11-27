use crate::{State, agent_api::Form, agent_forms, components::button, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout, textarea},
};
pub fn fields(s: &State, form: &Form) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
    let supported = agent_forms::supported(form);
    let mut body = col()
        .full_width()
        .separate(Space::Sm)
        .child(text(t("permissionApproval.kind.question")))
        .child(text(&form.title).wrap());
    if !supported {
        body = body.child(text(t("rune.unsupported_question")))
    }
    let values = agent_forms::values(form, &a.drafts);
    for field in form
        .fields
        .iter()
        .filter(|f| f["hidden"] != true && agent_forms::active(f, &values))
    {
        let key = field["key"].as_str().unwrap_or_default();
        let identity = (form.id.clone(), key.to_string());
        let Some(d) = a.drafts.get(&identity) else {
            continue;
        };
        body = body.child(text(field["title"].as_str().unwrap_or(key)).wrap());
        match field["type"].as_str() {
            Some("boolean") => {
                let mut buttons = rune_theme_codenomad::layout::action_row().separate(Space::Sm);
                for (label, value) in [("rune.yes", "true"), ("rune.no", "false")] {
                    let id = identity.clone();
                    let label = format!(
                        "{} {}",
                        if d.edit.text == value { "●" } else { "○" },
                        t(label)
                    );
                    buttons = buttons.child(button(
                        &format!("bool-{key}-{value}"),
                        &label,
                        a.busy,
                        crate::screen::action(&scope, move |s: &mut State| {
                            if let Some(d) = s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id)) {
                                d.choose(value)
                            }
                        }),
                    ));
                }
                body = body.child(buttons);
            }
            Some("string" | "number" | "integer") => {
                if field["type"] == "string" {
                    if let Some(options) = field["options"].as_array() {
                        for option in options.iter().take(64) {
                            let Some(value) = option["value"].as_str() else {
                                continue;
                            };
                            let label = option["label"].as_str().unwrap_or(value);
                            let value = value.to_string();
                            let id = identity.clone();
                            body = body.child(button(
                                &format!("option-{key}-{value}"),
                                label,
                                a.busy,
                                crate::screen::action(&scope, move |s: &mut State| {
                                    if let Some(d) =
                                        s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                    {
                                        d.choose(&value)
                                    }
                                }),
                            ));
                        }
                    }
                }
                let id = identity.clone();
                body = body.child(
                    textarea(&d.edit)
                        .label(key)
                        .disabled(a.busy)
                        .on_edit(crate::screen::edit(&scope, crate::screen::Editor::Form(id)))
                        .build(&field_kit(layout::dark()))
                        .key(format!("field-{key}")),
                );
            }
            Some("multiselect") => {
                if let Some(options) = field["options"].as_array() {
                    for option in options.iter().take(64) {
                        let Some(value) = option["value"].as_str() else {
                            continue;
                        };
                        let value = value.to_string();
                        let id = identity.clone();
                        let label = format!(
                            "{} {}",
                            if d.selected.contains(&value) {
                                "☑"
                            } else {
                                "☐"
                            },
                            option["label"].as_str().unwrap_or(&value)
                        );
                        body = body.child(button(
                            &format!("multi-{key}-{value}"),
                            &label,
                            a.busy,
                            crate::screen::action(&scope, move |s: &mut State| {
                                if let Some(d) =
                                    s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.toggle(&value)
                                }
                            }),
                        ));
                    }
                }
                if field["custom"] == true {
                    let id = identity.clone();
                    body = body.child(
                        textarea(&d.custom)
                            .label(t("rune.other_values"))
                            .disabled(a.busy)
                            .on_edit(crate::screen::edit(
                                &scope,
                                crate::screen::Editor::Custom(id),
                            ))
                            .build(&field_kit(layout::dark()))
                            .key(format!("custom-{key}")),
                    );
                }
            }
            _ => {}
        }
    }
    body
}
pub fn actions(s: &State, form: &Form) -> El {
    let Some(a) = s.agent.as_ref() else {
        return rune::el();
    };
    let scope = s.input_scope.clone();
    let id = form.id.clone();
    let cancel = id.clone();
    rune_theme_codenomad::layout::action_row()
        .separate(Space::Sm)
        .child(button(
            "answer-question",
            t("rune.answer"),
            a.forms_locked() || agent_forms::answer(form, &a.drafts).is_err(),
            crate::screen::action(&scope, move |s: &mut State| {
                if let Some(a) = s.agent.as_mut() {
                    a.answer_form(&id)
                }
            }),
        ))
        .child(button(
            "cancel-question",
            t("rune.cancel_question"),
            a.forms_locked(),
            crate::screen::action(&scope, move |s: &mut State| {
                if let Some(a) = s.agent.as_mut() {
                    a.cancel_form(cancel.clone())
                }
            }),
        ))
}
