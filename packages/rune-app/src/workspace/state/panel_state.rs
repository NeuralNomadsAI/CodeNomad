use super::{State, Tab, Ui};
use crate::{missions, workspace::RightPanelTab};
use codenomad_client::transport::WorkspaceEvent;
use rune::{El, edit::TextEdit};
use rune_theme_codenomad::layout::Layout;

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
    let Some(ui) = s.workspace.as_ref() else {
        return rune::el();
    };
    let entry = &ui.entries[ui.active];
    entry.missions.as_ref().map_or_else(rune::el, |panel| {
        let actions = rune::col()
            .full_width()
            .child(missions::controls(
                panel,
                &ui.mission_lifecycle,
                &entry.key,
                control,
            ))
            .child(missions::briefing_controls(
                panel,
                &ui.mission_briefing,
                &entry.key,
                briefing_act,
                open_mission_conversation,
            ));
        missions::panel_body(
            panel,
            &ui.mission_editor,
            &ui.mission_schedules,
            mission_edit,
            actions,
            Some(std::rc::Rc::new(open_mission_conversation)),
            on_mission_reader_open,
            mission_editor_act,
            mission_schedule_act,
        )
    })
}

fn pairing_required(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        crate::platform::pairing::required(s)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = s;
        false
    }
}

fn pairing_checking(s: &State) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        crate::platform::pairing::checking(s)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = s;
        false
    }
}

fn authentication_required(s: &State) -> bool {
    s.screen
        .launcher()
        .is_some_and(|l| l.authentication_required)
}

pub(super) fn mission_context_blocked(s: &State) -> bool {
    crate::shell::launcher_replaces_project(s) || authentication_required(s) || pairing_required(s)
}

pub(crate) fn mission_has_reader(s: &State) -> bool {
    !mission_context_blocked(s) && mission_owner(s).is_some_and(missions::Panel::has_surface)
}

pub(crate) fn mission_has_editor(s: &State) -> bool {
    !mission_context_blocked(s) && mission_owner(s).is_some_and(missions::Panel::has_editor)
}

pub(crate) fn active_mission_editor_has_unsaved_draft(s: &State) -> bool {
    let Some(ui) = s.workspace.as_ref() else {
        return false;
    };
    ui.entries[ui.active]
        .missions
        .as_ref()
        .is_some_and(|panel| panel.has_unsaved_editor_draft(&ui.mission_editor))
}

pub(crate) fn discard_active_mission_draft(s: &mut State, tx: &mut rune::Tx) {
    if let Some(ui) = &mut s.workspace
        && let Some(panel) = &mut ui.entries[ui.active].missions
        && panel.discard_unsaved_editor_draft(&mut ui.mission_editor)
    {
        tx.instant();
    }
}

pub(crate) fn close_mission_reader(s: &mut State) -> Option<String> {
    if let Some(ui) = &mut s.workspace {
        let entry = &mut ui.entries[ui.active];
        ui.mission_editor
            .revoke_auto_start_for_occurrence(&entry.key);
        if let Some(panel) = &mut entry.missions {
            return panel.close_reader_preserving_dirty_editor(&ui.mission_editor);
        }
    }
    None
}

pub(crate) fn request_close_mission_reader(
    s: &mut State,
    from_escape: bool,
    tx: &mut rune::Tx,
) -> Option<Option<String>> {
    let outcome = {
        let ui = s.workspace.as_mut()?;
        let entry = &mut ui.entries[ui.active];
        let panel = entry.missions.as_mut()?;
        let outcome = panel.request_close_surface(&ui.mission_editor, from_escape);
        if matches!(outcome, missions::CloseSurface::Closed(_)) {
            ui.mission_editor
                .revoke_auto_start_for_occurrence(&entry.key);
        }
        outcome
    };
    match outcome {
        missions::CloseSurface::Closed(back) => Some(back),
        missions::CloseSurface::PromptedDiscard => {
            tx.focus("mission-editor-discard-cancel", tx.focus_visible());
            tx.instant();
            None
        }
        missions::CloseSurface::CancelledPrompt => {
            tx.instant();
            None
        }
    }
}

pub(crate) fn restore_mission_reader_focus(s: &State, back: Option<String>, tx: &mut rune::Tx) {
    let visible =
        crate::shell::right_panel_visible(s) && right_panel_tab(s) == RightPanelTab::Missions;
    let mounted = visible
        && back.as_deref().is_some_and(|key| {
            key == "missions-create"
                || mission_owner(s).is_some_and(|panel| {
                    (key == "mission-edit" && panel.selected.is_some())
                        || (key == "mission-edit-reconcile"
                            && s.workspace.as_ref().is_some_and(|ui| {
                                panel.selected_edit_hold(&ui.mission_editor).is_some()
                            }))
                        || panel.has_eye_trigger(key)
                })
        });
    let target = if mounted {
        back.unwrap_or_else(|| "right-panel-toggle".into())
    } else {
        "right-panel-toggle".into()
    };
    if let Some(task_id) = target.strip_prefix("mission-task-eye-") {
        tx.scroll_into_view(format!("mission-task-{task_id}"));
        tx.focus_when_shown(target, tx.focus_visible());
    } else {
        tx.focus(target, tx.focus_visible());
    }
}

