use super::{State, Tab, Ui};
use crate::{missions, workspace::RightPanelTab};
use codenomad_client::transport::WorkspaceEvent;
use rune::{El, edit::TextEdit};

pub fn file_wrap(s: &State) -> bool {
    s.shell.file_wrap
}

pub fn toggle_file_wrap(s: &mut State) {
    s.shell.file_wrap = !s.shell.file_wrap;
    #[cfg(target_arch = "wasm32")]
    crate::platform::storage::set_browser_file_wrap(s.shell.file_wrap);
    if let Some(ui) = &mut s.workspace {
        ui.file_wrap = Some(s.shell.file_wrap);
        ui.changed();
    }
}

pub fn panel_width(s: &mut State, index: usize, width: u16) {
    if let Some(ui) = &mut s.workspace
        && ui.panel_widths[index] != Some(width)
    {
        ui.panel_widths[index] = Some(width);
        ui.changed();
    }
}

fn view_state(ui: &Ui) -> Option<&super::super::ViewState> {
    match &ui.entries[ui.active].saved {
        Tab::Workspace(saved) => Some(&saved.view),
        Tab::Blank => None,
    }
}

pub fn files_tab(s: &State) -> bool {
    right_panel_tab(s) == RightPanelTab::Files
}

#[cfg(any(test, all(feature = "test-support", not(target_arch = "wasm32"))))]
pub fn set_files_tab(s: &mut State, files: bool) {
    set_right_panel_tab(
        s,
        if files {
            RightPanelTab::Files
        } else {
            RightPanelTab::Status
        },
    );
}

pub(crate) fn right_panel_tab(s: &State) -> RightPanelTab {
    let saved = s
        .workspace
        .as_ref()
        .and_then(view_state)
        .map(|view| view.right_panel)
        .unwrap_or_default();
    if saved == RightPanelTab::Missions && !mission_supported(s) {
        RightPanelTab::Status
    } else {
        saved
    }
}

pub(crate) fn set_right_panel_tab(s: &mut State, tab: RightPanelTab) {
    let Some(ui) = &mut s.workspace else { return };
    if let Tab::Workspace(saved) = &mut ui.entries[ui.active].saved
        && saved.view.right_panel != tab
    {
        saved.view.right_panel = tab;
        if tab == RightPanelTab::Files {
            saved.view.files_mode.get_or_insert("workspace");
        }
        ui.changed();
    }
}

pub(crate) fn mission_supported(s: &State) -> bool {
    mission_owner(s).is_some_and(missions::Panel::supported)
}

pub(crate) fn missions_composing(s: &State) -> bool {
    mission_owner(s).is_some_and(missions::Panel::is_composing)
}

pub(crate) fn mission_panel(s: &State) -> El {
    mission_owner(s).map_or_else(rune::el, |panel| missions::panel(panel, mission_edit))
}

fn mission_owner(s: &State) -> Option<&missions::Panel> {
    let ui = s.workspace.as_ref()?;
    ui.entries[ui.active].missions.as_ref()
}

fn mission_edit(s: &mut State) -> (Option<&mut missions::Panel>, &mut TextEdit) {
    let visible =
        crate::shell::right_panel_visible(s) && right_panel_tab(s) == RightPanelTab::Missions;
    let panel = s.workspace.as_mut().and_then(|ui| {
        visible
            .then(|| &mut ui.entries[ui.active])
            .and_then(|entry| entry.missions.as_mut())
    });
    (panel, &mut s.rejected_edit)
}

