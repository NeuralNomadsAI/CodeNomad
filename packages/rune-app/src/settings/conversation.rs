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
    let table = chrome::setting_table_frame(
        t("settings.behavior.expansionDefaults.title"),
        chrome::setting_table_header(
            t("settings.behavior.expansionDefaults.itemColumn"),
            t("settings.behavior.expansionDefaults.stateColumn"),
            compact,
        ),
        Row::all().enumerate().map(|(index, row)| {
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
            let control = chrome::table_picker(&key, &aria, &labels, compact)
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
            chrome::setting_table_row_with_icon(row_icon(row), title, control, compact, index == 0)
        }),
    )
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
    });
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

pub(super) fn preset_label(preset: &str) -> &'static str {
    t(&format!("settings.behavior.expansionPreset.{preset}.title"))
}

fn row_icon(row: Row) -> &'static str {
    match row {
        Row::Thinking => "thinking",
        Row::Diagnostics => "diagnostics",
        Row::Inputs => "inputs",
        Row::Usage => "usage",
        Row::System => "system",
        Row::Groups => "toolgroups",
        Row::Tool(id) => id,
    }
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

#[cfg(test)]
#[test]
fn conversation_pickers_expose_accessible_value_without_encoding_name() {
    use rune::{Env, Runtime};

    fn a11y_node<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if node["key"] == key {
            return Some(node);
        }
        node["children"]
            .as_array()?
            .iter()
            .find_map(|child| a11y_node(child, key))
    }

    struct Harness {
        prefs: Preferences,
        open: Option<Row>,
    }

    let mut prefs = Preferences::default();
    prefs.fixture();
    let mut rt = Runtime::new(
        Harness { prefs, open: None },
        |s, _| {
            crate::strings::with_locale("en", || {
                let mut layers = Vec::new();
                let body = content(
                    &s.prefs,
                    s.open,
                    4,
                    &mut layers,
                    |s: &mut Harness, open| s.open = open,
                    |_, _, _| {},
                );
                rune_theme_codenomad::layout::with_overlays(body, layers)
            })
        },
        (900.0, 760.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);

    let tree = rt.accessibility_json();
    let groups = a11y_node(&tree, "transcript-toolGroupVisibility-trigger").unwrap();
    let expected_name = crate::strings::with_locale("en", || {
        catalogue::format(
            locale(),
            "settings.behavior.expansionDefaults.rowAriaLabel",
            &[("item", row_label(Row::Groups))],
        )
    });
    assert_eq!(groups["role"], "combo-box");
    assert_eq!(groups["name"], expected_name);
    assert_eq!(groups["value"], "Collapsed");

    let mirror: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
    let combo = mirror
        .iter()
        .find(|item| item["t"] == expected_name && item["o"] == "combobox")
        .unwrap_or_else(|| panic!("missing Tool groups combobox in web mirror: {mirror:?}"));
    assert_eq!(combo["v"], "Collapsed");
}
