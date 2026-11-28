use std::collections::{BTreeMap, BTreeSet};
mod cache;
pub(crate) mod memory_budget;
#[cfg(test)]
mod memory_budget_tests;
pub(crate) mod opening;
pub(crate) mod outlines;
mod persistence;
mod save_snapshot;
mod snapshot_budget;
mod state;
pub(crate) use memory_budget::enforce as enforce_memory_budget;
pub(crate) use persistence::finish;
pub(crate) use state::active_workspace;
pub(crate) use state::contains_project;
#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) use state::evict_for_probe;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use state::has_wake_lock_eligible_work;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use state::native_window_store;
#[cfg(target_arch = "wasm32")]
pub(crate) use state::poll_cached_notifications;
#[cfg(target_arch = "wasm32")]
pub(crate) use state::revoke_cached_sessions;
#[cfg(any(test, all(feature = "test-support", not(target_arch = "wasm32"))))]
pub(crate) use state::set_files_tab;
pub(crate) use state::{
    Activation, can_switch_for_notification, check_notification, notification_target,
    observes_notification, open_notification, open_session_tab_target, owns_notification,
    switch_tab_for_child, workspace_notification,
};
pub(crate) use state::{
    MAX_WINDOW_DEVICE_FILES, StashedTemporary, TemporaryTabInfo, Ui, active_project_title,
    active_session, active_temporary_workspace, attachment_draft_admissible,
    auto_cleanup_abort_for_project, auto_cleanup_abort_for_session,
    auto_cleanup_abort_if_protected, auto_cleanup_is_deleting_session, bound, bound_with_adopt,
    can_close_active, can_new, can_switch_tabs, capture, capture_files_mode,
    check_restored_draft_sessions, clear_temporary_mark, close, close_after_keep, close_ordinary,
    confirm_unconfirmed, connected, conversation_stream_clients, detach_dead_temporary,
    detach_stopped_temporary, draft_changed, file_draft_status, file_wrap, files_tab,
    finish_discarded, has_conversation_stream, has_temporary_tabs, has_unconfirmed, input_ready,
    new_tab, note_restored_draft_sessions_present, note_session_deleted, note_unconfirmed, opened,
    panel_width, poll, poll_file_drafts, prepare_open, reconcile_temporary_folders,
    recover_missing_session_draft, remove_cleaned_session, rename_tab, renew_connection,
    restore_files_mode, restore_stashed, resume, resume_restored_draft_checks, retry,
    schedule_blank_cleanup, schedule_catalogue, schedule_catalogue_refresh, select, select_index,
    select_relative, session_cleanup_protected, session_deleted_hook, stash_for_discard,
    stashed_has_in_memory_state, status, strip, tab_rename_seed, temporary_tab_info,
    toggle_file_wrap, unconfirmed_drafts_full, unselect_missing, unselect_session,
    window_inline_usage_without_history,
};
pub(crate) use state::{
    close_mission_reader, deliver_detached_events, detached_workspace_ids, event_workspace_id,
    has_detached_panels, has_unopened_detached_panels, mission_confirmation, mission_event,
    mission_has_reader, mission_observation_project, mission_panel, mission_reader,
    mission_supported, missions_composing, reconcile_detached_online, restore_mission_reader_focus,
    right_panel_tab, set_detached_online, set_right_panel_tab, stop_unlisted_detached,
    suspend_mission_briefing, suspend_missions,
};

