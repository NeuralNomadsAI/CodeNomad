use super::{Preferences, t};
use rune::{El, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(in crate::settings) struct Editor {
    owner: Option<String>,
    open: bool,
    info_open: bool,
    selected: Option<String>,
    name: TextEdit,
    value: TextEdit,
    unmasked: bool,
    mask_changed: bool,
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
        self.mask_changed = false;
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
        let mask = if remove {
            Some(false)
        } else if !self.unmasked {
            // Whenever "Mask value" is ON, always assert the mask so a concurrent deletion can
            // never recreate the secret in plaintext.
            Some(true)
        } else if self.mask_changed {
            Some(false)
        } else {
            None
        };
        self.submitted = prefs.stage_environment(name.to_owned(), value, mask);
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
            let existing_buttons: Vec<El> = values
                .into_iter()
                .flat_map(|vars| vars.keys())
                .filter(|key| valid_name(key))
                .map(|key| {
                    let label = key.clone();
                    let key = key.clone();
                    let shared = shared.clone();
                    chrome::secondary_action(&label, !ready, move |s| {
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
                        let masked = super::super::preferences::env_var_is_masked(doc, &key);
                        editor.reset_fields();
                        editor.name = TextEdit::new(&key);
                        editor.value = TextEdit::new(value);
                        editor.unmasked = !masked;
                        editor.reveal = !masked;
                        editor.selected = Some(key.clone());
                    })
                })
                .collect();
            if !existing_buttons.is_empty() {
                body = body.child(layout::action_row().children(existing_buttons));
            }
            let field = layout::field(&self.value)
                .label(value)
                .secure()
                .autofill(rune::Autofill::Off)
                .revealed(self.reveal)
                .disabled(!ready)
                .on_edit(move |s| &mut edit(s).value);
            let mask_title = t("advancedSettings.environmentVariables.maskValue");
            body = body
                .child(
                    layout::hinted_field(&self.name, name)
                        .label(name)
                        .disabled(!ready || self.selected.is_some())
                        .on_edit(move |s| &mut edit(s).name)
                        .build(&field_kit(layout::dark()))
                        .key("environment-name"),
                )
                .child(
                    field
                        .build(&field_kit(layout::dark()))
                        .key("environment-value"),
                )
                .child(chrome::setting_row(
                    mask_title,
                    chrome::setting_switch(
                        mask_title,
                        !self.unmasked,
                        !ready || !prefs.supports_atomic_settings_patches(),
                        move |s| {
                            let editor = edit(s);
                            editor.unmasked = !editor.unmasked;
                            editor.mask_changed = true;
                        },
                    ),
                ))
                .child(
                    layout::action_row()
                        .child(chrome::primary_action(
                            t(if self.selected.is_some() {
                                "settings.configFiles.actions.save"
                            } else {
                                "envEditor.actions.add.title"
                            }),
                            !ready
                                || (!prefs.supports_atomic_settings_patches()
                                    && (self.selected.is_none()
                                        || self.mask_changed
                                        || !self.unmasked))
                                || !valid_name(self.name.text.trim())
                                || self.value.text.len() > 64 * 1024,
                            move |s| edit(s).save(&mut save.borrow_mut(), false),
                        ))
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
                        .children(self.selected.is_some().then(|| {
                            layout::button(
                                t("envEditor.actions.remove.title"),
                                !ready || !prefs.supports_atomic_settings_patches(),
                                move |s| edit(s).save(&mut remove.borrow_mut(), true),
                            )
                        }))
                        .children(self.selected.is_some().then(|| {
                            layout::button(t("envEditor.actions.add.title"), !ready, move |s| {
                                edit(s).reset_fields()
                            })
                        })),
                );
            if prefs.environment_failed() {
                let shared = shared.clone();
                body = body.child(
                    layout::action_row()
                        .child(chrome::palette::save_error(t(
                            "settings.preferenceSaveFailed",
                        )))
                        .child(layout::button(
                            t("sessionList.loadError.retry"),
                            false,
                            move |_: &mut S| shared.borrow_mut().refresh_environment(),
                        )),
                );
            } else if document.is_none() {
                body = body.child(
                    text(t("rune.loading"))
                        .text_role(TextRole::Small)
                        .role("status"),
                );
            }
        }
        let info = chrome::info_tip(title, help, self.info_open, move |s| {
            let editor = edit(s);
            editor.info_open = !editor.info_open;
        })
        .key("environment-variables-info");
        chrome::card(
            chrome::disclosure_with_meta(
                title,
                Some(&count),
                Some(info),
                Some(chrome::server_scope_badge(t("settings.scope.server"))),
                self.open,
                body,
                move |s| {
                    let editor = edit(s);
                    editor.open = !editor.open;
                    editor.reveal = false;
                },
            )
            .help(help)
            .description(help),
        )
    }
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && !name.contains('=') && !name.contains(char::is_control)
}
