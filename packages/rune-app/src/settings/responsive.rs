use crate::strings::t;
use rune_theme_codenomad::settings as chrome;

pub(super) const SECTION_PICKER_TRIGGER_KEY: &str = "settings-section-picker-trigger";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Section {
    General,
    Conversation,
    Shortcuts,
    Notifications,
    Voice,
    Remote,
    OpenCode,
    Providers,
    Missions,
    Stats,
    Integrations,
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
    /// Exact section order matching Solid `SettingsScreen` (D1).
    pub(super) const ORDER: [Self; 14] = [
        Self::General,
        Self::Conversation,
        Self::Shortcuts,
        Self::Notifications,
        Self::Voice,
        Self::Remote,
        Self::OpenCode,
        Self::Providers,
        Self::Missions,
        Self::Stats,
        Self::Integrations,
        Self::ConfigFiles,
        Self::Advanced,
        Self::Info,
    ];

    pub(super) fn nav_key(self) -> &'static str {
        match self {
            Self::General => "settings-general",
            Self::Conversation => "settings-conversation",
            Self::Shortcuts => "settings-hotkeys",
            Self::Notifications => "settings-notifications",
            Self::Voice => "settings-voice",
            Self::Remote => "settings-remote",
            Self::OpenCode => "settings-opencode",
            Self::Providers => "settings-providers",
            Self::Missions => "settings-missions",
            Self::Stats => "settings-stats",
            Self::Integrations => "settings-integrations",
            Self::ConfigFiles => "settings-config-files",
            Self::Advanced => "settings-advanced",
            Self::Info => "settings-info",
        }
    }

    pub(super) fn pane_key(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Conversation => "conversation",
            Self::Shortcuts => "hotkeys",
            Self::Notifications => "notifications",
            Self::Voice => "voice",
            Self::Remote => "remote",
            Self::OpenCode => "opencode",
            Self::Providers => "providers",
            Self::Missions => "missions",
            Self::Stats => "stats",
            Self::Integrations => "integrations",
            Self::ConfigFiles => "config-files",
            Self::Advanced => "advanced",
            Self::Info => "info",
        }
    }

    pub(super) fn from_nav_key(key: &str) -> Option<Self> {
        Some(match key {
            "settings-general" => Self::General,
            "settings-conversation" => Self::Conversation,
            "settings-hotkeys" => Self::Shortcuts,
            "settings-notifications" => Self::Notifications,
            "settings-voice" => Self::Voice,
            "settings-remote" => Self::Remote,
            "settings-opencode" => Self::OpenCode,
            "settings-providers" => Self::Providers,
            "settings-missions" => Self::Missions,
            "settings-stats" => Self::Stats,
            "settings-integrations" => Self::Integrations,
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
            Self::Shortcuts => "settings.nav.hotkeys",
            Self::Notifications => "settings.nav.notifications",
            Self::Voice => "settings.nav.voice",
            Self::Remote => "settings.nav.remote",
            Self::OpenCode => "settings.nav.opencode",
            Self::Providers => "settings.nav.providers",
            Self::Missions => "settings.nav.missions",
            Self::Stats => "settings.usage.title",
            Self::Integrations => "settings.nav.integrations",
            Self::ConfigFiles => "settings.nav.configFiles",
            Self::Advanced => "settings.nav.advanced",
            Self::Info => "settings.nav.info",
        })
    }
}

/// Narrow (`< 600 pt`) viewport state for D12 compact bar: opens directly on the active section
/// and tracks whether the compact section picker dropdown is open.
#[derive(Default, Clone, Copy, Debug)]
pub(super) struct NarrowState {
    width: f32,
    picker_open: bool,
}