use crate::composer::draft_storage::SavedParts;
use save_snapshot::encode_for_save;
use serde_json::{Map, Value, json};

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_TABS: usize = 32;
pub(crate) const MAX_TABS_LIMIT: usize = MAX_TABS;
pub(crate) const MAX_DRAFTS: usize = 24;
const MAX_DRAFT: usize = 32 * 1024;
const MAX_STRINGS: usize = 96 * 1024;
pub(super) const MAX_PROJECT_NAME: usize = 4096;
pub(crate) const MAX_PANEL_WIDTH: u16 = 16_384;
const PANEL_WIDTH_KEYS: [&str; 2] = [
    "opencode-session-sidebar-width-v8",
    "opencode-session-right-drawer-width-v1",
];
pub(crate) const FILE_WRAP_KEY: &str = "opencode-session-right-panel-files-word-wrap-v1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub revision: u64,
    pub saved_at: u64,
    pub panel_widths: [Option<u16>; 2],
    pub file_wrap: Option<bool>,
    pub tabs: Vec<Tab>,
    pub active: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tab {
    Blank,
    Workspace(Workspace),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub backend_id: Option<String>,
    pub server_id: Option<String>,
    pub folder: String,
    pub project_name: Option<String>,
    pub temporary: bool,
    pub occurrence: u64,
    pub workspace_id: Option<String>,
    pub active_session_id: Option<String>,
    pub drafts: BTreeMap<String, String>,
    pub(crate) attachment_drafts: BTreeSet<String>,
    pub(crate) attachment_parts: BTreeMap<String, SavedParts>,
    pub(crate) view: ViewState,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ViewState {
    right_panel: RightPanelTab,
    files_mode: Option<&'static str>,
    selected_mission: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RightPanelTab {
    Status,
    Files,
    Missions,
}

impl Default for RightPanelTab {
    fn default() -> Self {
        Self::Status
    }
}

impl RightPanelTab {
    fn key(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Files => "files",
            Self::Missions => "missions",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Malformed,
    Unsupported,
    Limit,
}

// Text-only v1 subset of stores/client-state-codec.ts and local-draft-ids.ts.
// An alpha-owned store rejects unsupported data instead of importing a partial Tauri state.
pub fn decode(bytes: &[u8]) -> Result<Snapshot, Error> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| Error::Malformed)?;
    let root = object(&value)?;
    fields(
        root,
        &["version", "revision", "savedAt", "layout", "session"],
    )?;
    if integer(root.get("version"))? != 1 {
        return Err(Error::Unsupported);
    }
    let layout = object(required(root, "layout")?)?;
    fields(
        layout,
        &[PANEL_WIDTH_KEYS[0], PANEL_WIDTH_KEYS[1], FILE_WRAP_KEY],
    )?;
    let file_wrap = match layout.get(FILE_WRAP_KEY).and_then(Value::as_str) {
        Some("on") => Some(true),
        Some("off") => Some(false),
        _ => None,
    };
    let mut panel_widths = [None; 2];
    for (side, key) in PANEL_WIDTH_KEYS.iter().enumerate() {
        if let Some(raw) = layout.get(*key) {
            let width = raw
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|width| {
                    width.is_finite() && (0.0..=f64::from(MAX_PANEL_WIDTH)).contains(width)
                })
                .ok_or(Error::Malformed)?;
            panel_widths[side] = Some(width.floor() as u16);
        }
    }
    let revision = integer(root.get("revision"))?;
    let saved_at = integer(root.get("savedAt"))?;
    let (tabs, active) = if root.get("session") == Some(&Value::Null) {
        (Vec::new(), None)
    } else {
        let session = object(required(root, "session")?)?;
        fields(session, &["tabs", "activeTabIndex"])?;
        let raw_tabs = required(session, "tabs")?
            .as_array()
            .ok_or(Error::Malformed)?;
        if raw_tabs.len() > MAX_TABS {
            return Err(Error::Limit);
        }
        let tabs = raw_tabs.iter().map(tab).collect::<Result<Vec<_>, _>>()?;
        let index = required(session, "activeTabIndex")?;
        let active = if index.as_f64() == Some(-1.0) {
            None
        } else {
            Some(usize::try_from(integer(Some(index))?).map_err(|_| Error::Limit)?)
        };
        (tabs, active)
    };
    let mut snapshot = Snapshot {
        revision,
        saved_at,
        panel_widths,
        file_wrap,
        tabs,
        active,
    };
    drop_excess_project_names(&mut snapshot)?;
    validate(&snapshot)?;
    Ok(snapshot)
}

