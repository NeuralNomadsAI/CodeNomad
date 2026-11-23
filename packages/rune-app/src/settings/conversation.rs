use super::{Preferences, preferences::Owner};
use crate::strings::{locale, t};
use rune::El;
use rune_theme_codenomad::{catalogue, settings as chrome};

const OPTIONS: [(&str, &str); 3] = [
    ("hidden", "commands.common.hidden"),
    ("collapsed", "commands.common.collapsed"),
    ("expanded", "commands.common.expanded"),
];

pub(super) fn row<S: 'static>(
    prefs: &Preferences,
    open: bool,
    layers: &mut Vec<El>,
    set_open: impl Fn(&mut S, bool) + Copy + 'static,
    choose: impl Fn(&mut S, &'static str) + Clone + 'static,
) -> El {
    let title = t("settings.behavior.usageMetrics.title");
    let labels = OPTIONS.map(|(_, label)| t(label));
    let current = OPTIONS
        .iter()
        .position(|(mode, _)| *mode == prefs.usage_visibility(true));
    let aria = catalogue::format(
        locale(),
        "settings.behavior.expansionDefaults.rowAriaLabel",
        &[("item", title)],
    );
    let control = chrome::picker("usage-visibility", &aria, &labels)
        .current(current.map(|i| labels[i]))
        .disabled(prefs.saved(Owner::Config).is_none() || !prefs.can_retry())
        .open(open)
        .on_toggle(move |s: &mut S| set_open(s, !open))
        .on_close(move |s: &mut S| set_open(s, false))
        .on_choose(move |s: &mut S, value, _| {
            set_open(s, false);
            if let Some(i) = labels.iter().position(|label| *label == value) {
                choose(s, OPTIONS[i].0);
            }
        });
    chrome::card(chrome::setting_row(
        title,
        chrome::build_picker(control, layers),
    ))
}
