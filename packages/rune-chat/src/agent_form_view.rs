use crate::{
    State,
    agent_api::{Action, Form},
    agent_forms,
    launcher_view::button,
    strings::t,
};
use rune::{El, col, row, text, text_input, tok::type_};
pub fn view(s: &State, form: &Form) -> El {
    let a = s.agent.as_ref().unwrap();
    let supported = agent_forms::supported(form);
    let mut body = col()
        .w_full()
        .gap(8.0)
        .child(text(t("question")))
        .child(text(&form.title).wrap());
    if !supported {
        body = body.child(text(t("unsupported_question")))
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
                let mut buttons = row().gap(8.0);
                for (label, value) in [("yes", "true"), ("no", "false")] {
                    let id = identity.clone();
                    let label = format!(
                        "{} {}",
                        if d.edit.text == value { "●" } else { "○" },
                        t(label)
                    );
                    buttons = buttons.child(
                        button(&format!("field-{key}-{value}"), &label, a.busy).on_press(
                            move |s: &mut State| {
                                if let Some(d) =
                                    s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                {
                                    d.edit = rune::edit::TextEdit::new(value);
                                    d.dirty = true
                                }
                            },
                        ),
                    );
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
                            let value = value.to_string();
                            let id = identity.clone();
                            body = body.child(
                                button(
                                    &format!("option-{key}-{value}"),
                                    option["label"].as_str().unwrap_or(&value),
                                    a.busy,
                                )
                                .on_press(move |s: &mut State| {
                                    if let Some(d) =
                                        s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                    {
                                        d.edit = rune::edit::TextEdit::new(&value);
                                        d.dirty = true
                                    }
                                }),
                            );
                        }
                    }
                }
                let id = identity.clone();
                body = body.child(
                    text_input(&d.edit, type_::BODY)
                        .key(format!("field-{key}"))
                        .label(key)
                        .w_full()
                        .disabled(a.busy)
                        .on_edit(move |s: &mut State| {
                            let d = s.agent.as_mut().unwrap().drafts.get_mut(&id).unwrap();
                            d.dirty = true;
                            &mut d.edit
                        }),
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
                        body = body.child(
                            button(&format!("multi-{key}-{value}"), &label, a.busy).on_press(
                                move |s: &mut State| {
                                    if let Some(d) =
                                        s.agent.as_mut().and_then(|a| a.drafts.get_mut(&id))
                                    {
                                        if !d.selected.remove(&value) {
                                            d.selected.insert(value.clone());
                                        }
                                        d.dirty = true
                                    }
                                },
                            ),
                        );
                    }
                }
                if field["custom"] == true {
                    let id = identity.clone();
                    body = body.child(
                        text_input(&d.custom, type_::BODY)
                            .key(format!("custom-{key}"))
                            .label(t("other_values"))
                            .w_full()
                            .disabled(a.busy)
                            .on_edit(move |s: &mut State| {
                                let d = s.agent.as_mut().unwrap().drafts.get_mut(&id).unwrap();
                                d.dirty = true;
                                &mut d.custom
                            }),
                    );
                }
            }
            _ => {}
        }
    }
    let id = form.id.clone();
    let cancel = id.clone();
    body.child(
        row()
            .gap(8.0)
            .child(
                button(
                    "answer-question",
                    t("answer"),
                    a.locked() || agent_forms::answer(form, &a.drafts).is_err(),
                )
                .on_press(move |s: &mut State| {
                    if let Some(a) = s.agent.as_mut() {
                        if let Some(f) = a.forms.iter().find(|f| f.id == id) {
                            if let Ok(answer) = agent_forms::answer(f, &a.drafts) {
                                a.act(Action::Answer(id.clone(), answer, f.fields.clone()))
                            }
                        }
                    }
                }),
            )
            .child(
                button("cancel-question", t("cancel_question"), a.locked()).on_press(
                    move |s: &mut State| {
                        if let Some(a) = s.agent.as_mut() {
                            a.act(Action::Cancel(cancel.clone()))
                        }
                    },
                ),
            ),
    )
}