pub fn encode(snapshot: &Snapshot) -> Result<Vec<u8>, Error> {
    validate(snapshot)?;
    let bytes = snapshot_bytes(snapshot)?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    Ok(bytes)
}

fn snapshot_bytes(snapshot: &Snapshot) -> Result<Vec<u8>, Error> {
    let tabs: Vec<Value> = snapshot
        .tabs
        .iter()
        .map(|tab| match tab {
            Tab::Blank => json!({"kind": "blank"}),
            Tab::Workspace(workspace) => {
                let mut value = json!({
                    "kind": "workspace", "folder": workspace.folder,
                    "occurrence": workspace.occurrence, "drafts": workspace.drafts,
                    "attachments": {}, "scrollSnapshots": {}, "unseenIdleSince": {},
                    "generationRecovery": {},
                });
                for (key, entry) in [
                    ("backendId", &workspace.backend_id),
                    ("serverId", &workspace.server_id),
                    ("projectName", &workspace.project_name),
                    ("workspaceId", &workspace.workspace_id),
                    ("activeSessionId", &workspace.active_session_id),
                ] {
                    if let Some(entry) = entry {
                        value[key] = Value::String(entry.clone());
                    }
                }
                if workspace.temporary {
                    value["temporary"] = Value::Bool(true);
                }
                if !workspace.attachment_drafts.is_empty() {
                    value["attachmentDrafts"] = json!(workspace.attachment_drafts);
                }
                if !workspace.attachment_parts.is_empty() {
                    value["attachmentParts"] = Value::Object(
                        workspace
                            .attachment_parts
                            .iter()
                            .map(|(id, parts)| (id.clone(), parts.encode()))
                            .collect(),
                    );
                }
                if workspace.view != ViewState::default() {
                    value["viewState"] = json!({
                        "version": 1,
                        "rightPanelTab": workspace.view.right_panel.key(),
                        "filesMode": workspace.view.files_mode.unwrap_or("workspace"),
                    });
                    if let Some(id) = &workspace.view.selected_mission {
                        value["viewState"]["missions"] = json!({ "selected": id });
                    }
                }
                value
            }
        })
        .collect();
    let active = snapshot.active.map(|index| index as i64).unwrap_or(-1);
    let mut layout: Map<_, _> = PANEL_WIDTH_KEYS
        .into_iter()
        .zip(snapshot.panel_widths)
        .filter_map(|(key, width)| Some((key.into(), json!(width?.to_string()))))
        .collect();
    if let Some(wrap) = snapshot.file_wrap {
        layout.insert(FILE_WRAP_KEY.into(), json!(if wrap { "on" } else { "off" }));
    }
    let value = json!({"version": 1, "revision": snapshot.revision, "savedAt": snapshot.saved_at,
        "layout": layout, "session": {"tabs": tabs, "activeTabIndex": active}});
    serde_json::to_vec(&value).map_err(|_| Error::Malformed)
}

