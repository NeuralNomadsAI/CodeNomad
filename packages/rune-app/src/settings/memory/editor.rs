use super::{
    El, Layout, chrome, col, layout,
    review::{Action, Edit, Fields, Review},
    t, text,
};
use codenomad_client::settings::memory::{Kind, valid_title};
use rune::edit::TextEdit;
use rune_theme_codenomad::{Space, field_kit};

#[derive(Default)]
pub(in crate::settings) struct Editor {
    edit: Option<Edit>,
    owner_gen: Option<u64>,
    title: TextEdit,
    text: TextEdit,
    kind: Option<Kind>,
    confirmation: Option<Confirmation>,
    submitted: bool,
    error: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum Confirmation {
    Discard,
    Forget,
    Reload,
}

impl Editor {
    pub fn open(&mut self, edit: Edit) {
        if self.edit.is_none() {
            *self = Self {
                title: TextEdit::new(&edit.entry.title),
                text: TextEdit::new(&edit.entry.text),
                kind: Some(edit.entry.kind),
                edit: Some(edit),
                ..Self::default()
            };
        }
    }

    pub fn shown(&self) -> bool {
        self.edit.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn has_unsaved(&self) -> bool {
        self.edit.as_ref().is_some_and(|edit| self.dirty(edit))
    }

    #[cfg(test)]
    pub(in crate::settings) fn fixture_dirty(&mut self) {
        self.open(Edit::fixture());
        self.text = TextEdit::new("Unsaved text");
    }

    #[cfg(test)]
    pub(in crate::settings) fn mark_submitted(&mut self) {
        self.submitted = true;
    }

    #[cfg(test)]
    pub(in crate::settings) fn edit_text(&mut self, value: &str) {
        self.text = TextEdit::new(value);
    }

    #[cfg(test)]
    pub(in crate::settings) fn draft_text(&self) -> &str {
        &self.text.text
    }

    pub fn dismiss(&mut self) {
        if self.submitted {
            return;
        }
        if self.confirmation.take().is_some() {
            return;
        }
        if self.edit.as_ref().is_some_and(|edit| self.dirty(edit)) {
            self.confirmation = Some(Confirmation::Discard);
        } else {
            *self = Self::default();
        }
    }

    fn dirty(&self, edit: &Edit) -> bool {
        self.title.text != edit.entry.title
            || self.text.text != edit.entry.text
            || self.kind != Some(edit.entry.kind)
    }

    pub(super) fn poll(
        &mut self,
        review: &Review,
        backend: Option<&codenomad_client::backend::Backend>,
        owner_gen: u64,
    ) -> bool {
        if let Some(edit) = self.edit.as_ref() {
            let switched_owner = self.owner_gen.is_some_and(|seen| seen != owner_gen)
                || backend.is_some_and(|b| !edit.belongs_to_backend(b));
            if switched_owner {
                *self = Self::default();
                return true;
            }
            self.owner_gen = Some(owner_gen);
        }
        if self.submitted {
            if let Some(result) = self
                .edit
                .as_ref()
                .and_then(|edit| review.write_result(edit))
            {
                match result {
                    Ok(()) => *self = Self::default(),
                    Err(error) => {
                        self.error = Some(error);
                        self.submitted = false;
                    }
                };
                return true;
            }
            if !review.writing() {
                self.error = Some("settings.memory.error.conflict");
                self.submitted = false;
                return true;
            }
        }
        false
    }

    pub(super) fn view<S: 'static>(
        &self,
        review: &Review,
        access: fn(&mut S) -> &mut Self,
        apply: impl Fn(&mut S, Action) -> bool + Clone + 'static,
    ) -> Option<El> {
        let edit = self.edit.as_ref()?;
        let disabled = self.submitted || review.writing() || !review.writable(edit);
        let key = "settings.memory.error.conflict";
        let revalidation_error = review
            .failed()
            .filter(|_| !self.submitted && review.is_current(edit));
        let error = self
            .error
            .or(revalidation_error)
            .or_else(|| (!review.is_current(edit) && !self.submitted).then_some(key));
        let dark = layout::dark();
        if let Some(confirm) = self.confirmation {
            let (message, label) = match confirm {
                Confirmation::Discard | Confirmation::Reload => (
                    t("settings.memory.discard").into(),
                    t("settings.memory.discardConfirm"),
                ),
                Confirmation::Forget => (
                    t("settings.memory.forgetConfirm").replace("{title}", &edit.entry.title),
                    t("settings.memory.forget"),
                ),
            };
            return Some(rune_theme_codenomad::document_reader::editor::confirmation(
                dark,
                &message,
                t("settings.memory.cancel"),
                label,
                move |s: &mut S, accept, _| {
                    let editor = access(s);
                    editor.confirmation = None;
                    if !accept {
                        return;
                    }
                    match confirm {
                        Confirmation::Discard => *editor = Self::default(),
                        Confirmation::Reload => {
                            *editor = Self::default();
                            apply(s, Action::Retry);
                        }
                        Confirmation::Forget => {
                            if let Some(edit) = editor.edit.clone() {
                                let admitted = apply(s, Action::Write(edit, None));
                                let state = access(s);
                                if admitted {
                                    state.error = None;
                                }
                                state.submitted = admitted;
                            }
                        }
                    }
                },
            ));
        }
        let title_valid = valid_title(&self.title.text);
        let text_valid = self.text.text.chars().count() <= 2000;
        let title = t("settings.memory.entryTitle");
        let body = t("settings.memory.text");
        const KINDS: [Kind; 3] = [Kind::Fact, Kind::Preference, Kind::Reference];
        let values = KINDS.map(|kind| {
            t(match kind {
                Kind::Fact => "settings.memory.type.fact",
                Kind::Preference => "settings.memory.type.preference",
                Kind::Reference => "settings.memory.type.reference",
            })
        });
        let save_apply = apply.clone();
        let form = col()
            .full_width()
            .separate(Space::Sm)
            .children(
                edit.entry
                    .flagged
                    .then(|| text(t("settings.memory.excluded")).role("status")),
            )
            .child(text(title))
            .child(
                layout::field(&self.title)
                    .label(title)
                    .invalid(!title_valid)
                    .disabled(disabled)
                    .on_edit(move |s| &mut access(s).title)
                    .build(&field_kit(dark))
                    .key("memory-title"),
            )
            .child(count(&self.title.text, 60))
            .children((!title_valid).then(|| text(t("settings.memory.titleInvalid")).role("alert")))
            .child(chrome::segments(
                t("settings.memory.entryType"),
                &values,
                KINDS.iter().position(|kind| Some(*kind) == self.kind),
                disabled,
                move |s, index| access(s).kind = KINDS.get(index).copied(),
            ))
            .child(text(body))
            .child(
                layout::textarea(&self.text)
                    .rows(8)
                    .label(body)
                    .disabled(disabled)
                    .on_edit(move |s| &mut access(s).text)
                    .build(&field_kit(dark))
                    .key("memory-text"),
            )
            .child(count(&self.text.text, 2000))
            .children((!text_valid).then(|| text(t("settings.memory.textInvalid")).role("alert")))
            .children(error.map(|error| text(t(error)).wrap().role("alert")))
            .child(
                layout::action_row()
                    .child(layout::button(
                        t("settings.memory.save"),
                        disabled || !title_valid || !text_valid || !self.dirty(edit),
                        move |s: &mut S| {
                            let state = access(s);
                            if let (Some(edit), Some(kind)) = (state.edit.clone(), state.kind)
                                && valid_title(&state.title.text)
                                && state.text.text.chars().count() <= 2000
                            {
                                let fields = Fields {
                                    title: state.title.text.clone(),
                                    text: state.text.text.clone(),
                                    kind,
                                };
                                let admitted = save_apply(s, Action::Write(edit, Some(fields)));
                                let state = access(s);
                                if admitted {
                                    state.error = None;
                                }
                                state.submitted = admitted;
                            }
                        },
                    ))
                    .child(layout::button(
                        t("settings.memory.forget"),
                        disabled,
                        move |s| {
                            access(s).confirmation = Some(Confirmation::Forget);
                        },
                    ))
                    .children(revalidation_error.map(|_| {
                        let retry = apply.clone();
                        layout::button(
                            t("settings.memory.retry"),
                            self.submitted || review.loading(),
                            move |s| {
                                retry(s, Action::Retry);
                            },
                        )
                    }))
                    .children(
                        (self.error.is_some() || (!review.is_current(edit) && !self.submitted))
                            .then(|| {
                                layout::button(
                                    t("settings.memory.reload"),
                                    self.submitted,
                                    move |s| {
                                        access(s).confirmation = Some(Confirmation::Reload);
                                    },
                                )
                            }),
                    ),
            );
        Some(chrome::embedded_section(
            &edit.entry.title,
            form,
            layout::button(t("settings.memory.cancel"), self.submitted, move |s| {
                access(s).dismiss()
            }),
            move |s| access(s).dismiss(),
        ))
    }
}

fn count(value: &str, limit: usize) -> El {
    text(
        t("settings.memory.characters")
            .replace("{count}", &value.chars().count().to_string())
            .replace("{limit}", &limit.to_string()),
    )
}