pub(crate) fn mission_reader(s: &State) -> El {
    if !mission_has_reader(s) {
        return rune::el();
    }
    let Some(ui) = s.workspace.as_ref() else {
        return rune::el();
    };
    let Some(panel) = ui.entries[ui.active].missions.as_ref() else {
        return rune::el();
    };
    let close = |s: &mut State, tx: &mut rune::Tx| {
        if let Some(back) = request_close_mission_reader(s, false, tx) {
            if s.screen.is_launcher() {
                tx.instant();
            } else {
                crate::chat::reading::restore_position(s, tx);
            }
            restore_mission_reader_focus(s, back, tx);
        }
    };
    if panel.has_editor() {
        missions::editor_view(
            panel,
            &ui.mission_editor,
            mission_editor_edit,
            mission_editor_act,
            close,
        )
    } else {
        missions::reader_view(panel, mission_reader_owner, close)
    }
}

fn mission_editor_act(s: &mut State, gesture: missions::EditorGesture, tx: &mut rune::Tx) {
    if mission_context_blocked(s) {
        return;
    }
    if matches!(gesture, missions::EditorGesture::ConfirmDiscard) {
        let (tab_key, discarded) = s
            .workspace
            .as_mut()
            .map(|ui| {
                let entry = &mut ui.entries[ui.active];
                let key = entry.key.clone();
                let res = entry
                    .missions
                    .as_mut()
                    .and_then(|panel| panel.confirm_discard_editor(&mut ui.mission_editor));
                (key, res)
            })
            .unwrap_or_default();
        if let Some((intent, back)) = discarded {
            match intent {
                missions::LeaveIntent::Close => {
                    if !s.screen.is_launcher() {
                        crate::chat::reading::restore_position(s, tx);
                    }
                    restore_mission_reader_focus(s, back, tx);
                }
                missions::LeaveIntent::CloseTab => {
                    super::tabs::close_confirmed_uncertain_creation(s, &tab_key, tx);
                    return;
                }
                missions::LeaveIntent::SelectMission(_)
                | missions::LeaveIntent::SelectSchedule(_) => {}
                missions::LeaveIntent::OpenOverview(_)
                | missions::LeaveIntent::OpenTask(_, _, _) => {
                    on_mission_reader_open(s, tx);
                    tx.focus("mission-reader-close", tx.focus_visible());
                }
            }
        }
        tx.instant();
        return;
    }
    let prompting_close_tab = matches!(gesture, missions::EditorGesture::RequestCloseTab);
    let opening = matches!(
        gesture,
        missions::EditorGesture::OpenCreate { .. } | missions::EditorGesture::OpenEdit { .. }
    );
    let mut focus_target = None;
    let mut opened = false;
    if let Some(ui) = s.workspace.as_mut() {
        let entry = &mut ui.entries[ui.active];
        if let Some(panel) = entry.missions.as_mut() {
            opened = panel.editor_gesture(&entry.key, &mut ui.mission_editor, gesture);
            if opening && opened {
                ui.mission_schedules.confirmation = None;
                focus_target = panel.take_editor_initial_focus();
            }
        }
    }
    if prompting_close_tab && opened {
        tx.focus("mission-editor-discard-cancel", tx.focus_visible());
    }
    if opening && opened {
        on_mission_reader_open(s, tx);
        if let Some(target) = focus_target {
            tx.focus(target, tx.focus_visible());
        }
    }
    tx.instant();
}

fn mission_reader_owner(s: &mut State) -> Option<&mut missions::Panel> {
    if mission_context_blocked(s) {
        return None;
    }
    let ui = s.workspace.as_mut()?;
    ui.entries[ui.active].missions.as_mut()
}

fn mission_editor_edit(s: &mut State) -> (Option<&mut missions::Panel>, &mut TextEdit) {
    if mission_context_blocked(s) {
        return (None, &mut s.rejected_edit);
    }
    let panel = s
        .workspace
        .as_mut()
        .and_then(|ui| ui.entries[ui.active].missions.as_mut());
    (panel, &mut s.rejected_edit)
}

fn on_mission_reader_open(s: &mut State, tx: &mut rune::Tx) {
    s.notifications.supersede_navigation();
    let _ = s.shell.close_floating(tx);
    crate::git::close_preview(s);
    if let Some(files) = &mut s.files {
        files.close_reader();
    }
}

