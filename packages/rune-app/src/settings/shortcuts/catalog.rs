use super::{FILE_SAVE, Preferences, bindings_conflict, decode, format_chords};
use rune::{Chord, KeyPlatform};
use serde_json::Value;
use std::sync::OnceLock;

pub(in crate::settings) struct Row {
    pub id: &'static str,
    pub label: String,
    pub binding: String,
    pub active: bool,
    pub overridden: bool,
    pub conflicts: Vec<(String, String)>,
    chords: Vec<Chord>,
    pub(super) scope: &'static str,
}

fn definitions() -> &'static [Value] {
    static DEFINITIONS: OnceLock<Vec<Value>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../crates/rune-theme-codenomad/assets/hotkeys.json"
        ))
        .expect("generated shortcut definitions")
    })
}

pub(in crate::settings) fn active(id: &str) -> bool {
    matches!(
        id,
        "new-instance"
            | "new-temporary-instance"
            | "close-instance"
            | "instance-prev"
            | "instance-next"
            | "app-tab-1"
            | "app-tab-2"
            | "app-tab-3"
            | "app-tab-4"
            | "app-tab-5"
            | "app-tab-6"
            | "app-tab-7"
            | "app-tab-8"
            | "app-tab-9"
            | "session-new"
            | "session-prev"
            | "session-next"
            | "session-tab-1"
            | "session-tab-2"
            | "session-tab-3"
            | "session-tab-4"
            | "session-tab-5"
            | "session-tab-6"
            | "session-tab-7"
            | "session-tab-8"
            | "session-tab-9"
            | "session-search"
            | "close-session"
            | "prompt-exit-shell"
            | "cleanup-blank-sessions"
            | "open-command-palette"
            | "instance-rename"
            | FILE_SAVE
    ) || (id == "browse-folder" && crate::platform::folder_picker_available())
        || (matches!(
            id,
            "open-workspace-folder"
                | "open-workspace-terminal"
                | "open-workspace-editor-vscode"
                | "open-workspace-editor-cursor"
                | "open-workspace-editor-zed"
                | "open-workspace-editor-vscodium"
        ) && crate::platform::workspace_open::AVAILABLE)
}

fn default_index(prefs: &Preferences, platform: KeyPlatform) -> usize {
    let no_enter = prefs
        .saved(super::super::preferences::Owner::Config)
        .is_some_and(|doc| doc["settings"]["promptSubmitOnEnter"] == false);
    2 * usize::from(platform == KeyPlatform::Mac) + usize::from(no_enter)
}

fn is_region_cycle(chord: &Chord, platform: KeyPlatform) -> bool {
    let f6 = Chord::new(rune::ChordKey::Function(6));
    chord.same_keys(&f6, platform) || chord.same_keys(&f6.with(rune::ChordMod::Shift), platform)
}

fn is_valid_rule(rule: &Value) -> bool {
    let Some(obj) = rule.as_object() else {
        return false;
    };
    if !obj.get("key").and_then(Value::as_str).is_some_and(|key| {
        let lower = key.to_lowercase();
        !key.is_empty()
            && key.encode_utf16().count() <= 40
            && !key.chars().any(char::is_control)
            && !matches!(
                lower.as_str(),
                "control"
                    | "ctrl"
                    | "meta"
                    | "shift"
                    | "alt"
                    | "altgraph"
                    | "unidentified"
                    | "dead"
                    | "process"
            )
    }) {
        return false;
    }
    ["mod", "ctrl", "meta", "alt", "shift"]
        .iter()
        .all(|name| obj.get(*name).is_none_or(Value::is_boolean))
}

fn resolve_def(
    overrides: Option<&[Value]>,
    def: &Value,
    index: usize,
    platform: KeyPlatform,
) -> Vec<Chord> {
    let mut chords = Vec::new();
    let source = overrides.filter(|rules| rules.len() <= 8 && rules.iter().all(is_valid_rule));
    let iter: &[Value] = match source {
        Some(rules) => rules,
        None => def["defaults"][index].as_array().map_or(&[], Vec::as_slice),
    };
    for chord in iter
        .iter()
        .filter_map(decode)
        .filter(|chord| !is_region_cycle(chord, platform))
    {
        if !chords
            .iter()
            .any(|existing: &Chord| existing.same_keys(&chord, platform))
        {
            chords.push(chord);
        }
    }
    chords
}

pub(super) fn resolve(prefs: &Preferences, id: &str) -> Vec<Chord> {
    let Some(def) = definitions()
        .iter()
        .find(|def| def["id"].as_str() == Some(id))
    else {
        return Vec::new();
    };
    let platform = KeyPlatform::current();
    let index = default_index(prefs, platform);
    resolve_def(prefs.shortcut(id), def, index, platform)
}

