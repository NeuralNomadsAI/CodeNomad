use super::{Section, Window, chrome, layout, t, view};
use rune::{AppSpec, Cx, El, col, text};
use rune_theme_codenomad::layout::Layout;

pub(in crate::settings) fn spec() -> AppSpec<Window> {
    AppSpec {
        setup: Some(|s, wake| {
            let mut prefs = s.shared.borrow_mut();
            prefs.window_wake = Some(wake);
            if std::mem::take(&mut prefs.open_providers) {
                if s.section != Section::Providers && s.general.busy(&prefs) {
                    s.after_palette_save = Some((
                        prefs.binding_epoch(),
                        super::AfterPaletteSave::Section(Section::Providers),
                    ));
                } else if s.general.dirty() && s.section != Section::Providers {
                    s.pending_section = Some(Section::Providers);
                } else {
                    s.section = Section::Providers;
                }
            }
            prefs.memory.show(s.section == Section::General);
            if prefs.backend.is_some() {
                prefs.refresh();
            }
        }),
        poll: Some(|s, now, tx| {
            let locale = s
                .shared
                .borrow()
                .locale()
                .unwrap_or_else(crate::strings::locale);
            crate::strings::with_locale(locale, || {
                let close_requested = s
                    .close_request
                    .as_ref()
                    .is_some_and(|request| request.requested.replace(false));
                if close_requested {
                    s.request_close(tx);
                    return true;
                }
                let mut prefs = s.shared.borrow_mut();
                let jump = std::mem::take(&mut prefs.open_providers);
                if jump && !s.config_files.busy() && s.confirm_close.is_none() && !s.closing {
                    if s.section != Section::Providers && s.general.busy(&prefs) {
                        s.after_palette_save = Some((
                            prefs.binding_epoch(),
                            super::AfterPaletteSave::Section(Section::Providers),
                        ));
                    } else if s.general.dirty() && s.section != Section::Providers {
                        s.pending_section = Some(Section::Providers);
                    } else {
                        s.section = Section::Providers;
                        s.general.close();
                        s.transcript_picker.set(None);
                        s.advanced_help = None;
                        s.recording_shortcut = false;
                        s.shortcut_capture = Default::default();
                        s.behavior.close();
                        s.opencode = super::opencode::Status::default();
                        s.logging.close();
                        prefs.hide_opencode();
                        prefs.memory.show(false);
                        s.memory_help.clear();
                        s.remote.close();
                        s.info.close();
                        s.missions.close();
                        s.integrations.suspend();
                    }
                }
                let environment = s
                    .environment
                    .poll(&mut prefs, s.section == Section::Advanced && !s.closing);
                let changed = prefs.poll();
                let palette_settled = s.general.settle_save(&mut prefs);
                s.sync_close_guard(&prefs);
                let recording_ended = s.section == Section::Shortcuts
                    && s.shortcut_capture
                        .poll(&mut s.recording_shortcut, &prefs, tx);
                if changed && let Some(wake) = &prefs.main_wake {
                    wake();
                }
                let updated =
                    prefs.revision != std::mem::replace(&mut s.seen_revision, prefs.revision);
                if !s.general.dirty()
                    || s.pending_section
                        .is_some_and(|next| !s.can_open_section(&prefs, next))
                {
                    s.pending_section = None;
                }
                if let Some((epoch, _)) = s.after_palette_save
                    && epoch != prefs.binding_epoch()
                {
                    s.after_palette_save = None;
                }
                if !s.general.busy(&prefs)
                    && let Some((epoch, after)) = s.after_palette_save.take()
                    && epoch == prefs.binding_epoch()
                    && !s.general.dirty()
                    && !prefs.palette_save_failed()
                {
                    match after {
                        super::AfterPaletteSave::Close => {
                            drop(prefs);
                            s.request_close(tx);
                            return true;
                        }
                        super::AfterPaletteSave::Section(next) => {
                            let allowed = s.can_open_section(&prefs, next);
                            drop(prefs);
                            if allowed {
                                s.switch_section(next);
                                return true;
                            }
                            prefs = s.shared.borrow_mut();
                        }
                    }
                }
                if matches!(
                    s.confirm_close,
                    Some(super::CloseConfirm::Palette) if !s.general.dirty()
                ) || matches!(
                    s.confirm_close,
                    Some(super::CloseConfirm::ConfigFiles) if !s.config_files.dirty()
                ) || matches!(
                    s.confirm_close,
                    Some(super::CloseConfirm::Memory) if !s.memory_editor.has_unsaved()
                ) {
                    s.confirm_close = None;
                }
                if !prefs.transcript_ready() {
                    s.transcript_picker.set(None);
                }
                let editor_changed = prefs
                    .memory
                    .poll_editor(prefs.backend.as_ref(), &mut s.memory_editor);
                let mut config_changed = false;
                if let Some(wake) = prefs.window_wake.clone() {
                    config_changed = s.host_support.poll(&prefs, &wake, !s.closing);
                    let capable = s.host_support.config_files(&prefs);
                    config_changed |= s.config_files.poll(
                        &prefs,
                        &wake,
                        capable
                            && s.section == Section::ConfigFiles
                            && s.confirm_close.is_none()
                            && !s.closing,
                    );
                    if s.section == Section::ConfigFiles
                        && (s.host_support.config_files_unsupported(&prefs)
                            || prefs.backend.is_none())
                        && !s.config_files.dirty()
                    {
                        s.section = Section::General;
                        prefs.memory.show(true);
                        config_changed = true;
                    }
                }
                if updated {
                    tx.set_title(crate::strings::with_locale(
                        prefs.locale().unwrap_or_else(crate::strings::locale),
                        || t("settings.title"),
                    ));
                }
                let status_changed = s.section == Section::OpenCode
                    && s.confirm_close.is_none()
                    && !s.closing
                    && prefs.window_wake.clone().is_some_and(|wake| {
                        prefs.show_opencode() | s.opencode.step(&mut prefs, &wake)
                    });
                let remote_changed = s.section == Section::Remote
                    && s.confirm_close.is_none()
                    && !s.closing
                    && prefs
                        .window_wake
                        .as_ref()
                        .is_some_and(|wake| s.remote.poll(&prefs, wake));
                let info_changed = s.section == Section::Info
                    && s.confirm_close.is_none()
                    && !s.closing
                    && prefs
                        .window_wake
                        .as_ref()
                        .is_some_and(|wake| s.info.poll(&prefs, wake));
                let stats_changed = prefs.window_wake.clone().is_some_and(|wake| {
                    let leave =
                        s.section == Section::Stats && !super::super::stats::supported(&prefs);
                    if leave {
                        s.section = Section::General;
                        prefs.memory.show(true);
                    }
                    s.stats.poll(
                        prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
                        s.section == Section::Stats && s.confirm_close.is_none() && !s.closing,
                        &wake,
                        now,
                        tx,
                    ) | leave
                });
                let missions_changed = prefs.window_wake.clone().is_some_and(|wake| {
                    s.missions.poll(
                        &mut prefs,
                        &wake,
                        s.section == Section::Missions && s.confirm_close.is_none() && !s.closing,
                    )
                });
                let integrations_changed = prefs.window_wake.clone().is_some_and(|wake| {
                    s.integrations.poll(
                        prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
                        s.section == Section::Integrations
                            && s.confirm_close.is_none()
                            && !s.closing,
                        &wake,
                        now,
                        tx,
                    )
                });
                drop(prefs);
                let providers_changed =
                    if s.section == Section::Providers && s.confirm_close.is_none() && !s.closing {
                        let prefs = s.shared.borrow();
                        let target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
                        s.providers.poll(
                            target,
                            now,
                            prefs.window_wake.as_ref(),
                            tx,
                            true,
                            |s: &mut Window| &mut s.providers,
                        )
                    } else {
                        s.providers.cancel_on_hide()
                    };
                jump | updated
                    | palette_settled
                    | status_changed
                    | remote_changed
                    | info_changed
                    | stats_changed
                    | missions_changed
                    | integrations_changed
                    | providers_changed
                    | editor_changed
                    | environment
                    | config_changed
                    | recording_ended
            })
        }),
        on_key: Some(|s, event, tx| {
            if event.key != rune::Key::Escape {
                return false;
            }
            if s.confirm_close.take().is_some() {
                s.cancel_close_main();
            } else if s.pending_section.take().is_some() || s.general.dismiss_overlay() {
            } else if s.section == Section::Providers && s.providers.dismiss_modal(tx) {
            } else if s.memory_editor.shown() {
                s.memory_editor.dismiss();
            } else if s.section == Section::Missions && s.missions.cancel_confirm() {
            } else if s.section == Section::Integrations && s.integrations.dismiss_overlay() {
            } else {
                let cancelled = s.shared.borrow_mut().memory.cancel_cleanup_confirmation();
                if !cancelled {
                    s.request_close(tx);
                }
            }
            true
        }),
        #[cfg(any(test, feature = "test-support"))]
        scenes: &[
            ("settings", |s| s.shared.borrow_mut().fixture()),
            ("conversation", |s| {
                s.shared
                    .borrow_mut()
                    .fixture_locale(crate::strings::locale());
                s.section = Section::Conversation;
            }),
            ("opencode", |s| {
                s.shared
                    .borrow_mut()
                    .fixture_locale(crate::strings::locale());
                s.section = Section::OpenCode;
                s.opencode.fixture();
            }),
        ],
        ..chrome::spec(t("settings.title"), Window::default, view)
    }
}

pub(in crate::settings) fn focus(s: &mut Window, focused: bool, _: &mut rune::Tx) {
    s.focused.set(focused);
}

pub(in crate::settings) fn closed(s: &mut Window, _: &mut rune::Tx) {
    s.focused.set(false);
    #[cfg(target_os = "windows")]
    crate::platform::preferences_placement::closed();
    s.shared.borrow_mut().hide_opencode();
    if !s.retain_editor_on_native_close() {
        s.close(crate::settings::warn_save_failed);
    }
}

pub(in crate::settings) fn save_warning(locale: &&'static str, cx: &mut Cx<&'static str>) -> El {
    use rune_theme_codenomad::Space;
    crate::strings::with_locale(locale, || {
        layout::render(cx, |_| {
            col()
                .full_width()
                .full_height()
                .reading_surface()
                .pad(Space::Lg)
                .separate(Space::Md)
                .child(text(t("settings.preferenceSaveFailed")).role("alert"))
                .child(layout::button_tx(
                    t("alertDialog.actions.ok"),
                    false,
                    |_: &mut &str, tx| {
                        tx.close_window();
                    },
                ))
        })
        .locale_direction(locale)
    })
}
