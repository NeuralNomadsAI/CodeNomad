use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Submenu},
    AppHandle, Wry,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(crate) struct ItemState {
    label: String,
    checked: bool,
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewMenuState {
    left_panel: ItemState,
    right_panel: ItemState,
    timeline: ItemState,
    timeline_tools: ItemState,
}

const IDS: [&str; 4] = [
    "view-left-panel",
    "view-right-panel",
    "view-timeline",
    "view-timeline-tools",
];

impl ViewMenuState {
    fn items(&self) -> [&ItemState; 4] {
        [
            &self.left_panel,
            &self.right_panel,
            &self.timeline,
            &self.timeline_tools,
        ]
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.items().iter().any(|item| item.label.len() > 200) {
            return Err("Invalid view menu label".into());
        }
        Ok(())
    }
}

pub(crate) fn append(app: &AppHandle, menu: &Submenu<Wry>) -> tauri::Result<()> {
    for (index, id) in IDS.iter().enumerate() {
        if index == 2 {
            menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
        }
        menu.append(&CheckMenuItem::with_id(
            app,
            *id,
            "",
            false,
            false,
            None::<&str>,
        )?)?;
    }
    menu.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
    Ok(())
}

pub(crate) fn update(app: &AppHandle, state: Option<&ViewMenuState>) {
    let Some(menu) = app.menu() else { return };
    let Some(view) = menu.get("menu-view") else {
        return;
    };
    let Some(view) = view.as_submenu() else {
        return;
    };
    for (index, id) in IDS.iter().enumerate() {
        let Some(item) = view.get(*id) else { continue };
        let Some(item) = item.as_check_menuitem() else {
            continue;
        };
        let value = state.map(|state| state.items()[index]);
        if let Some(value) = value {
            let _ = item.set_text(&value.label);
        }
        let _ = item.set_checked(value.is_some_and(|value| value.checked));
        let _ = item.set_enabled(value.is_some_and(|value| value.enabled));
    }
}
