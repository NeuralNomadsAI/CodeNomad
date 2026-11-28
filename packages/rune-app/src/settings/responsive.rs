use crate::strings::t;
use rune_theme_codenomad::settings as chrome;

pub(super) const NARROW_BACK_KEY: &str = "settings-narrow-back";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Section {
    General,
    Conversation,
    OpenCode,
    Notifications,
    Voice,
    Providers,
    Missions,
    Integrations,
    Shortcuts,
    Stats,
    Remote,
    ConfigFiles,
    Advanced,
    Info,
}

impl Default for Section {
    fn default() -> Self {
        Self::General
    }
}

impl Section {
    pub(super) fn nav_key(self) -> &'static str {
        match self {
            Self::General => "settings-general",
            Self::Conversation => "settings-conversation",
            Self::OpenCode => "settings-opencode",
            Self::Notifications => "settings-notifications",
            Self::Voice => "settings-voice",
            Self::Providers => "settings-providers",
            Self::Missions => "settings-missions",
            Self::Integrations => "settings-integrations",
            Self::Shortcuts => "settings-hotkeys",
            Self::Stats => "settings-stats",
            Self::Remote => "settings-remote",
            Self::ConfigFiles => "settings-config-files",
            Self::Advanced => "settings-advanced",
            Self::Info => "settings-info",
        }
    }

    pub(super) fn pane_key(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Conversation => "conversation",
            Self::OpenCode => "opencode",
            Self::Notifications => "notifications",
            Self::Voice => "voice",
            Self::Providers => "providers",
            Self::Missions => "missions",
            Self::Integrations => "integrations",
            Self::Shortcuts => "hotkeys",
            Self::Stats => "stats",
            Self::Remote => "remote",
            Self::ConfigFiles => "config-files",
            Self::Advanced => "advanced",
            Self::Info => "info",
        }
    }

    pub(super) fn from_nav_key(key: &str) -> Option<Self> {
        Some(match key {
            "settings-general" => Self::General,
            "settings-conversation" => Self::Conversation,
            "settings-opencode" => Self::OpenCode,
            "settings-notifications" => Self::Notifications,
            "settings-voice" => Self::Voice,
            "settings-providers" => Self::Providers,
            "settings-missions" => Self::Missions,
            "settings-integrations" => Self::Integrations,
            "settings-hotkeys" => Self::Shortcuts,
            "settings-stats" => Self::Stats,
            "settings-remote" => Self::Remote,
            "settings-config-files" => Self::ConfigFiles,
            "settings-advanced" => Self::Advanced,
            "settings-info" => Self::Info,
            _ => return None,
        })
    }

    pub(super) fn label(self) -> &'static str {
        t(match self {
            Self::General => "settings.nav.general",
            Self::Conversation => "settings.nav.chat",
            Self::OpenCode => "settings.nav.opencode",
            Self::Notifications => "settings.nav.notifications",
            Self::Voice => "settings.nav.voice",
            Self::Shortcuts => "settings.nav.hotkeys",
            Self::Providers => "settings.nav.providers",
            Self::Missions => "settings.nav.missions",
            Self::Integrations => "settings.nav.integrations",
            Self::Stats => "settings.usage.title",
            Self::Remote => "settings.nav.remote",
            Self::ConfigFiles => "settings.nav.configFiles",
            Self::Advanced => "settings.nav.advanced",
            Self::Info => "settings.nav.info",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NarrowView {
    List,
    Detail,
}

impl Default for NarrowView {
    fn default() -> Self {
        Self::List
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub(super) struct NarrowState {
    width: f32,
    view: NarrowView,
}

impl NarrowState {
    pub(super) fn width(self) -> f32 {
        self.width
    }

    pub(super) fn view(self) -> NarrowView {
        self.view
    }

    pub(super) fn is_narrow(self) -> bool {
        chrome::is_narrow(self.width)
    }

    #[cfg(any(target_arch = "wasm32", test))]
    pub(super) fn effective_width(self, fallback_width: f32) -> f32 {
        if self.width > 0.0 {
            self.width
        } else {
            fallback_width
        }
    }

    #[cfg(any(target_arch = "wasm32", test))]
    pub(super) fn is_narrow_with_fallback(self, fallback_width: f32) -> bool {
        chrome::is_narrow(self.effective_width(fallback_width))
    }

    #[cfg(any(target_arch = "wasm32", test))]
    pub(super) fn seed_width(&mut self, width: f32) {
        if width > 0.0 {
            self.width = width;
        }
    }

    pub(super) fn open_detail(&mut self) {
        self.view = NarrowView::Detail;
    }

    pub(super) fn open_detail_focus(&mut self, tx: &mut rune::Tx) {
        self.view = NarrowView::Detail;
        if self.is_narrow() {
            tx.focus(NARROW_BACK_KEY, true);
        }
    }

    pub(super) fn return_to_list(&mut self, section: Section, tx: &mut rune::Tx) {
        self.view = NarrowView::List;
        tx.focus(section.nav_key(), true);
    }

    #[cfg(any(target_arch = "wasm32", test))]
    pub(super) fn reset_to_list(&mut self) {
        self.view = NarrowView::List;
    }

    /// Tracks viewport width only so vertical soft-keyboard (IME) resizes never reset `view`
    /// or disturb focus. Resizing from wide (`>= 600 pt`) to narrow keeps the open section visible
    /// in `Detail`.
    pub(super) fn measure(&mut self, width: f32, tx: &mut rune::Tx) {
        if (self.width - width).abs() < 0.5 {
            tx.live_only();
            return;
        }
        let was_wide = self.width >= chrome::NARROW_BREAKPOINT;
        let was_narrow = self.is_narrow();
        self.width = width;
        let now_narrow = self.is_narrow();
        if was_wide && now_narrow {
            self.view = NarrowView::Detail;
        }
        if was_narrow != now_narrow {
            tx.instant();
        }
    }
}

/// Resolves a programmatic section jump (`open_providers` / `open_remote`): falls back cleanly to
/// `Section::General` when the target section cannot be opened.
pub(super) fn resolve_requested_section(requested: Section, allowed: bool) -> Section {
    if allowed { requested } else { Section::General }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::strings;
    use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime, Tx, col, text};
    use rune_theme_codenomad::{
        layout::{self, Layout},
        settings as chrome,
    };

    #[derive(Default)]
    struct EmbeddedHarness {
        shown: bool,
        section: Section,
        narrow: NarrowState,
        locale: &'static str,
        touch: bool,
        dirty: bool,
        confirm_close: bool,
        pending_section: Option<Section>,
    }

    impl EmbeddedHarness {
        fn new(locale: &'static str, touch: bool) -> Self {
            Self {
                shown: true,
                section: Section::General,
                narrow: NarrowState::default(),
                locale,
                touch,
                dirty: false,
                confirm_close: false,
                pending_section: None,
            }
        }

        fn select(&mut self, key: &'static str, tx: &mut Tx) {
            let Some(next) = Section::from_nav_key(key) else {
                return;
            };
            if next != self.section && self.dirty {
                self.pending_section = Some(next);
                return;
            }
            self.section = next;
            self.narrow.open_detail_focus(tx);
        }

        fn request_close(&mut self) {
            if self.dirty {
                self.confirm_close = true;
            } else {
                self.shown = false;
                self.narrow.reset_to_list();
            }
        }

        fn handle_escape(&mut self, tx: &mut Tx) {
            if self.confirm_close {
                self.confirm_close = false;
                return;
            }
            if self.pending_section.take().is_some() {
                return;
            }
            if self.narrow.is_narrow() && self.narrow.view() == NarrowView::Detail {
                self.narrow.return_to_list(self.section, tx);
            } else {
                self.request_close();
            }
        }
    }

    fn embedded_view(s: &EmbeddedHarness, cx: &mut Cx<EmbeddedHarness>) -> El {
        let locale = s.locale;
        strings::with_locale(locale, || {
            layout::render(cx, |_| {
                if !s.shown {
                    return rune::el().key("embedded-closed");
                }
                let rtl = rune_theme_codenomad::catalogue::direction(locale) == "rtl";
                let narrow = s.narrow.is_narrow_with_fallback(0.0);
                let sections = [Section::General, Section::Providers, Section::Remote];
                let nav_items: Vec<_> = sections
                    .iter()
                    .map(|&section| (section.nav_key(), section.label(), s.section == section))
                    .collect();
                let mut overlays = Vec::new();
                if s.confirm_close {
                    overlays.push(
                        rune::el()
                            .key("confirm-close-overlay")
                            .child(text("confirm-close")),
                    );
                } else if s.pending_section.is_some() {
                    overlays.push(
                        rune::el()
                            .key("confirm-section-overlay")
                            .child(text("confirm-section")),
                    );
                }
                if narrow {
                    let content = if s.narrow.view() == NarrowView::Detail {
                        chrome::narrow_pane(
                            s.section.pane_key(),
                            chrome::narrow_header(
                                s.section.label(),
                                Some((
                                    t("sessionList.history.back"),
                                    t("settings.navigationAriaLabel"),
                                    rtl,
                                    |s: &mut EmbeddedHarness, tx: &mut Tx| {
                                        s.narrow.return_to_list(s.section, tx);
                                    },
                                )),
                                t("settings.close"),
                                s.touch,
                                |s: &mut EmbeddedHarness, _| s.request_close(),
                            ),
                            [col().full_width().child(text(s.section.label()).wrap())],
                        )
                    } else {
                        chrome::narrow_list_screen(
                            chrome::narrow_header(
                                t("settings.title"),
                                None::<(&str, &str, bool, fn(&mut EmbeddedHarness, &mut Tx))>,
                                t("settings.close"),
                                s.touch,
                                |s: &mut EmbeddedHarness, _| s.request_close(),
                            ),
                            chrome::narrow_nav(
                                t("settings.navigationAriaLabel"),
                                nav_items,
                                s.touch,
                                |s: &mut EmbeddedHarness, key, tx| s.select(key, tx),
                            ),
                        )
                    };
                    chrome::embedded_narrow_frame(
                        t("settings.title"),
                        content,
                        overlays,
                        |s: &mut EmbeddedHarness, tx: &mut Tx| s.handle_escape(tx),
                    )
                } else {
                    chrome::embedded_section(
                        t("settings.title"),
                        col().full_width().child(text(s.section.label()).wrap()),
                        layout::button(t("settings.close"), false, |s: &mut EmbeddedHarness| {
                            s.request_close();
                        })
                        .key("close-preferences"),
                        |s: &mut EmbeddedHarness| s.request_close(),
                    )
                    .children(overlays)
                }
                .on_layout_tx(|s: &mut EmbeddedHarness, [_, _, width, _], tx| {
                    s.narrow.measure(width, tx);
                })
            })
            .locale_direction(locale)
        })
    }

    fn focused_key(rt: &Runtime<EmbeddedHarness>) -> Option<String> {
        fn find_focused(tree: &serde_json::Value) -> Option<String> {
            if tree["states"]
                .as_array()
                .is_some_and(|states| states.iter().any(|s| s == "focused"))
                && let Some(key) = tree["key"].as_str()
            {
                return Some(key.to_string());
            }
            tree["children"].as_array()?.iter().find_map(find_focused)
        }
        find_focused(&rt.accessibility_json())
    }

    fn click(rt: &mut Runtime<EmbeddedHarness>, key: &str) {
        let (x, y) = rt
            .find(key)
            .unwrap_or_else(|| panic!("expected clickable element {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        rt.frame(0.02);
    }

    fn press(rt: &mut Runtime<EmbeddedHarness>, key: Key) {
        rt.key(KeyEvent {
            key,
            mods: Mods::default(),
        });
        rt.frame(0.02);
        rt.frame(0.02);
    }

    #[test]
    fn section_nav_keys_round_trip_and_requested_fallback_is_clean() {
        let all = [
            Section::General,
            Section::Conversation,
            Section::OpenCode,
            Section::Notifications,
            Section::Voice,
            Section::Providers,
            Section::Missions,
            Section::Integrations,
            Section::Shortcuts,
            Section::Stats,
            Section::Remote,
            Section::ConfigFiles,
            Section::Advanced,
            Section::Info,
        ];
        for section in all {
            assert_eq!(Section::from_nav_key(section.nav_key()), Some(section));
            assert!(!section.pane_key().is_empty());
        }
        assert_eq!(Section::from_nav_key("unknown"), None);
        assert_eq!(
            resolve_requested_section(Section::Remote, true),
            Section::Remote
        );
        assert_eq!(
            resolve_requested_section(Section::Remote, false),
            Section::General
        );
        assert_eq!(
            resolve_requested_section(Section::Providers, true),
            Section::Providers
        );
    }

    #[test]
    fn narrow_state_tracks_breakpoint_ime_and_resize_round_trip() {
        let mut narrow = NarrowState::default();
        let mut tx = Tx::default();
        assert!(!narrow.is_narrow());
        assert_eq!(narrow.effective_width(411.0), 411.0);
        assert!(narrow.is_narrow_with_fallback(411.0));

        // 599 pt is narrow; 600 pt is wide.
        narrow.measure(599.0, &mut tx);
        assert!(narrow.is_narrow());
        assert_eq!(narrow.view(), NarrowView::List);

        narrow.open_detail_focus(&mut tx);
        assert_eq!(narrow.view(), NarrowView::Detail);

        // Same width (IME vertical resize) keeps Detail untouched.
        narrow.measure(599.0, &mut tx);
        assert_eq!(narrow.view(), NarrowView::Detail);

        // Widening to 600 pt leaves narrow mode.
        narrow.measure(600.0, &mut tx);
        assert!(!narrow.is_narrow());

        // Narrowing from wide (>= 600) back to 411 preserves open section as Detail.
        narrow.reset_to_list();
        narrow.measure(411.0, &mut tx);
        assert!(narrow.is_narrow());
        assert_eq!(narrow.view(), NarrowView::Detail);

        // Seed width primes first-frame layout without waiting for layout feedback.
        let mut fresh = NarrowState::default();
        fresh.seed_width(411.0);
        assert!(fresh.is_narrow());
        assert_eq!(fresh.view(), NarrowView::List);
    }

    #[test]
    fn embedded_narrow_frame_supports_ltr_rtl_touch_escape_dirty_guard_and_ime() {
        for (locale, (w, h)) in [("en", (411.0, 890.0)), ("he", (360.0, 800.0))] {
            let mut rt = Runtime::new(
                EmbeddedHarness::new(locale, true),
                embedded_view,
                (w, h),
                Env::new(true, 1.0),
            );
            rt.frame(0.0);
            rt.frame(0.02);
            rt.frame(0.02);

            assert!(rt.state.narrow.is_narrow());
            assert_eq!(rt.state.narrow.view(), NarrowView::List);
            assert!(rt.find("settings-narrow-list").is_some());
            assert!(rt.find(NARROW_BACK_KEY).is_none());

            // Touch close button meets 44 pt target with square corners.
            let close_btn = rt
                .elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some("settings-close"))
                .expect("close button in narrow header");
            assert!(close_btn.rect[2] >= 44.0 && close_btn.rect[3] >= 44.0);
            assert_eq!(close_btn.radius, 0.0);

            // Open Remote -> enters Detail and focuses back button.
            click(&mut rt, "settings-remote");
            assert_eq!(rt.state.section, Section::Remote);
            assert_eq!(rt.state.narrow.view(), NarrowView::Detail);
            assert_eq!(focused_key(&rt).as_deref(), Some(NARROW_BACK_KEY));
            assert!(rt.find("remote").is_some());

            let back_btn = rt
                .elements()
                .into_iter()
                .find(|el| el.key.as_deref() == Some(NARROW_BACK_KEY))
                .expect("back button in narrow detail");
            assert!(back_btn.rect[2] >= 44.0 && back_btn.rect[3] >= 44.0);
            assert_eq!(back_btn.radius, 0.0);

            // Vertical IME shrink preserves Remote Detail and focus.
            rt.set_viewport((w, 480.0), 1.0);
            rt.frame(0.02);
            rt.frame(0.02);
            assert_eq!(rt.state.narrow.view(), NarrowView::Detail);
            assert_eq!(rt.state.section, Section::Remote);

            // Zero horizontal overflow across every rendered element.
            for el in rt.elements() {
                if el.rect[2] <= 0.0 || el.rect[3] <= 0.0 {
                    continue;
                }
                assert!(
                    el.rect[0] >= -1.0 && el.rect[0] + el.rect[2] <= w + 1.0,
                    "locale={locale} ({w}x480) element {:?} overflowed: {:?}",
                    el.key,
                    el.rect
                );
            }

            // First Escape from Detail returns to List and restores focus to Remote row.
            press(&mut rt, Key::Escape);
            assert!(rt.state.shown);
            assert_eq!(rt.state.narrow.view(), NarrowView::List);
            assert_eq!(focused_key(&rt).as_deref(), Some("settings-remote"));

            // With an unsaved draft, Escape from List opens close confirmation instead of closing.
            rt.state.dirty = true;
            press(&mut rt, Key::Escape);
            assert!(rt.state.shown);
            assert!(rt.state.confirm_close);

            // Escape dismisses confirmation; clearing dirty allows Escape to close Preferences.
            press(&mut rt, Key::Escape);
            assert!(!rt.state.confirm_close);
            assert!(rt.state.shown);
            rt.state.dirty = false;
            press(&mut rt, Key::Escape);
            assert!(!rt.state.shown);
        }
    }
}
