use super::super::Preferences;
use crate::{history::Result, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{BinaryValidation, OpenCodeStatus, validate_opencode_binary},
};
use rune::{El, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

#[derive(Default)]
pub(super) struct State {
    authority: Option<String>,
    custom_open: bool,
    custom_path: TextEdit,
    validation_error: Option<String>,
    versions: BTreeMap<String, String>,
    validated: BTreeSet<String>,
    bg_flight: Option<(String, Sender<()>, Receiver<Result<BinaryValidation>>)>,
    submit_flight: Option<(String, Sender<()>, Receiver<Result<BinaryValidation>>)>,
    last_selected: Option<String>,
}

impl State {
    pub(super) fn poll(
        &mut self,
        prefs: &mut Preferences,
        wake: &rune::Waker,
        status: Option<&OpenCodeStatus>,
    ) -> (bool, bool) {
        let backend = prefs
            .backend
            .as_ref()
            .filter(|_| prefs.can_retry())
            .cloned();
        let authority = backend.as_ref().map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                ..Self::default()
            };
        }
        let mut binary_changed = false;
        let current_selected = prefs.opencode_binary();
        if current_selected != self.last_selected {
            if self.last_selected.is_some() && current_selected.is_some() {
                binary_changed = true;
            }
            self.last_selected = current_selected;
            changed = true;
        }
        for entry in prefs.opencode_binaries() {
            if let Some(version) = entry.version
                && !self.versions.contains_key(&entry.path)
            {
                self.versions.insert(entry.path, version);
                changed = true;
            }
        }
        if let Some(status) = status
            && status.has_installation_source
            && let Some(version) = &status.current
            && self.versions.get("opencode2") != Some(version)
        {
            self.versions.insert("opencode2".into(), version.clone());
            self.validated.insert("opencode2".into());
            changed = true;
        }

        if prefs.opencode_install.busy() {
            if self.submit_flight.take().is_some() || self.bg_flight.take().is_some() {
                changed = true;
            }
            return (changed, binary_changed);
        }

        let submit_done = self
            .submit_flight
            .as_ref()
            .and_then(|(path, _, rx)| rx.try_recv().ok().map(|res| (path.clone(), res)));
        if let Some((path, result)) = submit_done {
            self.submit_flight = None;
            changed = true;
            match result {
                Ok(validation) if validation.valid => {
                    self.validated.insert(path.clone());
                    if let Some(version) = &validation.version {
                        self.versions.insert(path.clone(), version.clone());
                    }
                    self.validation_error = None;
                    if !prefs.opencode_install.busy()
                        && prefs.opencode_binary_available()
                        && !prefs.opencode_binary_pending()
                        && prefs.select_opencode_binary(
                            &path,
                            validation.version,
                            platform::storage::unix_millis(),
                        )
                    {
                        self.custom_path = TextEdit::default();
                    }
                }
                Ok(validation) => {
                    self.validated.insert(path);
                    self.validation_error = Some(validation_message(&validation));
                }
                Err(_) => {
                    self.validation_error = Some(t("settings.opencode.setup.actionFailed").into());
                }
            }
        }

        let bg_done = self
            .bg_flight
            .as_ref()
            .and_then(|(path, _, rx)| rx.try_recv().ok().map(|res| (path.clone(), res)));
        if let Some((path, result)) = bg_done {
            self.bg_flight = None;
            self.validated.insert(path.clone());
            changed = true;
            if let Ok(validation) = result
                && validation.valid
                && let Some(version) = validation.version
            {
                self.versions.insert(path, version);
            }
        }

        if let Some(backend) = backend
            && !prefs.opencode_install.busy()
            && self.bg_flight.is_none()
            && self.submit_flight.is_none()
            && prefs.opencode_binary_available()
        {
            let mut candidates = vec!["opencode2".to_owned()];
            for entry in prefs.opencode_binaries() {
                candidates.push(entry.path);
            }
            if let Some(next_path) = candidates
                .into_iter()
                .find(|path| !self.versions.contains_key(path) && !self.validated.contains(path))
            {
                let (out, rx) = bounded(1);
                let (cancel, cancelled) = bounded(1);
                let path = next_path.clone();
                let wake = wake.clone();
                self.bg_flight = Some((next_path, cancel, rx));
                changed = true;
                platform::spawn(async move {
                    if let Some(result) = platform::reads::cancellable(
                        &cancelled,
                        validate_opencode_binary(&backend, &path),
                    )
                    .await
                        && out.send(result).await.is_ok()
                    {
                        wake();
                    }
                });
            }
        }

        (changed, binary_changed)
    }

    pub(super) fn submit_custom(&mut self, prefs: &Preferences, wake: Option<rune::Waker>) {
        if prefs.opencode_install.busy()
            || !prefs.opencode_binary_available()
            || prefs.opencode_binary_pending()
        {
            return;
        }
        let path = self.custom_path.text.trim().to_owned();
        if path.is_empty() {
            return;
        }
        if self.submit_flight.is_some()
            || self
                .bg_flight
                .as_ref()
                .is_some_and(|(validating, _, _)| validating == &path)
        {
            self.validation_error =
                Some(t("opencodeBinarySelector.validation.alreadyValidating").into());
            return;
        }
        let (Some(backend), Some(wake)) = (
            prefs
                .backend
                .as_ref()
                .filter(|_| prefs.can_retry())
                .cloned(),
            wake,
        ) else {
            return;
        };
        self.validation_error = None;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let target = path.clone();
        self.submit_flight = Some((path, cancel, rx));
        platform::spawn(async move {
            if let Some(result) = platform::reads::cancellable(
                &cancelled,
                validate_opencode_binary(&backend, &target),
            )
            .await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }

    fn is_validating(&self, path: &str) -> bool {
        self.bg_flight
            .as_ref()
            .is_some_and(|(active, _, _)| active == path)
            || self
                .submit_flight
                .as_ref()
                .is_some_and(|(active, _, _)| active == path)
    }

    pub(super) fn view<S: 'static>(
        &self,
        prefs: &Preferences,
        shared: &Rc<RefCell<Preferences>>,
        status: Option<&OpenCodeStatus>,
        wake: Option<rune::Waker>,
        access: fn(&mut S) -> &mut super::Status,
    ) -> El {
        let disabled = prefs.opencode_install.busy()
            || !prefs.opencode_binary_available()
            || prefs.opencode_binary_pending();
        let validating = self.bg_flight.is_some() || self.submit_flight.is_some();
        let selected = prefs
            .opencode_binary()
            .unwrap_or_else(|| "opencode2".into());
        let default_version = status
            .filter(|s| s.has_installation_source)
            .and_then(|s| s.current.as_deref())
            .or_else(|| self.versions.get("opencode2").map(String::as_str));

        let header = chrome::card_header(
            t("opencodeBinarySelector.title"),
            validating.then(|| t("opencodeBinarySelector.status.checkingVersions")),
        );

        let placeholder = rune_theme_codenomad::catalogue::format(
            crate::strings::locale(),
            "opencodeBinarySelector.customPath.placeholder",
            &[("name", "opencode2")],
        );
        let add_shared = shared.clone();
        let add_wake = wake.clone();
        let enter_shared = shared.clone();
        let enter_wake = wake;
        let can_add =
            !disabled && self.submit_flight.is_none() && !self.custom_path.text.trim().is_empty();
        let mut custom_body =
            col()
                .full_width()
                .separate(Space::Sm)
                .child(chrome::input_action_row(
                    layout::hinted_field(&self.custom_path, &placeholder)
                        .label(&placeholder)
                        .disabled(disabled || self.submit_flight.is_some())
                        .on_edit(move |s| &mut access(s).executable.custom_path)
                        .build(&field_kit(layout::dark()))
                        .key("opencode-binary-path")
                        .on_key(move |s, event, tx| {
                            if event.key == rune::Key::Enter
                                && event.mods == rune::Mods::default()
                                && !tx.key_repeat()
                            {
                                let prefs = enter_shared.borrow();
                                access(s)
                                    .executable
                                    .submit_custom(&prefs, enter_wake.clone());
                                true
                            } else {
                                false
                            }
                        }),
                    chrome::primary_action(
                        t("opencodeBinarySelector.actions.add"),
                        !can_add,
                        move |s| {
                            let prefs = add_shared.borrow();
                            access(s).executable.submit_custom(&prefs, add_wake.clone());
                        },
                    )
                    .key("opencode-binary-add"),
                ));
        if let Some(error) = &self.validation_error {
            custom_body = custom_body.child(
                text(error)
                    .wrap()
                    .role("alert")
                    .key("opencode-binary-validation-error"),
            );
        }

        let mut list = col().full_width().separate(Space::Xs);
        let default_label = rune_theme_codenomad::catalogue::format(
            crate::strings::locale(),
            "opencodeBinarySelector.display.systemPath",
            &[("name", "opencode2")],
        );
        list = list.child(self.binary_row::<S>(
            shared,
            &default_label,
            "opencode2",
            true,
            selected == "opencode2",
            default_version,
            disabled,
        ));
        for entry in prefs.opencode_binaries() {
            let version = self
                .versions
                .get(&entry.path)
                .map(String::as_str)
                .or(entry.version.as_deref());
            let name = display_name(&entry.path);
            list = list.child(self.binary_row::<S>(
                shared,
                name,
                &entry.path,
                false,
                selected == entry.path,
                version,
                disabled,
            ));
        }

        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(header)
            .child(
                chrome::disclosure(
                    t("opencodeBinarySelector.actions.chooseOther"),
                    self.custom_open,
                    custom_body,
                    move |s| {
                        let state = &mut access(s).executable;
                        state.custom_open = !state.custom_open;
                    },
                )
                .key("opencode-binary-other"),
            )
            .child(list);

        if let Some(error) = prefs.opencode_binary_failed() {
            let retry_shared = shared.clone();
            card = card.child(
                layout::action_row()
                    .child(text(t(error)).role("alert").wrap())
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry() || prefs.opencode_binary_pending(),
                        move |_: &mut S| retry_shared.borrow_mut().retry_opencode_binary(),
                    )),
            );
        }
        chrome::card(card)
    }

    #[allow(clippy::too_many_arguments)]
    fn binary_row<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        label: &str,
        path: &str,
        is_default: bool,
        selected: bool,
        version: Option<&str>,
        disabled: bool,
    ) -> El {
        let mut caption = String::new();
        if let Some(version) = version {
            caption.push_str(&rune_theme_codenomad::catalogue::format(
                crate::strings::locale(),
                "opencodeBinarySelector.versionLabel",
                &[("version", version)],
            ));
        }
        if self.is_validating(path) {
            if !caption.is_empty() {
                caption.push_str(" · ");
            }
            caption.push_str(t("opencodeBinarySelector.status.checking"));
        }
        let select_shared = shared.clone();
        let select_path = path.to_owned();
        let select_version = version.map(str::to_owned);
        let button_label = if selected {
            format!("✓ {label}")
        } else {
            label.to_owned()
        };
        let select_button = layout::button(&button_label, disabled, move |_: &mut S| {
            if !selected {
                select_shared.borrow_mut().select_opencode_binary(
                    &select_path,
                    select_version.clone(),
                    platform::storage::unix_millis(),
                );
            }
        })
        .checked(selected)
        .key(if is_default {
            "opencode-binary-default".to_owned()
        } else {
            format!("opencode-binary-item-{path}")
        });
        let remove = (!is_default).then(|| {
            let remove_shared = shared.clone();
            let remove_path = path.to_owned();
            layout::button(
                t("opencodeBinarySelector.actions.removeTitle"),
                disabled,
                move |_: &mut S| {
                    remove_shared
                        .borrow_mut()
                        .remove_opencode_binary(&remove_path);
                },
            )
            .key(format!("opencode-binary-remove-{path}"))
        });
        chrome::binary_row(
            select_button,
            (!is_default).then_some(path),
            (!caption.is_empty()).then_some(caption.as_str()),
            remove,
        )
    }
}

fn display_name(path: &str) -> &str {
    path.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
}

fn validation_message(validation: &BinaryValidation) -> String {
    if validation.v2_required {
        t("opencodeBinarySelector.validation.v2Required").into()
    } else if let Some(error) = &validation.error {
        error.clone()
    } else {
        t("opencodeBinarySelector.validation.invalidBinary").into()
    }
}
