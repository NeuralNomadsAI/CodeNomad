use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{menu::MenuItemKind, Wry};

/// English labels until a renderer reports its locale. Keys and texts mirror
/// `NATIVE_MENU_LABEL_KEYS` and the English messages in the UI package
/// (`packages/ui/src/lib/native/menu-labels.ts`); a UI test keeps them in sync.
pub(crate) const DEFAULTS: [(&str, &str); 38] = [
    ("file", "File"),
    ("edit", "Edit"),
    ("view", "View"),
    ("window", "Window"),
    ("help", "Help"),
    ("about", "About CodeNomad"),
    ("getUpdates", "Get Updates..."),
    ("codenomadHelp", "CodeNomad Help"),
    ("hide", "Hide CodeNomad"),
    ("hideOthers", "Hide Others"),
    ("showAll", "Show All"),
    ("quit", "Quit CodeNomad"),
    ("openFolder", "Open Project Folder"),
    ("openTerminal", "Open Terminal Here"),
    ("openIn", "Open Project In"),
    ("closeWindow", "Close Window"),
    ("undo", "Undo"),
    ("redo", "Redo"),
    ("cut", "Cut"),
    ("copy", "Copy"),
    ("paste", "Paste"),
    ("pasteAndMatchStyle", "Paste and Match Style"),
    ("delete", "Delete"),
    ("selectAll", "Select All"),
    ("reload", "Reload"),
    ("forceReload", "Force Reload"),
    ("devTools", "Toggle Developer Tools"),
    ("actualSize", "Actual Size"),
    ("zoomIn", "Zoom In"),
    ("zoomOut", "Zoom Out"),
    ("fullScreen", "Toggle Full Screen"),
    ("newWindow", "New Window"),
    ("newInstance", "New Instance"),
    ("commandPalette", "Command Palette"),
    ("minimize", "Minimize"),
    ("maximize", "Maximize"),
    ("zoom", "Zoom"),
    ("bringAllToFront", "Bring All to Front"),
];

const MAX_LABEL_CHARS: usize = 200;

pub(crate) fn label(key: &str) -> &'static str {
    DEFAULTS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, text)| *text)
        .unwrap_or_default()
}

/// Known keys must carry a non-empty bounded label; unknown keys are ignored.
pub(crate) fn validate(labels: &BTreeMap<String, String>) -> Result<(), String> {
    for (key, text) in labels {
        let known = DEFAULTS.iter().any(|(name, _)| name == key);
        if known && (text.trim().is_empty() || text.chars().count() > MAX_LABEL_CHARS) {
            return Err("Invalid native menu label".into());
        }
    }
    Ok(())
}

/// Windows and Linux menus read "&" as a mnemonic marker.
fn display(text: &str) -> String {
    if cfg!(target_os = "macos") {
        text.to_string()
    } else {
        text.replace('&', "&&")
    }
}

fn resolve(key: &str, labels: Option<&BTreeMap<String, String>>) -> String {
    let text = labels
        .and_then(|labels| labels.get(key))
        .map(String::as_str)
        .unwrap_or_else(|| label(key));
    display(text)
}

#[derive(Default)]
pub(crate) struct MenuLabels {
    targets: Mutex<Vec<(&'static str, MenuItemKind<Wry>)>>,
    /// Last reported labels: a window without its own snapshot keeps that locale.
    latest: Mutex<Option<BTreeMap<String, String>>>,
    applied: Mutex<Option<BTreeMap<String, String>>>,
}

impl MenuLabels {
    pub(crate) fn replace_targets(&self, targets: Vec<(&'static str, MenuItemKind<Wry>)>) {
        if let Ok(mut current) = self.targets.lock() {
            *current = targets;
        }
        if let Ok(mut applied) = self.applied.lock() {
            *applied = None;
        }
    }

    /// Runs on the main thread. Native menu calls happen outside our mutexes.
    pub(crate) fn apply(&self, reported: Option<&BTreeMap<String, String>>) {
        let labels = {
            let Ok(mut latest) = self.latest.lock() else { return };
            if let Some(reported) = reported {
                *latest = Some(reported.clone());
            }
            latest.clone()
        };
        let Some(labels) = labels else { return };
        {
            let Ok(mut applied) = self.applied.lock() else { return };
            if applied.as_ref() == Some(&labels) {
                return;
            }
            *applied = Some(labels.clone());
        }
        let targets = match self.targets.lock() {
            Ok(targets) => targets.clone(),
            Err(_) => return,
        };
        for (key, target) in targets {
            let text = resolve(key, Some(&labels));
            let _ = match &target {
                MenuItemKind::MenuItem(item) => item.set_text(&text),
                MenuItemKind::Submenu(item) => item.set_text(&text),
                MenuItemKind::Predefined(item) => item.set_text(&text),
                MenuItemKind::Check(item) => item.set_text(&text),
                MenuItemKind::Icon(item) => item.set_text(&text),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{label, resolve, validate};
    use std::collections::BTreeMap;

    fn labels(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries.iter().map(|(key, text)| (key.to_string(), text.to_string())).collect()
    }

    #[test]
    fn reported_labels_replace_english_defaults_key_by_key() {
        let french = labels(&[("undo", "Annuler"), ("about", "À propos de CodeNomad")]);
        assert_eq!(resolve("undo", Some(&french)), "Annuler");
        assert_eq!(resolve("copy", Some(&french)), "Copy");
        assert_eq!(resolve("undo", None), "Undo");
        assert_eq!(label("unknown"), "");
    }

    #[test]
    fn invalid_known_labels_are_rejected_and_unknown_keys_ignored() {
        assert!(validate(&labels(&[("undo", "Annuler"), ("future", "")])).is_ok());
        assert!(validate(&labels(&[("undo", "  ")])).is_err());
        assert!(validate(&labels(&[("undo", &"x".repeat(201))])).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_literal_ampersand_is_not_a_mnemonic() {
        assert_eq!(resolve("copy", Some(&labels(&[("copy", "Copy & paste")]))), "Copy && paste");
    }
}
