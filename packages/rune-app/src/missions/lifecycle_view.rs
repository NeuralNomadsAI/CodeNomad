use super::{Gesture, Lifecycle, Panel, Source};
use crate::{State, strings::t};
use codenomad_client::missions::{LifecycleAction, RunState, Status};
use rune::{El, Tx};
use rune_theme_codenomad::{document_reader::editor, git_panel as theme, layout};

pub(crate) type Act = fn(&mut State, &Source, Gesture);

pub(crate) fn controls(panel: &Panel, owner: &Lifecycle, occurrence: &str, act: Act) -> El {
    let Some((source, header)) = panel.control_source(occurrence) else {
        return rune::el();
    };
    let revision = header.root.revision;
    let ready = panel.detail.authoritative();
    let pausing = Lifecycle::allow(
        header,
        LifecycleAction::Pause,
        false,
        panel.observation.working(),
    );
    let mut row = layout::action_row();
    let button = |label, disabled: bool, gesture: fn() -> Gesture, key| {
        if disabled {
            layout::focusable_disabled_button(label).key(key)
        } else {
            let origin = source.clone();
            layout::button_tx(label, false, move |s: &mut State, tx| {
                act(s, &origin, gesture());
                tx.instant();
            })
            .key(key)
        }
    };
    if owner.unresolved(&source, header) || owner.busy(&source) {
        row = row.child(button(
            t("missionsPanel.action.checkStatus"),
            owner.busy(&source),
            || Gesture::Check,
            "mission-control-primary",
        ));
        if owner.replayable(&source, revision) {
            row = row.child(button(
                t("missions.control.refreshResend"),
                !ready,
                || Gesture::Replay,
                "mission-control-replay",
            ));
        }
    } else if header.root.status == Status::Active
        && header.root.run_state != Some(RunState::Stopped)
    {
        let disabled = !ready || !owner.idle(&source, header);
        let (action, graceful, label) = match header.root.run_state {
            Some(RunState::Prepared) => {
                (LifecycleAction::Start, false, "missionsPanel.action.start")
            }
            Some(RunState::Paused) => {
                (LifecycleAction::Start, false, "missionsPanel.action.resume")
            }
            _ => (LifecycleAction::Pause, true, "missionsPanel.action.pause"),
        };
        row = row.child(if disabled {
            layout::focusable_disabled_button(t(label)).key("mission-control-primary")
        } else {
            let origin = source.clone();
            layout::button_tx(t(label), false, move |s, tx| {
                act(s, &origin, Gesture::New(action, graceful, revision));
                tx.instant();
            })
            .key("mission-control-primary")
        });
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
        let disabled = !ready || !owner.can_stop(&source, header);
        let origin = source.clone();
        row = row.child(
            layout::button_tx(t("missions.control.run.stop"), disabled, move |s, tx| {
                act(s, &origin, Gesture::StopDialog(revision));
                tx.instant();
            })
            .key("mission-control-stop"),
        );
    }
    let mut view = theme::context().child(row);
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