fn tab(value: &Value) -> Result<Tab, Error> {
    let value = object(value)?;
    match required(value, "kind")?.as_str() {
        Some("blank") => {
            fields(value, &["kind"])?;
            Ok(Tab::Blank)
        }
        Some("workspace") => {
            fields(
                value,
                &[
                    "kind",
                    "backendId",
                    "serverId",
                    "folder",
                    "projectName",
                    "temporary",
                    "occurrence",
                    "workspaceId",
                    "activeSessionId",
                    "drafts",
                    "attachments",
                    "attachmentDrafts",
                    "attachmentParts",
                    "scrollSnapshots",
                    "unseenIdleSince",
                    "generationRecovery",
                    "seenInterruptions",
                    "expandedSessionIds",
                    "outlineIndexes",
                    "sessionCatalog",
                    "viewState",
                ],
            )?;
            for key in [
                "attachments",
                "scrollSnapshots",
                "unseenIdleSince",
                "generationRecovery",
                "seenInterruptions",
                "outlineIndexes",
            ] {
                if value.contains_key(key) {
                    empty_map(value.get(key))?;
                }
            }
            for key in ["expandedSessionIds", "sessionCatalog"] {
                if let Some(entry) = value.get(key) {
                    if !entry.as_array().ok_or(Error::Malformed)?.is_empty() {
                        return Err(Error::Unsupported);
                    }
                }
            }
            let raw_drafts = object(required(value, "drafts")?)?;
            if raw_drafts.len() > MAX_DRAFTS {
                return Err(Error::Limit);
            }
            let drafts = raw_drafts
                .iter()
                .map(|(key, entry)| {
                    Ok((
                        key.clone(),
                        entry.as_str().ok_or(Error::Malformed)?.to_owned(),
                    ))
                })
                .collect::<Result<_, Error>>()?;
            let attachment_drafts = match value.get("attachmentDrafts") {
                None => BTreeSet::new(),
                Some(ids) => {
                    let ids = ids.as_array().ok_or(Error::Malformed)?;
                    if ids.len() > MAX_DRAFTS {
                        return Err(Error::Limit);
                    }
                    ids.iter()
                        .map(|id| id.as_str().map(str::to_owned).ok_or(Error::Malformed))
                        .collect::<Result<_, _>>()?
                }
            };
            Ok(Tab::Workspace(Workspace {
                backend_id: optional_string(value, "backendId")?,
                server_id: optional_string(value, "serverId")?,
                folder: required(value, "folder")?
                    .as_str()
                    .ok_or(Error::Malformed)?
                    .to_owned(),
                project_name: decode_project_name(value.get("projectName")),
                temporary: value
                    .get("temporary")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                occurrence: value
                    .get("occurrence")
                    .map(|v| integer(Some(v)))
                    .transpose()?
                    .unwrap_or(0),
                workspace_id: optional_string(value, "workspaceId")?,
                active_session_id: optional_string(value, "activeSessionId")?,
                drafts,
                attachment_drafts,
                attachment_parts: if let Some(parts) = value.get("attachmentParts") {
                    object(parts)?
                        .iter()
                        .map(|(id, raw)| {
                            Ok((id.clone(), SavedParts::decode(raw).ok_or(Error::Malformed)?))
                        })
                        .collect::<Result<_, Error>>()?
                } else {
                    BTreeMap::new()
                },
                view: view_state(value.get("viewState"))?,
            }))
        }
        Some(_) => Err(Error::Unsupported),
        None => Err(Error::Malformed),
    }
}

fn view_state(value: Option<&Value>) -> Result<ViewState, Error> {
    let Some(value) = value else {
        return Ok(ViewState::default());
    };
    let value = object(value)?;
    if value.is_empty() {
        return Ok(ViewState::default());
    }
    fields(
        value,
        &["version", "rightPanelTab", "filesMode", "missions"],
    )?;
    if integer(value.get("version"))? != 1 {
        return Err(Error::Unsupported);
    }
    let right_panel = match value.get("rightPanelTab").map(|key| key.as_str()) {
        None | Some(Some("status")) => RightPanelTab::Status,
        Some(Some("files")) => RightPanelTab::Files,
        Some(Some("missions")) => RightPanelTab::Missions,
        _ => return Err(Error::Unsupported),
    };
    let files_mode = match value.get("filesMode") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            crate::git::Mode::restore(value.as_str().ok_or(Error::Malformed)?)
                .ok_or(Error::Unsupported)?
                .key(),
        ),
    };
    let selected_mission = match value.get("missions") {
        None => None,
        Some(missions) => {
            let missions = object(missions)?;
            fields(missions, &["selected"])?;
            match missions.get("selected") {
                None => None,
                Some(Value::String(id)) if !id.is_empty() && id.encode_utf16().count() <= 240 => {
                    Some(id.clone())
                }
                Some(_) => return Err(Error::Malformed),
            }
        }
    };
    Ok(ViewState {
        right_panel,
        files_mode: files_mode.or((right_panel == RightPanelTab::Files).then_some("workspace")),
        selected_mission,
    })
}

