use super::{Preferences, t};
use rune::{El, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(in crate::settings) struct Editor {
    owner: Option<String>,
    open: bool,
    selected: Option<String>,
    name: TextEdit,
    value: TextEdit,
    unmasked: bool,
    reveal: bool,
    submitted: bool,
}

impl Editor {
    pub fn poll(&mut self, prefs: &mut Preferences, visible: bool) -> bool {
        prefs.show_environment(visible);
        let owner = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .map(|b| b.client_id.as_str());
        if owner != self.owner.as_deref() {
            *self = Self {
                owner: owner.map(str::to_owned),
                ..Self::default()
            };
            return true;
        }
        if self.submitted && !prefs.environment_pending() {
            self.submitted = false;
            if !prefs.environment_failed() {
                self.reset_fields();
            }
            return true;
        }
        false
    }

    fn reset_fields(&mut self) {
        self.selected = None;
        self.name = TextEdit::default();
        self.value = TextEdit::default();
        self.unmasked = false;
        self.reveal = false;
    }

    fn ready(&self, prefs: &Preferences) -> bool {
        self.open
            && !self.submitted
            && prefs.environment_ready()
            && prefs
                .backend
                .as_ref()
                .is_some_and(|b| Some(&b.client_id) == self.owner.as_ref())
    }

    fn save(&mut self, prefs: &mut Preferences, remove: bool) {
        let name = self
            .selected
            .as_deref()
            .unwrap_or_else(|| self.name.text.trim());
        if !self.ready(prefs)
            || !valid_name(name)
            || self.value.text.len() > 64 * 1024
            || self.value.text.contains('\0')
            || remove && self.selected.is_none()
        {
            return;
        }
        let value = (!remove).then(|| self.value.text.clone());
        self.submitted = prefs.stage_environment(name.to_owned(), value, !self.unmasked);
    }

    pub fn view<S: 'static>(
        &self,
        prefs: &Preferences,
        shared: &Rc<RefCell<Preferences>>,
        edit: fn(&mut S) -> &mut Self,
    ) -> El {
        let document = prefs.environment_document();
        let values = document.and_then(|doc| doc["environmentVariables"].as_object());
        let count = values.map_or(0, |vars| vars.len());
        let title = t("advancedSettings.environmentVariables.title");
        let count = t(if count == 1 {
            "envEditor.count.one"
        } else {
            "envEditor.count.other"
        })
        .replace("{count}", &count.to_string());
        let help = t("advancedSettings.environmentVariables.subtitle");
        let mut body = col().full_width().separate(Space::Sm);
        if self.open {
            let ready = self.ready(prefs);
            let name = t("envEditor.fields.name.placeholder");
            let value = t("envEditor.fields.value.placeholder");
            let save = shared.clone();
            let remove = shared.clone();
            body = body.children(
                values
                    .into_iter()
                    .flat_map(|vars| vars.keys())
                    .filter(|key| valid_name(key))
                    .map(|key| {
                        let label = key.clone();
                        let key = key.clone();
                        let shared = shared.clone();
                        layout::button(&label, !ready, move |s| {
                            let editor = edit(s);
                            let prefs = shared.borrow();
                            let Some(doc) = prefs
                                .environment_document()
                                .filter(|_| editor.ready(&prefs))
                            else {
                                return;
                            };
                            let Some(value) = doc["environmentVariables"][&key].as_str() else {
                                return;
                            };
                            let masked = doc["secureEnvVars"].as_array().into_iter().flatten().any(
                                |candidate| {
                                    candidate.as_str().is_some_and(|candidate| {
                                        candidate.eq_ignore_ascii_case(&key)
                                    })
                                },
                            );
                            editor.reset_fields();
                            editor.name = TextEdit::new(&key);
                            editor.value = TextEdit::new(value);
                            editor.unmasked = !masked;
                            editor.reveal = !masked;
                            editor.selected = Some(key.clone());
                        })
                    }),
            );
            let field = layout::field(&self.value)
                .label(value)
                .secure()
                .revealed(self.reveal)
                .disabled(!ready)
                .on_edit(move |s| &mut edit(s).value);
            body = body
                .child(
                    layout::hinted_field(&self.name, name)
                        .label(name)
                        .disabled(!ready || self.selected.is_some())
                        .on_edit(move |s| &mut edit(s).name)
                        .build(field_kit(layout::dark()))
                        .key("environment-name"),
                )
                .child(
                    field
                        .build(field_kit(layout::dark()))
                        .key("environment-value"),
                )
                .child(
                    layout::action_row()
                        .child(layout::button(
                            t(if self.reveal {
                                "envEditor.fields.secure.disabled"
                            } else {
                                "envEditor.fields.secure.enabled"
                            }),
                            !ready,
                            move |s| {
                                let editor = edit(s);
                                editor.reveal = !editor.reveal;
                            },
                        ))
                        .child(chrome::setting_switch(
                            t("advancedSettings.environmentVariables.maskValue"),
                            !self.unmasked,
                            !ready,
                            move |s| {
                                let editor = edit(s);
                                editor.unmasked = !editor.unmasked;
                            },
                        ))
                        .child(layout::button(
                            t(if self.selected.is_some() {
                                "settings.configFiles.actions.save"
                            } else {
                                "envEditor.actions.add.title"
                            }),
                            !ready
                                || !valid_name(self.name.text.trim())
                                || self.value.text.len() > 64 * 1024,
                            move |s| edit(s).save(&mut save.borrow_mut(), false),
                        ))
                        .children(self.selected.is_some().then(|| {
                            layout::button(t("envEditor.actions.remove.title"), !ready, move |s| {
                                edit(s).save(&mut remove.borrow_mut(), true)
                            })
                        }))
                        .children(self.selected.is_some().then(|| {
                            layout::button(t("envEditor.actions.add.title"), !ready, move |s| {
                                edit(s).reset_fields()
                            })
                        })),
                );
            if prefs.environment_failed() {
                let shared = shared.clone();
                body = body
                    .child(text(t("settings.preferenceSaveFailed")).role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        false,
                        move |_: &mut S| shared.borrow_mut().refresh_environment(),
                    ));
            } else if document.is_none() {
                body = body.child(text(t("rune.loading")).role("status"));
            }
        }
        chrome::card(
            chrome::disclosure(&format!("{title} {count}"), self.open, body, move |s| {
                let editor = edit(s);
                editor.open = !editor.open;
                editor.reveal = false;
            })
            .help(help)
            .description(help),
        )
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && !name.contains('=') && !name.contains(char::is_control)
}
