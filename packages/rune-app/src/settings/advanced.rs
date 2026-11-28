use super::Preferences;
use crate::strings::t;
use rune::{El, col};
use rune_theme_codenomad::{Space, layout::Layout, settings as chrome};
pub(super) mod environment;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Toggle {
    EmptySessions,
    UnseenSubagents,
    SecondLaunch,
    ProviderBalance,
    Whitespace,
    LongReplies,
}

impl Toggle {
    const ALL: [Self; 6] = [
        Self::EmptySessions,
        Self::UnseenSubagents,
        Self::SecondLaunch,
        Self::ProviderBalance,
        Self::Whitespace,
        Self::LongReplies,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::EmptySessions => "autoCleanupBlankSessions",
            Self::UnseenSubagents => "keepUnseenSubagentIdleStatus",
            Self::SecondLaunch => "focusExistingWindowOnSecondLaunch",
            Self::ProviderBalance => "showProviderUsageCreditBalance",
            Self::Whitespace => "hideDiffWhitespaceChanges",
            Self::LongReplies => "holdLongAssistantReplies",
        }
    }

    pub fn default_value(self) -> bool {
        !matches!(self, Self::SecondLaunch | Self::ProviderBalance)
    }

    pub fn supported(self) -> bool {
        matches!(
            self,
            Self::EmptySessions | Self::UnseenSubagents | Self::Whitespace
        ) || (cfg!(target_os = "windows") && self == Self::SecondLaunch)
    }

    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::EmptySessions => (
                "settings.behavior.autoCleanup.title",
                "settings.behavior.autoCleanup.subtitle",
            ),
            Self::UnseenSubagents => (
                "settings.behavior.keepUnseenSubagentIdle.title",
                "settings.behavior.keepUnseenSubagentIdle.subtitle",
            ),
            Self::SecondLaunch => (
                "settings.behavior.focusExistingWindowOnSecondLaunch.title",
                "settings.behavior.focusExistingWindowOnSecondLaunch.subtitle",
            ),
            Self::ProviderBalance => (
                "settings.behavior.providerUsageCreditBalance.title",
                "settings.behavior.providerUsageCreditBalance.subtitle",
            ),
            Self::Whitespace => (
                "advancedSettings.hideDiffWhitespace.title",
                "advancedSettings.hideDiffWhitespace.subtitle",
            ),
            Self::LongReplies => (
                "settings.behavior.holdLongAssistantReplies.title",
                "settings.behavior.holdLongAssistantReplies.subtitle",
            ),
        }
    }
}

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    native: bool,
    help_open: Option<Toggle>,
    info: fn(&mut S, Toggle),
    toggle: fn(&mut S, Toggle, bool),
    retry: fn(&mut S),
) -> El {
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .children(prefs.advanced_failed().then(|| {
                rune_theme_codenomad::layout::action_row()
                    .child(chrome::palette::save_error(t(
                        "settings.preferenceSaveFailed",
                    )))
                    .child(rune_theme_codenomad::layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        retry,
                    ))
            }))
            .child(chrome::divided_rows(
                Toggle::ALL
                    .into_iter()
                    .filter(|choice| native || *choice != Toggle::SecondLaunch)
                    .map(|choice| {
                        let (title, help) = choice.labels();
                        let value = prefs.advanced_toggle(choice);
                        let checked = value.unwrap_or_else(|| choice.default_value());
                        let explanation = if choice.supported() {
                            t(help)
                        } else {
                            t("advancedSettings.unavailable")
                        };
                        let info = chrome::info_tip(
                            t(title),
                            explanation,
                            help_open == Some(choice),
                            move |s| info(s, choice),
                        )
                        .key(format!("advanced-help-{}", choice.key()));
                        let checkbox = chrome::checkbox_cell(
                            t(title).into(),
                            checked,
                            !choice.supported()
                                || !prefs.can_retry()
                                || value.is_none()
                                || prefs.advanced_pending(choice),
                            move |s| toggle(s, choice, !checked),
                        )
                        .description(explanation)
                        .key(format!("advanced-switch-{}", choice.key()));
                        chrome::setting_row_with_info(t(title), Some(info), checkbox)
                    }),
            )),
    )
}

#[cfg(test)]
#[test]
fn advanced_rows_place_info_tip_beside_title_in_both_themes() {
    struct Harness {
        dark: bool,
        prefs: Preferences,
        open: Option<Toggle>,
    }
    for dark in [false, true] {
        let mut prefs = Preferences::default();
        prefs.fixture();
        let mut rt = rune::Runtime::new(
            Harness {
                dark,
                prefs,
                open: None,
            },
            |s, cx| {
                rune_theme_codenomad::settings::render(cx, s.dark, None, |_| {
                    crate::strings::with_locale("en", || {
                        view(
                            &s.prefs,
                            true,
                            s.open,
                            |s: &mut Harness, choice| {
                                s.open = (s.open != Some(choice)).then_some(choice)
                            },
                            |_: &mut Harness, _, _| {},
                            |_: &mut Harness| {},
                        )
                    })
                })
            },
            (720.0, 560.0),
            rune::Env::new(dark, 1.0),
        );
        rt.frame(0.02);
        let help = rt
            .find("advanced-help-autoCleanupBlankSessions")
            .expect("info tip positioned");
        let switch = rt
            .find("advanced-switch-autoCleanupBlankSessions")
            .expect("switch positioned");
        assert!(
            help.0 < switch.0,
            "dark={dark}: expected info tip ({help:?}) to sit left of switch ({switch:?})"
        );
        assert!(
            (help.1 - switch.1).abs() < 24.0,
            "dark={dark}: expected info tip ({help:?}) on the same row as switch ({switch:?})"
        );
    }
}