pub(crate) fn mission_confirmation(s: &State) -> Option<El> {
    if !crate::shell::right_panel_visible(s) || right_panel_tab(s) != RightPanelTab::Missions {
        return None;
    }
    let ui = s.workspace.as_ref()?;
    let entry = &ui.entries[ui.active];
    let panel = entry.missions.as_ref()?;
    if let Some((source, _)) = panel.control_source(&entry.key)
        && ui
            .mission_lifecycle
            .confirmation
            .as_ref()
            .is_some_and(|(key, _)| key == &source)
    {
        return missions::confirmation(&ui.mission_lifecycle, control);
    }
    if let Some((key, header)) = panel.briefing_source()
        && header.accepts_coordinator_message()
        && ui
            .mission_briefing
            .confirmation
            .as_ref()
            .is_some_and(|(occ, expected)| occ == &entry.key && expected == &key)
    {
        return missions::briefing_confirmation(&ui.mission_briefing, briefing_act);
    }
    if !mission_context_blocked(s)
        && let Some(selected_key) = panel.selected_schedule_hold_key()
        && ui.mission_schedules.confirmation.as_ref().is_some_and(|c| {
            c.occurrence == entry.key
                && c.key == selected_key
                && panel.schedule_confirmation_valid(&ui.mission_schedules, c)
        })
    {
        return missions::schedule_confirmation(&ui.mission_schedules, mission_schedule_act);
    }
    None
}

fn mission_schedule_act(s: &mut State, gesture: missions::ScheduleGesture, tx: &mut rune::Tx) {
    if mission_context_blocked(s)
        || !crate::shell::right_panel_visible(s)
        || right_panel_tab(s) != RightPanelTab::Missions
    {
        return;
    }
    if let missions::ScheduleGesture::OpenConversation(session_id) = gesture {
        open_mission_conversation(s, session_id, tx);
        return;
    }
    if let missions::ScheduleGesture::OpenConfigFile(id) = gesture {
        crate::settings::open_config_file(s, id);
        tx.instant();
        return;
    }
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let entry = &mut ui.entries[ui.active];
    if let Some(panel) = &mut entry.missions
        && panel.schedule_gesture(&entry.key, &mut ui.mission_schedules, gesture)
    {
        if ui.mission_schedules.confirmation.is_some() {
            ui.mission_lifecycle.confirmation = None;
            ui.mission_briefing.confirmation = None;
        }
        tx.instant();
    }
}

fn control(s: &mut State, source: &missions::Source, gesture: missions::Gesture) {
    if !crate::shell::right_panel_visible(s) || right_panel_tab(s) != RightPanelTab::Missions {
        return;
    }
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let entry = &mut ui.entries[ui.active];
    if let Some(panel) = &mut entry.missions {
        panel.control(&entry.key, &mut ui.mission_lifecycle, source, gesture);
        if ui.mission_lifecycle.confirmation.is_some() {
            ui.mission_briefing.confirmation = None;
            ui.mission_schedules.confirmation = None;
        }
    }
}

fn briefing_act(
    s: &mut State,
    occurrence: &str,
    key: &missions::BriefingKey,
    gesture: missions::BriefingGesture,
) {
    if !crate::shell::right_panel_visible(s) || right_panel_tab(s) != RightPanelTab::Missions {
        return;
    }
    let launcher_conn = s
        .screen
        .launcher()
        .filter(|l| !l.authentication_required)
        .and_then(|l| l.connection.clone());
    let locale = crate::settings::app_locale(s);
    let Some(ui) = &mut s.workspace else {
        return;
    };
    let entry = &ui.entries[ui.active];
    if entry.key != occurrence {
        return;
    }
    if let Some(binding) = &entry.binding
        && launcher_conn
            .as_ref()
            .is_some_and(|conn| !binding.client.same_connection(&conn.client))
    {
        return;
    }
    if let Some(panel) = &entry.missions {
        panel.briefing_act(occurrence, &mut ui.mission_briefing, key, locale, gesture);
        if ui.mission_briefing.confirmation.is_some() {
            ui.mission_lifecycle.confirmation = None;
            ui.mission_schedules.confirmation = None;
        }
    }
}

