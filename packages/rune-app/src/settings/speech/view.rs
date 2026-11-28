//! View rendering for Preferences → Voice (Dictation card + Playback & API credentials card).
use super::{CapState, Direction, InfoTip, Picker, Speech, TextField};
use crate::{
    settings::preferences::{Owner, Preferences, behavior::GeneralToggle},
    strings::t,
};
use codenomad_client::settings::speech::{
    DEFAULT_PROVIDER, SpeechPlaybackMode, SpeechSettings, SpeechTtsFormat, js_trim,
    normalize_speech_settings, url_display_host,
};
use rune::{El, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

impl Speech {
    pub fn view<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        active: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        let prefs = shared.borrow();
        let saved = normalize_speech_settings(prefs.saved(Owner::Server));
        let saving = prefs.speech.saving();
        let server_loaded = prefs.saved(Owner::Server).is_some();
        let server_failed = prefs.speech_server_failed();
        let server_ready = prefs.speech_server_ready();
        let config_unavailable = !active || !prefs.locale_ready() || !prefs.can_retry();
        let fields_disabled = !active || saving || !server_ready;

        let dictation_card = self.view_dictation_card(shared, &prefs, config_unavailable, access);
        let playback_card = self.view_playback_card(
            shared,
            &prefs,
            &saved,
            active,
            saving,
            server_loaded,
            server_failed,
            server_ready,
            fields_disabled,
            layers,
            access,
        );

        col()
            .full_width()
            .separate(Space::Sm)
            .child(dictation_card)
            .child(playback_card)
    }

    fn dictation_status(&self, prompt_voice_enabled: bool) -> &'static str {
        if !prompt_voice_enabled {
            return t("settings.voice.dictation.off");
        }
        if self.cap_failed() {
            return t("settings.speech.status.error");
        }
        match self.cap_state() {
            CapState::Idle | CapState::Loading => t("settings.speech.status.loading"),
            CapState::Unsupported => t("settings.voice.unavailable"),
            CapState::Loaded => match self.loaded_capabilities() {
                Some(caps) if caps.available && caps.supports_stt && caps.stt_configured => {
                    t("settings.voice.ready")
                }
                Some(caps) if caps.available && caps.supports_stt => {
                    t("settings.voice.notConfigured")
                }
                _ => t("settings.voice.unavailable"),
            },
        }
    }

    fn playback_status(&self, server_loaded: bool, server_failed: bool) -> &'static str {
        if server_failed || self.cap_failed() {
            return t("settings.speech.status.error");
        }
        match self.cap_state() {
            CapState::Idle | CapState::Loading => t("settings.speech.status.loading"),
            CapState::Unsupported => t("settings.voice.unavailable"),
            CapState::Loaded => match self.loaded_capabilities() {
                _ if !server_loaded => t("settings.speech.status.loading"),
                Some(caps) if !caps.available || !caps.supports_tts => {
                    t("settings.voice.unavailable")
                }
                Some(caps) if !caps.tts_configured => t("settings.voice.notConfigured"),
                Some(_) => t("settings.speech.status.configured"),
                None => t("settings.speech.status.loading"),
            },
        }
    }

    fn provider_label(&self) -> String {
        let Some(caps) = self.loaded_capabilities().filter(|c| c.available) else {
            return t("settings.voice.unavailable").to_owned();
        };
        let url = if caps.separate_providers {
            caps.tts_base_url.as_deref()
        } else {
            caps.base_url.as_deref()
        };
        if let Some(host) = url.and_then(url_display_host) {
            return host;
        }
        if caps.provider == DEFAULT_PROVIDER || caps.provider.is_empty() {
            t("settings.voice.playback.openaiCompatible").to_owned()
        } else {
            caps.provider.clone()
        }
    }

    fn view_dictation_card<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        prefs: &Preferences,
        config_unavailable: bool,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        let toggle = GeneralToggle::PromptVoiceInput;
        let checked = prefs
            .general_toggle(toggle)
            .unwrap_or_else(|| toggle.default_value());
        let pending = prefs.general_toggle_pending(toggle);
        let toggle_failed = prefs.general_toggle_failed(toggle);
        let status = self.dictation_status(checked);
        let title = t(toggle.title_key());
        let info_text = t("settings.behavior.promptVoiceInput.subtitle");
        let info = chrome::info_tip(
            title,
            info_text,
            self.info_open == Some(InfoTip::PromptVoiceInput),
            move |s: &mut S| {
                let sp = access(s);
                sp.info_open = (sp.info_open != Some(InfoTip::PromptVoiceInput))
                    .then_some(InfoTip::PromptVoiceInput);
            },
        )
        .key("speech-info-promptVoiceInput");
        let owner = shared.clone();
        let control =
            chrome::setting_switch(title, checked, config_unavailable, move |_: &mut S| {
                let mut prefs = owner.borrow_mut();
                if let Some(current) = prefs.general_toggle(toggle) {
                    prefs.set_general_toggle(toggle, !current);
                }
            })
            .busy(pending)
            .key("behavior-showPromptVoiceInput");

        let mut actions = layout::action_row().child(
            chrome::text_link_button(
                t("settings.voice.credentials.title"),
                false,
                move |s: &mut S, tx| {
                    let sp = access(s);
                    sp.credentials_open = true;
                    let target = if sp.separate_supported() {
                        "speech-separate-providers"
                    } else {
                        "speech-shared-api-key"
                    };
                    tx.scroll_into_view("speech-credentials");
                    if tx.focus_visible() {
                        tx.focus(target, true);
                    }
                },
            )
            .key("speech-open-credentials"),
        );
        if toggle_failed {
            let retry_owner = shared.clone();
            actions = actions.child(
                chrome::secondary_action(
                    t("settings.voice.retry"),
                    !prefs.can_retry() || pending,
                    move |_: &mut S| {
                        retry_owner.borrow_mut().retry_general_toggle(toggle);
                    },
                )
                .key("speech-dictation-retry"),
            );
        }

        let mut card = col()
            .role("region")
            .label(t("settings.voice.dictation.title"))
            .full_width()
            .separate(Space::Sm)
            .child(card_header(t("settings.voice.dictation.title"), status))
            .child(chrome::setting_row_with_info(title, Some(info), control));
        if toggle_failed {
            card = card.child(
                text(t("settings.preferenceSaveFailed"))
                    .wrap()
                    .role("alert"),
            );
        }
        chrome::card(card.child(actions))
    }

    #[allow(clippy::too_many_arguments)]
    fn view_playback_card<S: 'static>(
        &self,
        shared: &Rc<RefCell<Preferences>>,
        prefs: &Preferences,
        saved: &SpeechSettings,
        active: bool,
        saving: bool,
        server_loaded: bool,
        server_failed: bool,
        server_ready: bool,
        fields_disabled: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        let mode = self.drafts.playback_mode.unwrap_or(saved.playback_mode);
        let format = self.drafts.tts_format.unwrap_or(saved.tts_format);
        let separate_supported = self.separate_supported();
        let separate = separate_supported
            && self
                .drafts
                .separate_providers
                .unwrap_or(saved.separate_providers);
        let dirty = self.pending_patch(saved).is_some();
        let has_local_draft = dirty
            || self
                .drafts
                .has_any_local_draft(saved, self.capabilities_voice());

        let mode_labels = SpeechPlaybackMode::ALL.map(|m| t(m.label_key()));
        let mode_index = SpeechPlaybackMode::ALL
            .iter()
            .position(|&m| m == mode)
            .unwrap_or(0);
        let mode_open = self.open_picker == Some(Picker::PlaybackMode) && !fields_disabled;
        let mode_picker = chrome::build_picker(
            chrome::picker(
                "speech-playback-mode",
                t("settings.speech.playbackMode.title"),
                &mode_labels,
            )
            .current(Some(mode_labels[mode_index]))
            .disabled(fields_disabled)
            .open(mode_open)
            .on_toggle(move |s: &mut S| {
                access(s).open_picker = (!mode_open).then_some(Picker::PlaybackMode);
            })
            .on_close(move |s: &mut S| access(s).open_picker = None)
            .on_choose(move |s: &mut S, label, _| {
                let sp = access(s);
                sp.open_picker = None;
                if let Some(pos) = mode_labels.iter().position(|&l| l == label) {
                    sp.drafts.playback_mode = Some(SpeechPlaybackMode::ALL[pos]);
                }
            }),
            layers,
        );
        let mode_info = chrome::info_tip(
            t("settings.speech.playbackMode.title"),
            t("settings.speech.playbackMode.subtitle"),
            self.info_open == Some(InfoTip::PlaybackMode),
            move |s: &mut S| {
                let sp = access(s);
                sp.info_open =
                    (sp.info_open != Some(InfoTip::PlaybackMode)).then_some(InfoTip::PlaybackMode);
            },
        )
        .key("speech-info-playbackMode");

        let voice_field = text_field(
            &self.drafts.tts_voice.edit,
            t("settings.speech.ttsVoice.title"),
            None,
            false,
            fields_disabled,
            "speech-tts-voice",
            move |s| &mut access(s).drafts.tts_voice.edit,
            move |s| access(s).drafts.on_text_change(TextField::TtsVoice),
        );

        let fmt_labels: Vec<&str> = SpeechTtsFormat::ALL.iter().map(|f| f.label()).collect();
        let fmt_index = SpeechTtsFormat::ALL
            .iter()
            .position(|&f| f == format)
            .unwrap_or(0);
        let fmt_open = self.open_picker == Some(Picker::TtsFormat) && !fields_disabled;
        let fmt_picker = chrome::build_picker(
            chrome::picker(
                "speech-tts-format",
                t("settings.speech.ttsFormat.title"),
                &fmt_labels,
            )
            .current(Some(fmt_labels[fmt_index]))
            .disabled(fields_disabled)
            .open(fmt_open)
            .on_toggle(move |s: &mut S| {
                access(s).open_picker = (!fmt_open).then_some(Picker::TtsFormat);
            })
            .on_close(move |s: &mut S| access(s).open_picker = None)
            .on_choose(move |s: &mut S, label, _| {
                let sp = access(s);
                sp.open_picker = None;
                if let Some(pos) = SpeechTtsFormat::ALL.iter().position(|f| f.label() == label) {
                    sp.drafts.tts_format = Some(SpeechTtsFormat::ALL[pos]);
                }
            }),
            layers,
        );

        let streaming_incompatible = self.loaded_capabilities().is_some_and(|c| {
            c.available
                && c.tts_configured
                && c.supports_tts
                && mode == SpeechPlaybackMode::Streaming
                && !c.supports_streaming_tts
        });

        let credentials_body = self.view_credentials_body(
            saved,
            separate_supported,
            separate,
            fields_disabled,
            access,
        );

        let save_shared = shared.clone();
        let cancel_shared = shared.clone();
        let retry_shared = shared.clone();
        let save_label = t(if saving {
            "settings.speech.save.saving"
        } else {
            "settings.speech.save.action"
        });
        let mut actions = chrome::trailing_action_row()
            .child(
                chrome::primary_action(
                    save_label,
                    !active || !dirty || saving || !server_ready,
                    move |s: &mut S| {
                        access(s).save(&mut save_shared.borrow_mut());
                    },
                )
                .busy(saving)
                .key("speech-save"),
            )
            .child(
                layout::button(
                    t("alertDialog.actions.cancel"),
                    !active || saving || (!has_local_draft && !prefs.speech.failed),
                    move |s: &mut S| {
                        access(s).cancel_drafts(&mut cancel_shared.borrow_mut());
                    },
                )
                .key("speech-cancel"),
            );
        if prefs.speech.failed || server_failed || self.cap_failed() {
            actions = actions.child(
                layout::button(
                    t("settings.voice.retry"),
                    !active || saving || !prefs.can_retry(),
                    move |s: &mut S| {
                        access(s).request_retry(&mut retry_shared.borrow_mut());
                    },
                )
                .key("speech-retry"),
            );
        }

        let mut card = col()
            .role("region")
            .label(t("settings.voice.playback.title"))
            .full_width()
            .separate(Space::Sm)
            .child(card_header(
                t("settings.voice.playback.title"),
                self.playback_status(server_loaded, server_failed),
            ))
            .child(chrome::divided_rows([
                chrome::setting_row(
                    t("settings.speech.provider.title"),
                    text(self.provider_label()).wrap(),
                ),
                chrome::setting_row_with_info(
                    t("settings.speech.playbackMode.title"),
                    Some(mode_info),
                    mode_picker,
                ),
                chrome::field_row(t("settings.speech.ttsVoice.title"), None, voice_field),
                chrome::setting_row(t("settings.speech.ttsFormat.title"), fmt_picker),
            ]));

        if streaming_incompatible {
            card = card.child(
                text(t("settings.speech.compatibility.streamingUnavailable"))
                    .wrap()
                    .role("status"),
            );
        }

        card = card.child(
            chrome::disclosure(
                t("settings.voice.credentials.title"),
                self.credentials_open,
                credentials_body,
                move |s: &mut S| {
                    let sp = access(s);
                    sp.credentials_open = !sp.credentials_open;
                },
            )
            .key("speech-credentials"),
        );

        if prefs.speech.failed {
            card = card.child(text(t("settings.speech.save.error")).wrap().role("alert"));
        } else if server_failed {
            card = card.child(text(t("rune.connect_error")).wrap().role("alert"));
        }

        card = card.child(actions);
        chrome::card(card)
    }

    fn view_credentials_body<S: 'static>(
        &self,
        saved: &SpeechSettings,
        separate_supported: bool,
        separate: bool,
        disabled: bool,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        let mut body = col().full_width().separate(Space::Xs);
        if separate_supported {
            let label = t("settings.speech.separateProviders.title");
            body = body.child(chrome::setting_row(
                label,
                chrome::setting_switch(label, separate, disabled, move |s: &mut S| {
                    access(s).drafts.separate_providers = Some(!separate);
                })
                .key("speech-separate-providers"),
            ));
        }

        body = self.append_direction_fields(
            body,
            DirectionSpec {
                key_prefix: "speech-shared",
                section_title: None,
                api_key_label: t("settings.speech.apiKey.title"),
                stored_note: t("settings.speech.apiKey.storedNote"),
                clear_action: t("settings.speech.apiKey.clearAction"),
                clear_pending: t("settings.speech.apiKey.clearPending"),
                base_url_label: t("settings.speech.baseUrl.title"),
                base_url_info: t("settings.speech.baseUrl.subtitle"),
                base_url_placeholder: t("settings.speech.baseUrl.placeholder"),
                model_label: t("settings.speech.sttModel.title"),
                key_tip: InfoTip::SharedApiKey,
                url_tip: InfoTip::SharedBaseUrl,
                has_api_key: saved.has_api_key,
                clear_key: self.drafts.shared_key.clear_key,
                api_key_edit: &self.drafts.shared_key.edit,
                base_url_edit: &self.drafts.shared_base_url.edit,
                model_edit: &self.drafts.stt_model.edit,
            },
            disabled,
            move |s| &mut access(s).drafts.shared_key.edit,
            move |s| access(s).drafts.on_key_change(Direction::Shared),
            move |s| access(s).drafts.shared_key.clear_key = true,
            move |s| &mut access(s).drafts.shared_base_url.edit,
            move |s| access(s).drafts.on_text_change(TextField::SharedBaseUrl),
            move |s| &mut access(s).drafts.stt_model.edit,
            move |s| access(s).drafts.on_text_change(TextField::SttModel),
            access,
        );

        let shared_tts_model = text_field(
            &self.drafts.tts_model.edit,
            t("settings.speech.ttsModel.title"),
            None,
            false,
            disabled,
            "speech-shared-tts-model",
            move |s| &mut access(s).drafts.tts_model.edit,
            move |s| access(s).drafts.on_text_change(TextField::TtsModel),
        );
        body = body.child(chrome::field_row(
            t("settings.speech.ttsModel.title"),
            None,
            shared_tts_model,
        ));

        if separate {
            body = self.append_direction_fields(
                body,
                DirectionSpec {
                    key_prefix: "speech-stt",
                    section_title: Some(t("settings.speech.stt.section.title")),
                    api_key_label: t("settings.speech.stt.apiKey.title"),
                    stored_note: t("settings.speech.stt.apiKey.storedNote"),
                    clear_action: t("settings.speech.stt.apiKey.clearAction"),
                    clear_pending: t("settings.speech.stt.apiKey.clearPending"),
                    base_url_label: t("settings.speech.stt.baseUrl.title"),
                    base_url_info: t("settings.speech.stt.baseUrl.subtitle"),
                    base_url_placeholder: t("settings.speech.stt.baseUrl.placeholder"),
                    model_label: t("settings.speech.stt.model.title"),
                    key_tip: InfoTip::SttApiKey,
                    url_tip: InfoTip::SttBaseUrl,
                    has_api_key: saved.stt.has_api_key,
                    clear_key: self.drafts.stt_key.clear_key,
                    api_key_edit: &self.drafts.stt_key.edit,
                    base_url_edit: &self.drafts.stt_base_url.edit,
                    model_edit: &self.drafts.stt_model_dir.edit,
                },
                disabled,
                move |s| &mut access(s).drafts.stt_key.edit,
                move |s| access(s).drafts.on_key_change(Direction::Stt),
                move |s| access(s).drafts.stt_key.clear_key = true,
                move |s| &mut access(s).drafts.stt_base_url.edit,
                move |s| access(s).drafts.on_text_change(TextField::SttBaseUrl),
                move |s| &mut access(s).drafts.stt_model_dir.edit,
                move |s| access(s).drafts.on_text_change(TextField::SttModelDir),
                access,
            );

            body = self.append_direction_fields(
                body,
                DirectionSpec {
                    key_prefix: "speech-tts",
                    section_title: Some(t("settings.speech.tts.section.title")),
                    api_key_label: t("settings.speech.tts.apiKey.title"),
                    stored_note: t("settings.speech.tts.apiKey.storedNote"),
                    clear_action: t("settings.speech.tts.apiKey.clearAction"),
                    clear_pending: t("settings.speech.tts.apiKey.clearPending"),
                    base_url_label: t("settings.speech.tts.baseUrl.title"),
                    base_url_info: t("settings.speech.tts.baseUrl.subtitle"),
                    base_url_placeholder: t("settings.speech.tts.baseUrl.placeholder"),
                    model_label: t("settings.speech.tts.model.title"),
                    key_tip: InfoTip::TtsApiKey,
                    url_tip: InfoTip::TtsBaseUrl,
                    has_api_key: saved.tts.has_api_key,
                    clear_key: self.drafts.tts_key.clear_key,
                    api_key_edit: &self.drafts.tts_key.edit,
                    base_url_edit: &self.drafts.tts_base_url.edit,
                    model_edit: &self.drafts.tts_model_dir.edit,
                },
                disabled,
                move |s| &mut access(s).drafts.tts_key.edit,
                move |s| access(s).drafts.on_key_change(Direction::Tts),
                move |s| access(s).drafts.tts_key.clear_key = true,
                move |s| &mut access(s).drafts.tts_base_url.edit,
                move |s| access(s).drafts.on_text_change(TextField::TtsBaseUrl),
                move |s| &mut access(s).drafts.tts_model_dir.edit,
                move |s| access(s).drafts.on_text_change(TextField::TtsModelDir),
                access,
            );
        }

        body
    }

    #[allow(clippy::too_many_arguments)]
    fn append_direction_fields<S: 'static>(
        &self,
        mut body: El,
        spec: DirectionSpec<'_>,
        disabled: bool,
        edit_key: impl Fn(&mut S) -> &mut TextEdit + 'static,
        change_key: impl Fn(&mut S) + 'static,
        clear_key_action: impl Fn(&mut S) + 'static,
        edit_url: impl Fn(&mut S) -> &mut TextEdit + 'static,
        change_url: impl Fn(&mut S) + 'static,
        edit_model: impl Fn(&mut S) -> &mut TextEdit + 'static,
        change_model: impl Fn(&mut S) + 'static,
        access: fn(&mut S) -> &mut Self,
    ) -> El {
        if let Some(title) = spec.section_title {
            body = body.child(text(title).text_role(TextRole::Title).role("heading"));
        }
        let key_typed = !js_trim(&spec.api_key_edit.text).is_empty();
        let show_saved = spec.has_api_key && !spec.clear_key;
        let key_info = show_saved.then(|| {
            let tip = spec.key_tip;
            chrome::info_tip(
                spec.api_key_label,
                spec.stored_note,
                self.info_open == Some(tip),
                move |s: &mut S| {
                    let sp = access(s);
                    sp.info_open = (sp.info_open != Some(tip)).then_some(tip);
                },
            )
            .key(format!("{}-key-info", spec.key_prefix))
        });
        let key_placeholder = show_saved.then(|| t("settings.voice.conversation.keySaved"));
        let key_field = text_field(
            spec.api_key_edit,
            spec.api_key_label,
            key_placeholder,
            true,
            disabled,
            &format!("{}-api-key", spec.key_prefix),
            edit_key,
            change_key,
        );
        body = body.child(chrome::field_row(spec.api_key_label, key_info, key_field));

        if spec.has_api_key && !key_typed {
            if spec.clear_key {
                body = body.child(text(spec.clear_pending).wrap().role("status"));
            } else {
                body = body.child(
                    layout::action_row().child(
                        layout::button(spec.clear_action, disabled, clear_key_action)
                            .key(format!("{}-clear-key", spec.key_prefix)),
                    ),
                );
            }
        }

        let url_tip = spec.url_tip;
        let url_info = chrome::info_tip(
            spec.base_url_label,
            spec.base_url_info,
            self.info_open == Some(url_tip),
            move |s: &mut S| {
                let sp = access(s);
                sp.info_open = (sp.info_open != Some(url_tip)).then_some(url_tip);
            },
        )
        .key(format!("{}-url-info", spec.key_prefix));
        let url_field = text_field(
            spec.base_url_edit,
            spec.base_url_label,
            Some(spec.base_url_placeholder),
            false,
            disabled,
            &format!("{}-base-url", spec.key_prefix),
            edit_url,
            change_url,
        );
        body = body.child(chrome::field_row(
            spec.base_url_label,
            Some(url_info),
            url_field,
        ));

        let model_field = text_field(
            spec.model_edit,
            spec.model_label,
            None,
            false,
            disabled,
            &format!("{}-model", spec.key_prefix),
            edit_model,
            change_model,
        );
        body.child(chrome::field_row(spec.model_label, None, model_field))
    }
}

