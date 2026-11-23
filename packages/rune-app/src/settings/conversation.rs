use super::{
    Preferences,
    preferences::Owner,
    transcript_preset::{PRESETS, Row},
};
use crate::strings::{locale, t};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, catalogue, layout::Layout, settings as chrome};

const MODES: [&str; 3] = ["hidden", "collapsed", "expanded"];

pub(super) fn content<S: 'static>(
    prefs: &Preferences,
    open: Option<Row>,
    layers: &mut Vec<El>,
    set_open: impl Fn(&mut S, Option<Row>) + Copy + 'static,
    choose: impl Fn(&mut S, Option<Row>, &'static str) + Copy + 'static,
) -> El {
    let disabled = prefs.saved(Owner::Config).is_none() || !prefs.can_retry();
    let preset = prefs.transcript_preset();
    let labels = PRESETS.map(|preset| preset_label(preset));
    let controls = col()
        .full_width()
        .separate(Space::Sm)
        .child(chrome::segments(
            t("settings.behavior.expansionPresets.ariaLabel"),
            &labels,
            PRESETS.iter().position(|name| *name == preset),
            disabled,
            move |s, index| choose(s, None, PRESETS[index]),
        ))
        .children((preset == "custom").then(|| text(preset_label("custom")).role("status")))
        .children(Row::all().map(|row| {
            let title = row_label(row);
            let labels = [
                t(if row == Row::Groups {
                    "commands.common.disabled"
                } else {
                    "commands.common.hidden"
                }),
                t("commands.common.collapsed"),
                t("commands.common.expanded"),
            ];
            let current = MODES
                .iter()
                .position(|mode| *mode == prefs.transcript_mode(row, true));
            let aria = catalogue::format(
                locale(),
                "settings.behavior.expansionDefaults.rowAriaLabel",
                &[("item", title)],
            );
            let key = if row == Row::Usage {
                "usage-visibility".into()
            } else {
                format!("transcript-{}", row.control_key())
            };
            let is_open = open == Some(row);
            let control = chrome::picker(&key, &aria, &labels)
                .current(current.map(|i| labels[i]))
                .disabled(disabled)
                .open(is_open)
                .on_toggle(move |s: &mut S| set_open(s, (!is_open).then_some(row)))
                .on_close(move |s: &mut S| set_open(s, None))
                .on_choose(move |s: &mut S, value, _| {
                    set_open(s, None);
                    if let Some(i) = labels.iter().position(|label| *label == value) {
                        choose(s, Some(row), MODES[i]);
                    }
                });
            chrome::setting_row(title, chrome::build_picker(control, layers))
        }));
    chrome::card(controls)
}

pub(super) fn preset_label(preset: &str) -> &'static str {
    t(&format!("settings.behavior.expansionPreset.{preset}.title"))
}

pub(super) fn row_label(row: Row) -> &'static str {
    match row {
        Row::Thinking => t("settings.behavior.expansionDefaults.thinking"),
        Row::Diagnostics => t("settings.behavior.diagnosticsDefault.title"),
        Row::Inputs => t("settings.behavior.toolInputsVisibility.title"),
        Row::Usage => t("settings.behavior.usageMetrics.title"),
        Row::System => t("transcriptFilters.systemMessages"),
        Row::Groups => t("transcriptFilters.toolGroups"),
        Row::Tool("other") => t("settings.behavior.expansionDefaults.otherTools"),
        Row::Tool("bash") => "shell",
        Row::Tool("task") => "subagent",
        Row::Tool(id) => id,
    }
}