pub(super) fn poll_missions(ui: &mut Ui, s: &State, tx: &mut rune::Tx) -> bool {
    let mut changed = false;
    let mut selection_changed = false;
    let mounted = crate::shell::right_panel_visible(s);
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        if index != ui.active {
            if let Some(panel) = &mut entry.missions {
                panel.show(false);
                panel.cancel_probe();
            }
            continue;
        }
        let target =
            entry
                .binding
                .as_ref()
                .zip(entry.project.as_ref())
                .and_then(|(backend, project)| {
                    let mut backend = backend.clone();
                    backend.workspace.clone_from(&project.id);
                    (!backend.workspace.is_empty()).then_some(backend)
                });
        let Some(backend) = target else {
            changed |= entry.missions.take().is_some();
            continue;
        };
        let Tab::Workspace(saved) = &mut entry.saved else {
            continue;
        };
        if entry
            .missions
            .as_ref()
            .is_none_or(|panel| !panel.matches(&backend))
        {
            let mut panel = missions::Panel::new(backend, None, s.reads.clone(), s.wake.clone());
            panel.selected.clone_from(&saved.view.selected_mission);
            entry.missions = Some(panel);
            changed = true;
        }
        if let Some(panel) = &mut entry.missions {
            let visible = mounted && saved.view.right_panel == RightPanelTab::Missions;
            if !visible {
                panel.show(false);
            }
            if mounted {
                panel.probe();
            } else {
                panel.cancel_probe();
            }
            if visible {
                panel.refresh_when_due(ui.clock, tx);
            }
            changed |= panel.poll();
            panel.show(panel.supported() && visible);
            if saved.view.selected_mission != panel.selected {
                saved.view.selected_mission.clone_from(&panel.selected);
                selection_changed = true;
            }
        }
    }
    if selection_changed {
        ui.changed();
    }
    changed
}

pub(crate) fn suspend_missions(s: &mut State) {
    if let Some(ui) = &mut s.workspace
        && let Some(panel) = &mut ui.entries[ui.active].missions
    {
        panel.show(false);
        panel.cancel_probe();
    }
}

pub(crate) fn mission_event(s: &mut State, event: Option<&WorkspaceEvent>) {
    // No observer may grant demand; the real mounted occurrence owns it.
    if !crate::shell::right_panel_visible(s) || right_panel_tab(s) != RightPanelTab::Missions {
        return;
    }
    let Some(ui) = &mut s.workspace else { return };
    let entry = &mut ui.entries[ui.active];
    let Some((panel, project)) = entry.missions.as_mut().zip(entry.project.as_ref()) else {
        return;
    };
    match event {
        Some(WorkspaceEvent::MissionChanged {
            workspace_id,
            mission_id,
            revision,
        }) if workspace_id == &project.id => {
            panel.invalidate(Some((mission_id, *revision)), ui.clock);
        }
        Some(WorkspaceEvent::MissionsReconnected { workspace_id })
            if workspace_id == &project.id =>
        {
            panel.invalidate(None, ui.clock);
        }
        Some(
            WorkspaceEvent::MissionActivityChanged { workspace_id }
            | WorkspaceEvent::SessionMoved { workspace_id, .. },
        ) if workspace_id == &project.id => {
            panel.activity_changed(ui.clock);
        }
        None => panel.invalidate(None, ui.clock),
        _ => {}
    }
}

pub(crate) fn deliver_detached_events(s: &mut State, events: &[WorkspaceEvent]) -> bool {
    if events.is_empty() {
        return false;
    }
    let mut delivered = false;
    let active_detached = s
        .incoming
        .as_ref()
        .is_none_or(codenomad_client::Receiver::is_closed);
    if active_detached {
        for event in events {
            crate::git::event(s, event);
            if let Some(files) = &mut s.files {
                files.event(event.clone());
            }
            delivered = true;
        }
    }
    if let Some(ui) = &mut s.workspace {
        for (index, entry) in ui.entries.iter_mut().enumerate() {
            if index == ui.active {
                continue;
            }
            let Some(cache) = entry.cache.as_mut() else {
                continue;
            };
            for event in events {
                delivered |= cache.deliver_detached_event(event);
            }
        }
    }
    delivered
}

pub fn restore_files_mode(s: &mut State) {
    if let Some(mode) = s
        .workspace
        .as_ref()
        .and_then(view_state)
        .and_then(|view| view.files_mode)
        .and_then(crate::git::Mode::restore)
    {
        crate::git::set_mode(s, mode);
    }
}

pub fn capture_files_mode(s: &mut State) {
    if s.git.owner.is_none() {
        return;
    }
    let mode = crate::git::mode(s);
    let Some(ui) = &mut s.workspace else { return };
    if let Tab::Workspace(saved) = &mut ui.entries[ui.active].saved
        && (saved.view.files_mode.is_some() || mode != crate::git::Mode::Workspace)
        && saved.view.files_mode != Some(mode.key())
    {
        saved.view.files_mode = Some(mode.key());
        ui.changed();
    }
}