pub(super) fn valid_project_name(name: &str) -> bool {
    !name.is_empty()
        && name == name.trim()
        && !name.chars().any(char::is_control)
        && name.encode_utf16().nth(MAX_PROJECT_NAME).is_none()
}

pub(super) fn normalize_project_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    valid_project_name(trimmed).then(|| trimmed.to_owned())
}

fn decode_project_name(value: Option<&Value>) -> Option<String> {
    value?.as_str().and_then(normalize_project_name)
}

pub(super) fn project_name_drop_order(snapshot: &Snapshot) -> Vec<usize> {
    let tab_count = snapshot.tabs.len();
    let active = snapshot.active;
    (0..tab_count)
        .filter(|&index| Some(index) != active)
        .chain(active.into_iter().filter(|&index| index < tab_count))
        .collect()
}

pub(super) fn drop_excess_project_names(snapshot: &mut Snapshot) -> Result<(), Error> {
    if snapshot_string_units(snapshot)? <= MAX_STRINGS {
        return Ok(());
    }
    for index in project_name_drop_order(snapshot) {
        let changed = match &mut snapshot.tabs[index] {
            Tab::Workspace(saved) => saved.project_name.take().is_some(),
            Tab::Blank => false,
        };
        if changed && snapshot_string_units(snapshot)? <= MAX_STRINGS {
            break;
        }
    }
    Ok(())
}

fn validate(snapshot: &Snapshot) -> Result<(), Error> {
    if snapshot_string_units(snapshot)? > MAX_STRINGS {
        return Err(Error::Limit);
    }
    Ok(())
}

fn snapshot_string_units(snapshot: &Snapshot) -> Result<usize, Error> {
    if snapshot.revision > MAX_SAFE
        || snapshot.saved_at > MAX_SAFE
        || snapshot.tabs.len() > MAX_TABS
    {
        return Err(Error::Limit);
    }
    if snapshot
        .panel_widths
        .iter()
        .zip(rune_theme_codenomad::shell::PANEL_MIN)
        .any(|(width, min)| {
            width.is_some_and(|width| f32::from(width) < min || width > MAX_PANEL_WIDTH)
        })
    {
        return Err(Error::Limit);
    }
    match snapshot.active {
        None if snapshot.tabs.is_empty() => {}
        Some(index) if index < snapshot.tabs.len() => {}
        _ => return Err(Error::Malformed),
    }
    let mut remaining = usize::MAX;
    for tab in &snapshot.tabs {
        let Tab::Workspace(workspace) = tab else {
            continue;
        };
        if workspace.occurrence >= MAX_TABS as u64
            || workspace.drafts.len() > MAX_DRAFTS
            || workspace.attachment_drafts.len() > MAX_DRAFTS
        {
            return Err(Error::Limit);
        }
        take(&workspace.folder, 4096, false, &mut remaining)?;
        if !codenomad_client::absolute_server_path(&workspace.folder) {
            return Err(Error::Malformed);
        }
        if let Some(name) = &workspace.project_name {
            take(name, MAX_PROJECT_NAME, false, &mut remaining)?;
            if !valid_project_name(name) {
                return Err(Error::Malformed);
            }
        }
        if let Some(id) = &workspace.backend_id {
            take(id, 64, false, &mut remaining)?;
            if id == "local" || !safe_key(id) || !id.bytes().all(id_character) {
                return Err(Error::Malformed);
            }
        } else if workspace.server_id.is_some() {
            return Err(Error::Malformed);
        }
        for id in [
            &workspace.server_id,
            &workspace.workspace_id,
            &workspace.active_session_id,
        ]
        .into_iter()
        .flatten()
        {
            take(id, 512, false, &mut remaining)?;
            if !safe_key(id) {
                return Err(Error::Malformed);
            }
        }
        for (id, text) in &workspace.drafts {
            take(id, 256, false, &mut remaining)?;
            if !draft_id(id) {
                return Err(Error::Malformed);
            }
            take(text, MAX_DRAFT, true, &mut remaining)?;
        }
        for id in &workspace.attachment_drafts {
            take(id, 256, false, &mut remaining)?;
            if !draft_id(id) {
                return Err(Error::Malformed);
            }
        }
        if workspace
            .attachment_parts
            .iter()
            .any(|(id, parts)| !workspace.attachment_drafts.contains(id) || !parts.valid())
        {
            return Err(Error::Malformed);
        }
    }
    Ok(usize::MAX - remaining)
}

