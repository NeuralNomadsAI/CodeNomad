use super::{Section, Window, chrome, layout, t, view};
use rune::{AppSpec, Cx, El, col, text};
use rune_theme_codenomad::layout::Layout;

pub(in crate::settings) fn spec() -> AppSpec<Window> {
    AppSpec {
        setup: Some(|s, wake| {
            let mut prefs = s.shared.borrow_mut();
            prefs.window_wake = Some(wake);
            if std::mem::take(&mut prefs.open_providers) {
                s.section = Section::Providers;
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
                if jump && !s.config_files.busy() && !s.confirm_close && !s.closing {
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
                    s.memory_help_failed = false;
                    s.remote.close();
                    s.info.close();
                    s.missions.close();
                }
                let environment = s
                    .environment
                    .poll(&mut prefs, s.section == Section::Advanced && !s.closing);
                let changed = prefs.poll();
                let recording_ended = s.section == Section::Shortcuts
                    && s.shortcut_capture
                        .poll(&mut s.recording_shortcut, &prefs, tx);
                if changed && let Some(wake) = &prefs.main_wake {
                    wake();
                }
                let updated =
                    prefs.revision != std::mem::replace(&mut s.seen_revision, prefs.revision);
                if !prefs.transcript_ready() {
                    s.transcript_picker.set(None);
                }
                let editor_changed = prefs.memory.poll_editor(&mut s.memory_editor);
                let mut config_changed = false;
                if let Some(wake) = prefs.window_wake.clone() {
                    config_changed = s.host_support.poll(&prefs, &wake, !s.closing);
                    let capable = s.host_support.config_files(&prefs);
                    if s.section == Section::ConfigFiles && !capable && !s.config_files.dirty() {
                        s.section = Section::General;
                        prefs.memory.show(true);
                        config_changed = true;
                    }
                    config_changed |= s.config_files.poll(
                        &prefs,
                        &wake,
                        capable
                            && s.section == Section::ConfigFiles
                            && !s.confirm_close
                            && !s.closing,
                    );
                }
                if updated {
                    tx.set_title(crate::strings::with_locale(
                        prefs.locale().unwrap_or_else(crate::strings::locale),
                        || t("settings.title"),
                    ));
                }
                let status_changed = s.section == Section::OpenCode
                    && !s.confirm_close
                    && !s.closing
                    && prefs.window_wake.clone().is_some_and(|wake| {
                        prefs.show_opencode() | s.opencode.step(&mut prefs, &wake)
                    });
                let remote_changed = s.section == Section::Remote
                    && !s.confirm_close
                    && !s.closing
                    && prefs
                        .window_wake
                        .as_ref()
                        .is_some_and(|wake| s.remote.poll(&prefs, wake));
                let info_changed = s.section == Section::Info
                    && !s.confirm_close
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
                        s.section == Section::Stats && !s.confirm_close && !s.closing,
                        &wake,
                        now,
                        tx,
                    ) | leave
                });
                let missions_changed = prefs.window_wake.clone().is_some_and(|wake| {
                    s.missions.poll(
                        &mut prefs,
                        &wake,
                        s.section == Section::Missions && !s.confirm_close && !s.closing,
                    )
                });
                drop(prefs);
                let providers_changed = if s.section == Section::Providers {
                    let prefs = s.shared.borrow();
                    let target = prefs.provider_target.as_ref().filter(|_| prefs.can_retry());
                    s.providers.poll(target, prefs.window_wake.as_ref())
                } else {
                    false
                };
                jump | updated
                    | status_changed
                    | remote_changed
                    | info_changed
                    | stats_changed
                    | missions_changed
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
            if s.confirm_close {
                s.confirm_close = false;
            } else if s.memory_editor.shown() {
                s.memory_editor.dismiss();
            } else if s.section == Section::Missions && s.missions.cancel_confirm() {
                return true;
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