fn open_mission_conversation(s: &mut State, session_id: String, tx: &mut rune::Tx) {
    if !crate::shell::right_panel_visible(s)
        || right_panel_tab(s) != RightPanelTab::Missions
        || !codenomad_client::history::valid_id(&session_id)
    {
        return;
    }
    if s.files
        .as_ref()
        .is_some_and(|files| files.document.confirmation().is_some())
    {
        return;
    }
    let Some((binding, project_id, owned_target)) = s.workspace.as_ref().and_then(|ui| {
        let entry = &ui.entries[ui.active];
        let owned = entry.missions.as_ref().is_some_and(|panel| {
            panel.owns_conversation_target(&session_id)
                || panel.owns_schedule_conversation_target(&ui.mission_schedules, &session_id)
        });
        Some((
            entry.binding.as_ref()?,
            entry.project.as_ref()?.id.as_str(),
            owned,
        ))
    }) else {
        return;
    };
    if !owned_target {
        return;
    }
    let Some(launcher) = s.screen.launcher() else {
        return;
    };
    if launcher.authentication_required
        || launcher
            .connection
            .as_ref()
            .is_none_or(|conn| !binding.client.same_connection(&conn.client))
        || launcher
            .project
            .as_ref()
            .is_none_or(|project| project.id != project_id)
    {
        return;
    }
    let already_active = !s.screen.is_launcher()
        && crate::workspace::active_session(s) == Some(session_id.as_str())
        && s.phase != crate::Phase::Failed;
    let can_switch = !already_active
        && !launcher.pending
        && (crate::launcher::can_rebind_session(s, &session_id)
            || crate::launcher::can_open_child_session(s));
    if !already_active && !can_switch {
        return;
    }
    // Dismiss active previews/drawers immediately only when revealing the already-bound session;
    // switching sessions lets `bind_at` replace them once the target resolves.
    if already_active {
        crate::git::close_preview(s);
        if let Some(files) = &mut s.files {
            files.close_reader();
        }
        if close_mission_reader(s).is_some() {
            crate::chat::reading::restore_position(s, tx);
        }
        s.shell.close_floating(tx);
    }
    crate::launcher::choose_mission_conversation(s, session_id, tx);
    tx.instant();
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

pub(super) fn poll_missions(
    ui: &mut Ui,
    s: &State,
    tx: &mut rune::Tx,
) -> (bool, Vec<crate::backend::Backend>, bool) {
    #[cfg(target_arch = "wasm32")]
    {
        let epoch = crate::platform::pairing::auth_epoch(s);
        if ui.pairing_auth_epoch != epoch {
            ui.pairing_auth_epoch = epoch;
            for entry in &mut ui.entries {
                if let Some(panel) = entry.missions.as_mut() {
                    panel.schedules.revoke_continuation();
                }
            }
        }
    }
    let finished = ui.mission_lifecycle.poll();
    let mut changed = !finished.is_empty();
    let mut auth_expired = Vec::new();
    extend_unique_auth(&mut auth_expired, ui.mission_lifecycle.drain_auth_expired());
    let mut restore_chat_after_save = false;
    let mut selection_changed = false;
    let mounted = crate::shell::right_panel_visible(s);
    let blocked = mission_context_blocked(s);
    let editor_foreground = !crate::git::has_preview(s) && !crate::files::has_preview(s);
    let current = &ui.entries[ui.active];
    let current_source = (!blocked
        && mounted
        && matches!(&current.saved, Tab::Workspace(saved)
        if saved.view.right_panel == RightPanelTab::Missions))
    .then(|| {
        current
            .missions
            .as_ref()?
            .control_source(&current.key)
            .map(|(key, _)| key)
    })
    .flatten();
    ui.mission_lifecycle
        .retain_checks_for(current_source.as_ref());
    if ui
        .mission_lifecycle
        .confirmation
        .as_ref()
        .is_some_and(|(source, _)| current_source.as_ref() != Some(source))
    {
        ui.mission_lifecycle.confirmation = None;
        changed = true;
    }
    let mut active_visible = false;
    let mut active_polled = false;
    for (index, entry) in ui.entries.iter_mut().enumerate() {
        if index != ui.active {
            if let Some(panel) = &mut entry.missions {
                panel.suspend();
                ui.mission_editor
                    .revoke_auto_start_for_occurrence(&entry.key);
                extend_unique_auth(&mut auth_expired, panel.drain_auth_expired());
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
                    (!backend.workspace.is_empty()).then_some((backend, project.path.clone()))
                });
        let Some((backend, folder)) = target else {
            if let Some(mut old) = entry.missions.take() {
                old.suspend();
                extend_unique_auth(&mut auth_expired, old.drain_auth_expired());
                changed = true;
            }
            ui.mission_lifecycle.retain_checks_for(None);
            ui.mission_lifecycle.confirmation = None;
            ui.mission_editor
                .revoke_auto_start_for_occurrence(&entry.key);
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
            ui.mission_lifecycle.retain_checks_for(None);
            ui.mission_lifecycle.confirmation = None;
            if let Some(existing) = entry
                .missions
                .as_mut()
                .filter(|panel| panel.same_workspace(&backend))
            {
                existing.rebind(backend);
                existing.rebind_editor(&mut ui.mission_editor);
            } else {
                if let Some(mut old) = entry.missions.take() {
                    old.suspend();
                    extend_unique_auth(&mut auth_expired, old.drain_auth_expired());
                }
                let mut panel =
                    missions::Panel::new(backend, None, s.reads.clone(), s.wake.clone())
                        .with_owner_scope(folder)
                        .with_schedule_auth(ui.mission_schedules.auth_sink());
                panel.selected.clone_from(&saved.view.selected_mission);
                entry.missions = Some(panel);
            }
            changed = true;
        }
        if let Some(panel) = &mut entry.missions {
            if blocked {
                panel.suspend();
                ui.mission_editor
                    .revoke_auto_start_for_occurrence(&entry.key);
                extend_unique_auth(&mut auth_expired, panel.drain_auth_expired());
                continue;
            }
            let visible = mounted && saved.view.right_panel == RightPanelTab::Missions;
            active_visible = visible;
            active_polled = true;
            if !visible {
                panel.show(false);
            }
            if mounted {
                panel.probe();
            } else {
                panel.cancel_probe();
            }
            if visible || panel.has_surface() {
                panel.refresh_when_due(ui.clock, tx);
            }
            if !editor_foreground && panel.has_editor() {
                panel.invalidate_editor_generation();
                ui.mission_editor
                    .revoke_auto_start_for_occurrence(&entry.key);
            }
            if panel.take_editor_auto_start_revoked() {
                ui.mission_editor
                    .revoke_auto_start_for_occurrence(&entry.key);
            }
            changed |= panel.observe_editor_detail(&ui.mission_editor);
            changed |= panel.poll();
            changed |= panel.poll_schedules(&mut ui.mission_schedules);
            changed |= panel.observe_editor_detail(&ui.mission_editor);
            extend_unique_auth(&mut auth_expired, panel.drain_auth_expired());
        }
    }
    changed |= ui.mission_briefing.poll();
    extend_unique_auth(&mut auth_expired, ui.mission_briefing.take_auth_expired());

    let pairing_pending = pairing_checking(s);
    let (schedules_collected, ready_schedules) =
        ui.mission_schedules.collect_ready(&mut auth_expired);
    changed |= schedules_collected;

    let (editor_changed, editor_events) = {
        let active_entry = &ui.entries[ui.active];
        let active_ctx = (active_polled && editor_foreground)
            .then(|| {
                active_entry
                    .missions
                    .as_ref()?
                    .active_editor(&active_entry.key)
            })
            .flatten();
        ui.mission_editor
            .poll(active_ctx, &auth_expired, &mut ui.mission_lifecycle)
    };
    changed |= editor_changed;
    extend_unique_auth(&mut auth_expired, ui.mission_editor.drain_auth_expired());

    let (schedules_applied, schedule_events) = {
        let e = &ui.entries[ui.active];
        let v = (active_polled && active_visible && !pairing_pending)
            .then(|| e.missions.as_ref()?.active_schedule_view(&e.key))
            .flatten();
        ui.mission_schedules
            .apply_ready(ready_schedules, v.as_ref(), &auth_expired)
    };
    changed |= schedules_applied;
    extend_unique_auth(&mut auth_expired, ui.mission_schedules.drain_auth_expired());

    let any_auth_expired = !auth_expired.is_empty();
    let keep_confirm = ui.mission_schedules.confirmation.as_ref().is_some_and(|c| {
        !any_auth_expired
            && !blocked
            && mounted
            && matches!(&ui.entries[ui.active].saved, Tab::Workspace(s) if s.view.right_panel == RightPanelTab::Missions)
            && ui.entries[ui.active].key == c.occurrence
            && ui.entries[ui.active]
                .missions
                .as_ref()
                .is_some_and(|p| p.schedule_confirmation_valid(&ui.mission_schedules, c))
    });
    if ui.mission_schedules.confirmation.is_some() && !keep_confirm {
        ui.mission_schedules.confirmation = None;
        changed = true;
    }
    if active_polled {
        let entry = &mut ui.entries[ui.active];
        if let (Tab::Workspace(saved), Some(panel)) = (&mut entry.saved, &mut entry.missions) {
            if editor_foreground {
                changed |= panel.commit_editor_submit(&mut ui.mission_editor, &auth_expired);
            }
            changed |= panel.apply_editor_events(&entry.key, &editor_events);
            if panel.commit_schedule_pre(
                &mut ui.mission_schedules,
                active_visible && !blocked && !pairing_pending && panel.supported(),
                &auth_expired,
            ) {
                changed = true;
                if ui.mission_schedules.confirmation.is_some() {
                    ui.mission_lifecycle.confirmation = None;
                    ui.mission_briefing.confirmation = None;
                }
            }
            changed |= panel.apply_schedule_hold_events(&schedule_events);
            if let Some(text) = panel.take_reader_copy()
                && !any_auth_expired
                && panel.has_reader()
            {
                tx.copy(text);
            }
            if panel.take_reader_focus_close() && panel.has_reader() {
                tx.focus("mission-reader-close", tx.focus_visible());
            }
            if let Some(target) = panel.take_editor_initial_focus()
                && panel.has_editor()
            {
                tx.focus(target, tx.focus_visible());
            }
            if let Some(back) = panel.take_editor_saved_focus()
                && !panel.has_surface()
            {
                restore_chat_after_save = true;
                let target = if active_visible
                    && (back == "missions-create"
                        || (back == "mission-edit" && panel.selected.is_some()))
                {
                    back
                } else {
                    "right-panel-toggle".into()
                };
                tx.focus(target, tx.focus_visible());
            }
            if !any_auth_expired {
                panel.show(panel.supported() && active_visible);
                if panel.supported() && active_visible {
                    panel.settle_controls(&entry.key, &mut ui.mission_lifecycle, &finished);
                }
            }
            if saved.view.selected_mission != panel.selected {
                saved.view.selected_mission.clone_from(&panel.selected);
                selection_changed = true;
            }
        }
    }
    let active_entry = &ui.entries[ui.active];
    let active_briefing = (!blocked
        && auth_expired.is_empty()
        && mounted
        && matches!(&active_entry.saved, Tab::Workspace(saved)
            if saved.view.right_panel == RightPanelTab::Missions))
    .then(|| {
        let panel = active_entry.missions.as_ref().filter(|p| p.supported())?;
        let (key, header) = panel.briefing_source()?;
        Some((active_entry.key.as_str(), key, header, panel))
    })
    .flatten();
    changed |=
        ui.mission_briefing
            .reconcile(active_briefing.as_ref().map(|(occ, key, header, panel)| {
                missions::ActiveBriefing {
                    occurrence: occ,
                    key,
                    header,
                    backend: panel.briefing_backend(),
                    wake: panel.briefing_wake(),
                    failed: panel.detail_failed(),
                }
            }));
    if selection_changed {
        ui.changed();
    }
    (changed, auth_expired, restore_chat_after_save)
}

fn extend_unique_auth(
    target: &mut Vec<crate::backend::Backend>,
    incoming: impl IntoIterator<Item = crate::backend::Backend>,
) {
    for candidate in incoming {
        if !target
            .iter()
            .any(|known| known.client.same_connection(&candidate.client))
        {
            target.push(candidate);
        }
    }
}

pub(super) fn deliver_mission_auth_expired(
    s: &mut State,
    expired: Vec<crate::backend::Backend>,
) -> bool {
    if expired.is_empty() {
        return false;
    }
    if let Some(ui) = &mut s.workspace {
        for entry in &mut ui.entries {
            if let Some(panel) = entry.missions.as_mut()
                && expired
                    .iter()
                    .any(|b| panel.briefing_backend().client.same_connection(&b.client))
            {
                panel.schedules.revoke_continuation();
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut changed = false;
        for backend in expired {
            changed |= crate::settings::authentication_required(s, &backend);
        }
        changed
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = expired;
        crate::platform::pairing::observe(s);
        true
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn revoke_schedule_continuations(s: &mut State, epoch: u64) {
    if let Some(ui) = &mut s.workspace {
        if ui.pairing_auth_epoch == epoch {
            return;
        }
        ui.pairing_auth_epoch = epoch;
        for entry in &mut ui.entries {
            if let Some(panel) = entry.missions.as_mut() {
                panel.schedules.revoke_continuation();
            }
        }
    }
}

pub(crate) fn suspend_mission_briefing(s: &mut State) {
    if let Some(ui) = &mut s.workspace {
        ui.mission_briefing.suspend();
    }
}

pub(crate) fn on_mission_transport_lost(s: &mut State) {
    if let Some(ui) = &mut s.workspace {
        ui.mission_briefing.suspend();
        let active_backend = ui.entries[ui.active]
            .missions
            .as_ref()
            .map(|panel| panel.briefing_backend().clone())
            .or_else(|| ui.entries[ui.active].binding.clone());
        let active_key = ui.entries[ui.active].key.clone();
        ui.mission_editor
            .revoke_auto_start_for_occurrence(&active_key);
        if let Some(backend) = &active_backend {
            ui.mission_editor.revoke_auto_start_for_connection(backend);
        }
        for (idx, entry) in ui.entries.iter_mut().enumerate() {
            let same_conn = idx == ui.active
                || active_backend.as_ref().is_some_and(|b| {
                    entry
                        .missions
                        .as_ref()
                        .is_some_and(|p| p.briefing_backend().client.same_connection(&b.client))
                });
            if same_conn {
                ui.mission_editor
                    .revoke_auto_start_for_occurrence(&entry.key);
                if let Some(panel) = entry.missions.as_mut() {
                    panel.invalidate_editor_generation();
                    panel.schedules.on_transport_lost();
                }
            }
        }
    }
}

pub(crate) fn suspend_missions(s: &mut State) {
    if let Some(ui) = &mut s.workspace {
        ui.mission_lifecycle.confirmation = None;
        ui.mission_lifecycle.retain_checks_for(None);
        ui.mission_briefing.suspend();
        ui.mission_schedules.confirmation = None;
        let entry = &mut ui.entries[ui.active];
        ui.mission_editor
            .revoke_auto_start_for_occurrence(&entry.key);
        if let Some(panel) = &mut entry.missions {
            panel.suspend();
        }
    }
}

pub(crate) fn mission_event(s: &mut State, event: Option<&WorkspaceEvent>) {
    if let Some(ui) = &mut s.workspace {
        let active_workspace = ui.entries[ui.active]
            .project
            .as_ref()
            .map(|project| project.id.as_str());
        let reconnected = match event {
            None => true,
            Some(WorkspaceEvent::MissionsReconnected { workspace_id }) => {
                active_workspace == Some(workspace_id.as_str())
            }
            _ => false,
        };
        if reconnected {
            ui.mission_briefing.suspend();
            let entry = &mut ui.entries[ui.active];
            ui.mission_editor
                .revoke_auto_start_for_occurrence(&entry.key);
            if let Some(panel) = entry.missions.as_mut() {
                panel.invalidate_editor_generation();
                panel.schedules.on_transport_lost();
            }
        }
    }
    // No observer may grant demand; the real mounted occurrence owns it.
    if mission_context_blocked(s)
        || (!(crate::shell::right_panel_visible(s)
            && right_panel_tab(s) == RightPanelTab::Missions)
            && !mission_has_reader(s)
            && !mission_has_editor(s))
    {
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
        Some(WorkspaceEvent::MissionScheduleChanged { workspace_id })
            if workspace_id == &project.id =>
        {
            panel.invalidate_schedules(ui.clock);
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

pub(crate) fn event_workspace_id(event: &WorkspaceEvent) -> Option<&str> {
    match event {
        WorkspaceEvent::NativeFilesystemChanged { workspace_id }
        | WorkspaceEvent::FilesChanged { workspace_id, .. }
        | WorkspaceEvent::WorktreesChanged { workspace_id }
        | WorkspaceEvent::SessionMoved { workspace_id, .. }
        | WorkspaceEvent::Stopped { workspace_id } => Some(workspace_id.as_str()),
        _ => None,
    }
}

pub(crate) fn deliver_detached_events(s: &mut State, events: &[WorkspaceEvent]) -> bool {
    if events.is_empty() {
        return false;
    }
    let mut delivered = false;
    let active_detached = s.screen.is_launcher() && s.incoming.is_none();
    for event in events {
        if matches!(event, WorkspaceEvent::UiPreferencesChanged) {
            if active_detached && s.git.owner.is_some() {
                crate::git::event(s, event);
                delivered = true;
            }
            continue;
        }
        let Some(target) = event_workspace_id(event) else {
            continue;
        };
        if active_detached || matches!(event, WorkspaceEvent::Stopped { .. }) {
            if s.git
                .owner
                .as_ref()
                .is_some_and(|git| git.workspace_id() == target)
            {
                crate::git::event(s, event);
                delivered = true;
            }
            if let Some(files) = &mut s.files
                && files.workspace_id() == target
            {
                files.event(event.clone());
                delivered = true;
            }
            if matches!(event, WorkspaceEvent::Stopped { .. })
                && let Some(agent) = &mut s.agent
            {
                delivered |= agent.workspace_stopped(target);
            }
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

pub(crate) fn has_detached_panels(s: &State) -> bool {
    let active = s.screen.is_launcher()
        && s.incoming.is_none()
        && (s.git.owner.is_some() || s.files.is_some());
    active
        || s.workspace.as_ref().is_some_and(|ui| {
            ui.entries.iter().enumerate().any(|(index, entry)| {
                index != ui.active
                    && entry
                        .cache
                        .as_ref()
                        .is_some_and(super::Cache::has_detached_panels)
            })
        })
}

pub(crate) fn detached_workspace_ids(s: &State) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    if s.screen.is_launcher() && s.incoming.is_none() {
        if let Some(git) = &s.git.owner {
            ids.insert(git.workspace_id().to_owned());
        }
        if let Some(files) = &s.files {
            ids.insert(files.workspace_id().to_owned());
        }
    }
    if let Some(ui) = &s.workspace {
        for (index, entry) in ui.entries.iter().enumerate() {
            if index == ui.active {
                continue;
            }
            if let Some(cache) = entry.cache.as_ref() {
                cache.collect_detached_workspace_ids(&mut ids);
            }
        }
    }
    ids
}

pub(crate) fn has_unopened_detached_panels(
    s: &State,
    opened_after: &std::collections::HashSet<String>,
) -> bool {
    detached_workspace_ids(s)
        .iter()
        .any(|id| !opened_after.contains(id))
}

pub(crate) fn stop_unlisted_detached(
    s: &mut State,
    live: &std::collections::HashSet<&str>,
) -> bool {
    let mut changed = false;
    if s.screen.is_launcher() && s.incoming.is_none() {
        if let Some(workspace_id) = s
            .git
            .owner
            .as_ref()
            .map(|git| git.workspace_id().to_owned())
            .filter(|id| !live.contains(id.as_str()))
        {
            crate::git::event(s, &WorkspaceEvent::Stopped { workspace_id });
            changed = true;
        }
        if let Some(files) = &mut s.files {
            let workspace_id = files.workspace_id().to_owned();
            if !live.contains(workspace_id.as_str()) {
                files.event(WorkspaceEvent::Stopped { workspace_id });
                changed = true;
            }
        }
    }
    if let Some(ui) = &mut s.workspace {
        for (index, entry) in ui.entries.iter_mut().enumerate() {
            if index == ui.active {
                continue;
            }
            if let Some(cache) = entry.cache.as_mut() {
                changed |= cache.stop_unlisted_detached(live);
            }
        }
    }
    changed
}

pub(crate) fn reconcile_detached_online(
    s: &mut State,
    opened_after: &std::collections::HashSet<String>,
    live: Option<&std::collections::HashSet<&str>>,
) -> bool {
    let mut changed = false;
    if s.screen.is_launcher() && s.incoming.is_none() {
        if let Some(workspace_id) = s
            .git
            .owner
            .as_ref()
            .map(|git| git.workspace_id().to_owned())
        {
            match live {
                Some(live)
                    if !opened_after.contains(workspace_id.as_str())
                        && !live.contains(workspace_id.as_str()) =>
                {
                    crate::git::event(s, &WorkspaceEvent::Stopped { workspace_id });
                    changed = true;
                }
                Some(_) => {
                    crate::git::online(s, true);
                    changed = true;
                }
                None if opened_after.contains(workspace_id.as_str()) => {
                    crate::git::online(s, true);
                    changed = true;
                }
                None => {}
            }
        }
        if let Some(files) = &mut s.files {
            let workspace_id = files.workspace_id().to_owned();
            match live {
                Some(live)
                    if !opened_after.contains(workspace_id.as_str())
                        && !live.contains(workspace_id.as_str()) =>
                {
                    files.event(WorkspaceEvent::Stopped { workspace_id });
                    changed = true;
                }
                Some(_) => {
                    files.online(true);
                    changed = true;
                }
                None if opened_after.contains(workspace_id.as_str()) => {
                    files.online(true);
                    changed = true;
                }
                None => {}
            }
        }
    }
    if let Some(ui) = &mut s.workspace {
        for (index, entry) in ui.entries.iter_mut().enumerate() {
            if index == ui.active {
                continue;
            }
            if let Some(cache) = entry.cache.as_mut() {
                changed |= cache.reconcile_detached_online(opened_after, live);
            }
        }
    }
    changed
}

pub(crate) fn set_detached_online(s: &mut State, online: bool) -> bool {
    let mut changed = false;
    let active_detached = s.screen.is_launcher() && s.incoming.is_none();
    if active_detached {
        if s.git.owner.is_some() {
            crate::git::online(s, online);
            changed = true;
        }
        if let Some(files) = &mut s.files {
            files.online(online);
            changed = true;
        }
    }
    if let Some(ui) = &mut s.workspace {
        for (index, entry) in ui.entries.iter_mut().enumerate() {
            if index == ui.active {
                continue;
            }
            if let Some(cache) = entry.cache.as_mut() {
                changed |= cache.set_detached_online(online);
            }
        }
    }
    changed
}

pub(crate) fn mission_observation_project(s: &State) -> Option<&str> {
    // Cached streams belong to other occurrences. Only the current conversation
    // can carry this occurrence's events in place of the project observer.
    if !((crate::shell::right_panel_visible(s) && right_panel_tab(s) == RightPanelTab::Missions)
        || mission_has_reader(s))
        || s.incoming
            .as_ref()
            .is_some_and(|stream| !stream.is_closed())
    {
        return None;
    }
    let ui = s.workspace.as_ref()?;
    let entry = &ui.entries[ui.active];
    let backend = s.screen.launcher()?.connection.as_ref()?;
    if !entry
        .binding
        .as_ref()?
        .client
        .same_connection(&backend.client)
    {
        return None;
    }
    Some(entry.project.as_ref()?.id.as_str())
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