fn take(value: &str, max: usize, empty: bool, remaining: &mut usize) -> Result<(), Error> {
    let len = value.encode_utf16().count();
    if len > max || len > *remaining {
        return Err(Error::Limit);
    }
    if !empty && value.trim().is_empty() {
        return Err(Error::Malformed);
    }
    *remaining -= len;
    Ok(())
}

fn safe_key(value: &str) -> bool {
    !matches!(value, "__proto__" | "constructor" | "prototype")
}
fn id_character(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}
pub(crate) const NO_SESSION_DRAFT_ID: &str = "__no_session_draft__";
pub(crate) const RECOVERED_DRAFT_PREFIX: &str = "__recovered_draft__";

/// Read-compatibility predicate matching Solid's `isRecoveredDraftId` (`local-draft-ids.ts`).
pub(crate) fn is_recovered_draft_id(value: &str) -> bool {
    value
        .strip_prefix(RECOVERED_DRAFT_PREFIX)
        .is_some_and(|tail| {
            tail.len() == 36
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        })
}

/// Strict lowercase `8-4-4-4-12` UUID check used when generating new recovered draft IDs.
pub(crate) fn is_uuid_recovered_draft_id(value: &str) -> bool {
    value
        .strip_prefix(RECOVERED_DRAFT_PREFIX)
        .is_some_and(|tail| {
            tail.len() == 36
                && tail.bytes().enumerate().all(|(idx, b)| {
                    if matches!(idx, 8 | 13 | 18 | 23) {
                        b == b'-'
                    } else {
                        b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                    }
                })
        })
}

pub(crate) fn is_local_draft_id(value: &str) -> bool {
    value == NO_SESSION_DRAFT_ID || is_recovered_draft_id(value)
}

fn draft_id(value: &str) -> bool {
    if !safe_key(value) {
        return false;
    }
    if value == NO_SESSION_DRAFT_ID {
        return true;
    }
    if value.starts_with(RECOVERED_DRAFT_PREFIX) {
        return is_recovered_draft_id(value);
    }
    !value.is_empty() && value.len() <= 256 && value.bytes().all(id_character)
}
fn object(value: &Value) -> Result<&Map<String, Value>, Error> {
    value.as_object().ok_or(Error::Malformed)
}
fn required<'a>(value: &'a Map<String, Value>, key: &str) -> Result<&'a Value, Error> {
    value.get(key).ok_or(Error::Malformed)
}
fn optional_string(value: &Map<String, Value>, key: &str) -> Result<Option<String>, Error> {
    value
        .get(key)
        .map(|v| v.as_str().map(str::to_owned).ok_or(Error::Malformed))
        .transpose()
}
fn fields(value: &Map<String, Value>, allowed: &[&str]) -> Result<(), Error> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(Error::Unsupported);
    }
    Ok(())
}
fn empty_map(value: Option<&Value>) -> Result<(), Error> {
    if !object(value.ok_or(Error::Malformed)?)?.is_empty() {
        return Err(Error::Unsupported);
    }
    Ok(())
}
fn integer(value: Option<&Value>) -> Result<u64, Error> {
    let value = value.and_then(Value::as_f64).ok_or(Error::Malformed)?;
    if value < 0.0 || value.fract() != 0.0 {
        return Err(Error::Malformed);
    }
    if value > MAX_SAFE as f64 {
        return Err(Error::Limit);
    }
    Ok(value as u64)
}

#[cfg(test)]
mod tests;