pub(in crate::settings) fn rows(prefs: &Preferences, filter: &str) -> Vec<Row> {
    let locale = crate::strings::locale();
    let platform = KeyPlatform::current();
    let index = default_index(prefs, platform);
    let mut rows: Vec<_> = definitions()
        .iter()
        .filter_map(|def| {
            let id = def["id"].as_str()?;
            let label = rune_theme_codenomad::catalogue::format(
                locale,
                def["labelKey"].as_str()?,
                &[
                    ("index", id.rsplit_once('-').map_or("", |(_, n)| n)),
                    (
                        "editor",
                        def["labelParams"]["editor"].as_str().unwrap_or(""),
                    ),
                ],
            );
            let overrides = prefs.shortcut(id);
            let chords = resolve_def(overrides, def, index, platform);
            Some(Row {
                id,
                label,
                binding: format_chords(&chords),
                active: active(id),
                overridden: overrides.is_some(),
                conflicts: Vec::new(),
                chords,
                scope: def["scope"].as_str()?,
            })
        })
        .collect();
    let filter = filter.trim().to_lowercase();
    let matches = |row: &Row| {
        filter.is_empty()
            || row.label.to_lowercase().contains(&filter)
            || row.binding.to_lowercase().contains(&filter)
    };
    for i in 0..rows.len() {
        let row = &rows[i];
        if matches(row) {
            rows[i].conflicts = row
                .chords
                .iter()
                .filter_map(|chord| {
                    let binding = std::slice::from_ref(chord);
                    let others = rows
                        .iter()
                        .filter(|other| {
                            scopes_overlap(row, other)
                                && bindings_conflict(binding, &other.chords, platform)
                        })
                        .map(|other| other.label.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    (!others.is_empty()).then(|| (format_chords(binding), others))
                })
                .collect();
        }
    }
    rows.retain(matches);
    rows
}

fn scopes_overlap(first: &Row, second: &Row) -> bool {
    if first.id == second.id {
        return false;
    }
    let (a, b) = (first.scope, second.scope);
    if a == "home" || b == "home" {
        return ["home", "app", "instance-tab"].contains(&a)
            && ["home", "app", "instance-tab"].contains(&b);
    }
    let focused = ["composer", "aside", "search", "files", "instance-tab"];
    let escape = |id| matches!(id, "session-abort" | "prompt-blur" | "prompt-exit-shell");
    !(a != b && focused.contains(&a) && focused.contains(&b)
        || escape(first.id) && escape(second.id))
}

#[cfg(test)]
#[test]
fn solid_catalog_keeps_every_action_and_decodes_every_default() {
    let defs = definitions();
    assert_eq!(defs.len(), 75);
    let keys: std::collections::BTreeSet<_> =
        defs.iter().filter_map(|def| def["id"].as_str()).collect();
    assert_eq!(keys.len(), 75);
    assert_eq!(
        keys.iter().filter(|id| active(id)).count(),
        33 + usize::from(crate::platform::folder_picker_available())
            + 6 * usize::from(crate::platform::workspace_open::AVAILABLE)
    );
    for def in defs {
        for defaults in def["defaults"].as_array().unwrap() {
            for binding in defaults.as_array().unwrap() {
                assert!(decode(binding).is_some(), "{}: {binding}", def["id"]);
            }
        }
    }
    let mut prefs = Preferences::default();
    prefs.fixture_shortcuts(serde_json::json!({
        "file-save":[{"key":"n", "mod":true}],
        "close-instance":[]
    }));
    let rows = rows(&prefs, "");
    assert_eq!(rows.len(), 75);
    let save = rows.iter().find(|row| row.id == FILE_SAVE).unwrap();
    let open = rows.iter().find(|row| row.id == "new-instance").unwrap();
    assert!(
        save.conflicts
            .iter()
            .any(|(_, other)| other.contains(&open.label))
    );
    assert!(
        open.conflicts
            .iter()
            .any(|(_, other)| other.contains(&save.label))
    );
    assert!(
        rows.iter()
            .find(|row| row.id == "close-instance")
            .unwrap()
            .binding
            .is_empty()
    );
    assert!(
        rows.iter()
            .find(|row| row.id == "session-search")
            .unwrap()
            .active
    );
    assert!(
        rows.iter()
            .find(|row| row.id == "session-tab-1")
            .unwrap()
            .active
    );
    assert!(
        rows.iter()
            .find(|row| row.id == "cleanup-blank-sessions")
            .unwrap()
            .active
    );
    assert!(
        !rows
            .iter()
            .find(|row| row.id == "switch-to-info")
            .unwrap()
            .active
    );

    let utf16_40 = "é".repeat(40);
    let utf16_41 = "é".repeat(41);
    let mut invalid = Preferences::default();
    invalid.fixture_shortcuts(serde_json::json!({
        "close-session": [{"key": "Dead"}],
        "close-instance": [{"key": utf16_41}],
        "instance-prev": [{"key": "F8"}, {"key": "f8"}, {"key": "A+B"}],
        "instance-next": [{"key": "BrowserBack"}],
        "session-prev": [{"key": utf16_40}],
        "new-instance": [],
    }));
    assert!(!resolve(&invalid, "close-session").is_empty());
    assert!(!resolve(&invalid, "close-instance").is_empty());
    assert_eq!(
        resolve(&invalid, "instance-prev"),
        vec![Chord::new(rune::ChordKey::Function(8))]
    );
    assert!(resolve(&invalid, "instance-next").is_empty());
    assert!(resolve(&invalid, "session-prev").is_empty());
    assert!(resolve(&invalid, "new-instance").is_empty());
}