struct DirectionSpec<'a> {
    key_prefix: &'static str,
    section_title: Option<&'static str>,
    api_key_label: &'static str,
    stored_note: &'static str,
    clear_action: &'static str,
    clear_pending: &'static str,
    base_url_label: &'static str,
    base_url_info: &'static str,
    base_url_placeholder: &'static str,
    model_label: &'static str,
    key_tip: InfoTip,
    url_tip: InfoTip,
    has_api_key: bool,
    clear_key: bool,
    api_key_edit: &'a TextEdit,
    base_url_edit: &'a TextEdit,
    model_edit: &'a TextEdit,
}

fn card_header(title: &'static str, status: &'static str) -> El {
    chrome::setting_row_with_info(title, None, text(status).role("status"))
}

#[allow(clippy::too_many_arguments)]
fn text_field<S: 'static>(
    edit: &TextEdit,
    label: &str,
    placeholder: Option<&str>,
    secret: bool,
    disabled: bool,
    key: &str,
    on_edit: impl Fn(&mut S) -> &mut TextEdit + 'static,
    on_change: impl Fn(&mut S) + 'static,
) -> El {
    let input = match placeholder {
        Some(hint) => layout::hinted_field(edit, hint),
        None => layout::field(edit),
    }
    .label(label)
    .disabled(disabled)
    .on_edit(on_edit)
    .on_change(move |s, _| on_change(s));
    let input = if secret {
        input.secure().revealed(false)
    } else {
        input
    };
    input.build(&field_kit(layout::dark())).key(key)
}