impl NarrowState {
    pub(super) fn is_narrow(self) -> bool {
        chrome::is_narrow(self.width)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn width(self) -> f32 {
        if self.width > 0.0 {
            self.width
        } else {
            chrome::WINDOW_SIZE.0
        }
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
    pub(super) fn seed_width(&mut self, width: f32) {
        if width > 0.0 {
            self.width = width;
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn open_picker_for_gallery(&mut self) {
        self.width = 411.0;
        self.picker_open = true;
    }

    pub(super) fn picker_open(self) -> bool {
        self.picker_open && self.is_narrow()
    }

    pub(super) fn toggle_picker(&mut self, tx: &mut rune::Tx) {
        if !self.is_narrow() {
            self.picker_open = false;
            return;
        }
        self.picker_open = !self.picker_open;
        if !self.picker_open {
            tx.focus(SECTION_PICKER_TRIGGER_KEY, true);
        }
    }

    pub(super) fn close_picker(&mut self) -> bool {
        std::mem::replace(&mut self.picker_open, false)
    }

    pub(super) fn close_picker_focus(&mut self, tx: &mut rune::Tx) -> bool {
        let was_open = self.close_picker();
        if was_open {
            tx.focus(SECTION_PICKER_TRIGGER_KEY, true);
        }
        was_open
    }

    /// Updates the measured viewport width. Vertical-only IME resizes leave width unchanged and
    /// preserve the picker state; widening past the breakpoint closes the compact picker.
    pub(super) fn measure(&mut self, width: f32, tx: &mut rune::Tx) {
        if width <= 0.0 || (self.width - width).abs() <= 0.5 {
            return;
        }
        let was_narrow = self.is_narrow();
        self.width = width;
        let now_narrow = self.is_narrow();
        if !now_narrow {
            self.picker_open = false;
        }
        if was_narrow != now_narrow {
            tx.wake_after(std::time::Duration::ZERO);
        }
    }
}

pub(super) fn resolve_requested_section(requested: Section, allowed: bool) -> Section {
    if allowed { requested } else { Section::General }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_order_matches_solid_and_nav_keys_round_trip() {
        assert_eq!(
            Section::ORDER,
            [
                Section::General,
                Section::Conversation,
                Section::Shortcuts,
                Section::Notifications,
                Section::Voice,
                Section::Remote,
                Section::OpenCode,
                Section::Providers,
                Section::Missions,
                Section::Stats,
                Section::Integrations,
                Section::ConfigFiles,
                Section::Advanced,
                Section::Info,
            ]
        );
        for section in Section::ORDER {
            assert_eq!(Section::from_nav_key(section.nav_key()), Some(section));
            assert!(!section.pane_key().is_empty());
        }
        assert_eq!(Section::from_nav_key("settings-unknown"), None);
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
    fn narrow_state_tracks_breakpoint_picker_and_ime_resize() {
        let mut rt = rune::Runtime::new(
            NarrowState::default(),
            |_, _| rune::el(),
            (411.0, 890.0),
            rune::Env::new(true, 1.0),
        );
        rt.frame(0.0);

        // Initial narrow measurement (< 600 pt) enters compact mode with picker closed.
        rt.update(|narrow, tx| {
            narrow.measure(411.0, tx);
            assert!(narrow.is_narrow());
            assert!(!narrow.picker_open());

            narrow.toggle_picker(tx);
            assert!(narrow.picker_open());

            // Same width (IME vertical resize) leaves picker state untouched.
            narrow.measure(411.0, tx);
            assert!(narrow.picker_open());

            // Widening to 600 pt exits narrow mode and closes the compact picker.
            narrow.measure(600.0, tx);
            assert!(!narrow.is_narrow());
            assert!(!narrow.picker_open());

            // Narrowing back keeps picker closed so the active section stays visible directly.
            narrow.measure(599.0, tx);
            assert!(narrow.is_narrow());
            assert!(!narrow.picker_open());

            // Seed width primes first-frame layout before layout feedback arrives.
            let mut fresh = NarrowState::default();
            fresh.seed_width(411.0);
            assert!(fresh.is_narrow());
            assert_eq!(fresh.effective_width(1100.0), 411.0);
        });
    }
}
