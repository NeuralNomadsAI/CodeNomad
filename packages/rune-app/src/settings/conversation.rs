use super::{
    Preferences,
    transcript_preset::{PRESETS, Row},
};
use crate::strings::{locale, t};
use rune::{El, col, text};
use rune_theme_codenomad::{Space, TextRole, catalogue, layout::Layout, settings as chrome};

const MODES: [&str; 3] = ["hidden", "collapsed", "expanded"];

fn row_key(row: Row) -> String {
    if row == Row::Usage {
        "usage-visibility".into()
    } else {
        format!("transcript-{}", row.control_key())
    }
}

fn row_from_trigger(focused: &str) -> Option<Row> {
    let key = focused.strip_suffix("-trigger")?;
    if key == "usage-visibility" {
        return Some(Row::Usage);
    }
    let control = key.strip_prefix("transcript-")?;
    Row::all().find(|row| *row != Row::Usage && row.control_key() == control)
}

pub(super) fn content<S: 'static>(
    prefs: &Preferences,
    open: Option<Row>,
    preset_columns: usize,
    layers: &mut Vec<El>,
    set_open: impl Fn(&mut S, Option<Row>) + Copy + 'static,
    choose: impl Fn(&mut S, Option<Row>, &'static str) + Copy + 'static,
) -> El {
    let disabled = !prefs.transcript_ready();
    let preset = prefs.transcript_preset_display();
    let presets_title = t("settings.behavior.expansionPresets.ariaLabel");
    let labels = PRESETS.map(preset_label);
    let compact = preset_columns < 4;
    let table = col()
        .role("table")
        .label(t("settings.behavior.expansionDefaults.title"))
        .full_width()
        .separate(Space::Sm)
        .on_key(move |s: &mut S, event, tx| {
            if disabled
                || open.is_some()
                || event.mods != rune::Mods::default()
                || event.key != rune::Key::Enter
                || tx.key_repeat()
            {
                return false;
            }
            let Some(row) = tx.focused().and_then(row_from_trigger) else {
                return false;
            };
            set_open(s, Some(row));
            true
        })
        .child(chrome::setting_table_header(
            t("settings.behavior.expansionDefaults.itemColumn"),
            t("settings.behavior.expansionDefaults.stateColumn"),
            compact,
        ))
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
            let key = row_key(row);
            let is_open = open == Some(row) && !disabled;
            let current = current.map(|i| labels[i]);
            let name = picker_name(&aria, current);
            let control = chrome::table_picker(&key, &name, &labels, compact)
                .current(current)
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
            let control = chrome::build_picker(control, layers);
            chrome::setting_table_row(title, control, compact)
        }));
    let controls = col()
        .full_width()
        .separate(Space::Sm)
        .child(
            text(presets_title)
                .text_role(TextRole::Title)
                .role("heading"),
        )
        .child(chrome::preset_buttons(
            presets_title,
            &labels,
            PRESETS.iter().position(|name| *name == preset),
            t("permissionApproval.status.active"),
            t("commands.common.disabled"),
            disabled,
            preset_columns,
            move |s, index| choose(s, None, PRESETS[index]),
        ))
        .child(table);
    chrome::card(controls)
}

pub(super) fn picker_name<'a>(label: &'a str, value: Option<&str>) -> std::borrow::Cow<'a, str> {
    #[cfg(any(target_arch = "wasm32", test))]
    if let Some(value) = value {
        return format!("{label} — {value}").into();
    }
    let _ = value;
    label.into()
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
