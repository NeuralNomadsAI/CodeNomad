use super::{
    Gesture, Lifecycle, Panel, Source,
    cleanup::DeleteState,
    cleanup_view::{CleanupAct, DeleteAct, cleanup_view},
    recovery::{self, RecoveryKey},
};
use crate::{State, strings::t};
use codenomad_client::missions::{LifecycleAction, RunState, Status};
use rune::{El, Tx, col};
use rune_theme_codenomad::{
    document_reader::editor,
    git_panel as theme,
    layout::{self, Layout},
};

pub(crate) type Act = fn(&mut State, &Source, Gesture);

pub(crate) fn cleanups(
    panel: &Panel,
    owner: &Lifecycle,
    occurrence: &str,
    retry: CleanupAct,
    orphaned_delete: DeleteAct,
) -> El {
    cleanup_view(panel, &owner.cleanup, occurrence, retry, orphaned_delete)
}

pub(crate) fn controls(
    panel: &Panel,
    owner: &Lifecycle,
    occurrence: &str,
    delete_managed_sessions: Option<bool>,
    act: Act,
) -> El {
    let Some((source, header)) = panel.control_source(occurrence) else {
        return rune::el();
    };
    let revision = header.root.revision;
    let ready = panel.detail.authoritative();
    let delete_state = owner.cleanup.delete_state(&source);
    let delete_active = delete_state.is_some();
    let recover_key = RecoveryKey::coordinator(&source, revision);
    let recover_eligible = recovery::coordinator_eligible(header, &panel.observation);
    let recovery_busy = owner.recovery.any_pending_for(&source);
    let recover_pending = owner.recovery.pending(&recover_key);
    let recover_admitted = owner.recovery.admitted(&recover_key);
    let recover_error = owner.recovery.error_for(
        &source,
        codenomad_client::missions::RecoveryTarget::Coordinator,
    );
    let pausing = Lifecycle::allow(
        header,
        LifecycleAction::Pause,
        false,
        panel.observation.working(),
    );
    let mut row = layout::action_row();
    let button = |label, disabled: bool, gesture: fn() -> Gesture, key| {
        let origin = source.clone();
        layout::button_tx(label, false, move |s: &mut State, tx| {
            if !disabled {
                act(s, &origin, gesture());
                tx.instant();
            }
        })
        .disabled(disabled)
        .focusable(true)
        .key(key)
    };
    if owner.unresolved(&source, header) || owner.busy(&source) {
        row = row.child(button(
            t("missionsPanel.action.checkStatus"),
            owner.busy(&source) || delete_active || recovery_busy,
            || Gesture::Check,
            "mission-control-primary",
        ));
        if owner.replayable(&source, revision) {
            row = row.child(button(
                t("missions.control.refreshResend"),
                !ready || delete_active || recovery_busy,
                || Gesture::Replay,
                "mission-control-replay",
            ));
        }
    } else if header.root.status == Status::Failed && recover_eligible {
        let disabled = !ready
            || delete_active
            || recovery_busy
            || recover_pending
            || recover_admitted
            || !owner.recovery.can_start(&recover_key);
        let origin = source.clone();
        row = row.child(
            layout::button_tx(t("missionsPanel.action.recover"), false, move |s, tx| {
                if !disabled {
                    act(s, &origin, Gesture::RecoverCoordinator(revision));
                    tx.instant();
                }
            })
            .disabled(disabled)
            .focusable(true)
            .key("mission-control-primary"),
        );
    } else if header.root.status == Status::Active
        && header.root.run_state != Some(RunState::Stopped)
    {
        let disabled = !ready || delete_active || recovery_busy || !owner.idle(&source, header);
        let pause_slot = matches!(header.root.run_state, None | Some(RunState::Running));
        if pause_slot && recover_eligible {
            let disabled = disabled
                || recover_pending
                || recover_admitted
                || !owner.recovery.can_start(&recover_key);
            let origin = source.clone();
            row = row.child(
                layout::button_tx(t("missionsPanel.action.recover"), false, move |s, tx| {
                    if !disabled {
                        act(s, &origin, Gesture::RecoverCoordinator(revision));
                        tx.instant();
                    }
                })
                .disabled(disabled)
                .focusable(true)
                .key("mission-control-primary"),
            );
        } else {
            let (action, graceful, label) = match header.root.run_state {
                Some(RunState::Prepared) => {
                    (LifecycleAction::Start, false, "missionsPanel.action.start")
                }
                Some(RunState::Paused) => {
                    (LifecycleAction::Start, false, "missionsPanel.action.resume")
                }
                _ => (LifecycleAction::Pause, true, "missionsPanel.action.pause"),
            };
            let origin = source.clone();
            row = row.child(
                layout::button_tx(t(label), false, move |s, tx| {
                    if !disabled {
                        act(s, &origin, Gesture::New(action, graceful, revision));
                        tx.instant();
                    }
                })
                .disabled(disabled)
                .focusable(true)
                .key("mission-control-primary"),
            );
        }
        if pausing {
            let origin = source.clone();
            row = row.child(
                layout::button_tx(
                    t("missionsPanel.action.interruptNow"),
                    disabled,
                    move |s, tx| {
                        act(
                            s,
                            &origin,
                            Gesture::New(LifecycleAction::Pause, false, revision),
                        );
                        tx.instant();
                    },
                )
                .key("mission-control-interrupt"),
            );
        }
    }
    if Lifecycle::allow(header, LifecycleAction::Stop, false, false)
        && (owner.can_stop(&source, header) || owner.busy(&source))
    {
        let disabled = !ready || delete_active || recovery_busy || !owner.can_stop(&source, header);
        let origin = source.clone();
        row = row.child(
            layout::button_tx(t("missions.control.run.stop"), disabled, move |s, tx| {
                act(s, &origin, Gesture::StopDialog(revision));
                tx.instant();
            })
            .key("mission-control-stop"),
        );
    }
    if delete_state.is_none() {
        let disabled = !ready
            || owner.busy(&source)
            || owner.unresolved(&source, header)
            || recovery_busy
            || delete_managed_sessions.is_none()
            || !owner.cleanup.can_delete(&source);
        let origin = source.clone();
        row = row.child(
            layout::button_tx(t("missionsPanel.picker.delete"), false, move |s, tx| {
                if !disabled && let Some(delete_sessions) = delete_managed_sessions {
                    act(
                        s,
                        &origin,
                        Gesture::DeleteMission(revision, delete_sessions),
                    );
                    tx.instant();
                }
            })
            .disabled(disabled)
            .focusable(true)
            .key("mission-control-delete"),
        );
    }
    let mut view = col().full_width().child(row);
    if owner.busy(&source) {
        view = view.child(theme::note(t("missions.control.run.checking"), "status"));
    } else if owner.unresolved(&source, header) {
        view = view.child(theme::note(t("missions.control.run.error"), "alert"));
    } else if let Some(key) = owner.feedback(&source) {
        view = view.child(theme::note(t(key), "alert"));
    } else if pausing {
        view = view.child(theme::note(t("missions.control.run.pausing"), "status"));
    } else if header
        .control
        .as_ref()
        .is_some_and(|control| control.partial_descendants > 0)
    {
        view = view.child(theme::note(
            t("missions.control.run.partialInterrupt"),
            "status",
        ));
    }
    if recover_pending {
        view = view.child(theme::note(t("missions.recovery.pending"), "status"));
    } else if let Some(error) = recover_error {
        view = view.child(theme::note(t(error.key()), "alert"));
    }
    match delete_state {
        Some(DeleteState::Busy) => {
            view = view.child(theme::note(
                t("missions.control.mutation.pending"),
                "status",
            ));
        }
        Some(DeleteState::Failed(key)) => {
            let retry_disabled = owner.busy(&source)
                || recovery_busy
                || owner
                    .cleanup
                    .has_active_cleanup_retry(&source.workspace_scope(), &source.target.mission);
            let retry_origin = source.clone();
            let cancel_origin = source.clone();
            view = view.child(theme::note(t(key), "alert")).child(
                layout::action_row()
                    .role("group")
                    .label(t("missions.control.delete"))
                    .child(
                        layout::button_tx(t("missions.control.retry"), false, move |s, tx| {
                            if !retry_disabled {
                                act(s, &retry_origin, Gesture::RetryDelete);
                                tx.instant();
                            }
                        })
                        .disabled(retry_disabled)
                        .focusable(true)
                        .key("mission-delete-retry"),
                    )
                    .child(
                        layout::button_tx(t("missions.control.cancel"), false, move |s, tx| {
                            act(s, &cancel_origin, Gesture::CancelDelete);
                            tx.instant();
                        })
                        .key("mission-delete-cancel"),
                    ),
            );
        }
        None => {}
    }
    if let Some(control) = &header.control {
        view = view.child(super::control_fields::view(
            &panel.control_fields,
            control,
            ready,
            &source,
            act,
        ));
    }
    view
}

pub(crate) fn confirmation(owner: &Lifecycle, act: Act) -> Option<El> {
    let (source, _) = owner.confirmation.clone()?;
    Some(editor::confirmation(
        layout::dark(),
        t("missions.control.run.stopConfirm"),
        t("missions.control.cancel"),
        t("missions.control.run.stop"),
        move |s: &mut State, accept, tx: &mut Tx| {
            act(s, &source, Gesture::ConfirmStop(accept));
            tx.instant();
        },
    ))
}
