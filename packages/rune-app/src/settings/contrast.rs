use super::Preferences;
use crate::strings::t;
use rune::El;
use rune_theme_codenomad::settings as chrome;

pub(super) fn view<S: 'static>(
    prefs: &Preferences,
    system_more: bool,
    help_open: bool,
    toggle_help: impl Fn(&mut S) + 'static,
    set: impl Fn(&mut S, &'static str) + Clone + 'static,
) -> El {
    const VALUES: [&str; 3] = ["auto", "on", "off"];
    let value = prefs.contrast();
    let name = t("settings.appearance.contrast.title");
    let info = t("settings.appearance.contrast.info");
    let help = if value == "auto" {
        let state = t(if system_more {
            "settings.appearance.contrast.current.on"
        } else {
            "settings.appearance.contrast.current.off"
        });
        format!("{info} {state}")
    } else {
        info.into()
    };
    let controls = chrome::segments(
        name,
        &[
            t("settings.appearance.palette.auto"),
            t("settings.appearance.contrast.on"),
            t("settings.appearance.contrast.off"),
        ],
        VALUES.iter().position(|&choice| choice == value),
        !prefs.locale_ready() || !prefs.can_retry(),
        move |s: &mut S, index| {
            if let Some(&choice) = VALUES.get(index) {
                set(s, choice);
            }
        },
    );
    chrome::contrast_controls(
        name,
        &help,
        help_open,
        controls.key("contrast-mode"),
        toggle_help,
    )
}
