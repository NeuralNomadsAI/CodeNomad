//! On-demand briefing controls and coordinator conversation navigation.
//! Mirrors `packages/ui/src/components/mission-briefing.tsx` and
//! `packages/ui/src/components/mission-selected-actions.tsx`.
use super::{
    Panel,
    briefing::{BriefingGesture, BriefingKey, BriefingPhase, BriefingRequests},
};
use crate::{State, strings::t};
use rune::{El, Tx, col};
use rune_theme_codenomad::{
    document_reader::editor,
    git_panel as theme,
    layout::{self, Layout},
};

pub(crate) type BriefingAct = fn(&mut State, &str, &BriefingKey, BriefingGesture);
pub(crate) type OpenConversation = fn(&mut State, String, &mut Tx);

pub(crate) fn controls(
    panel: &Panel,
    owner: &BriefingRequests,
    occurrence: &str,
    act: BriefingAct,
    open: OpenConversation,
) -> El {
    let Some((key, header)) = panel.briefing_source() else {
        return rune::el();
    };
    controls_body::<State>(
        &key,
        header,
        owner,
        panel.detail.failed,
        occurrence,
        act,
        open,
    )
}

fn controls_body<S: 'static>(
    key: &BriefingKey,
    header: &codenomad_client::missions::MapHeader,
    owner: &BriefingRequests,
    messaging_disabled: bool,
    occurrence: &str,
    act: fn(&mut S, &str, &BriefingKey, BriefingGesture),
    open: fn(&mut S, String, &mut Tx),
) -> El {
    let available = header.accepts_coordinator_message();
    let phase = owner.visible_phase(key, header);
    let waiting = owner.waiting(key, header);
    let request_disabled = waiting || messaging_disabled || owner.at_capacity(key);
    let coordinator = header.root.coordinator_session_id().to_owned();
    let mut row = layout::action_row();

    if available {
        let label = if !waiting {
            t("missionsPanel.action.requestUpdate")
        } else if phase == Some(&BriefingPhase::Uncertain) {
            t("missionsPanel.action.requestUpdateUncertain")
        } else {
            t("missionsPanel.action.requestUpdatePending")
        };
        let origin_occ = occurrence.to_owned();
        let origin_key = key.clone();
        let mut button = layout::button_tx(label, false, move |s: &mut S, tx| {
            if !request_disabled {
                act(s, &origin_occ, &origin_key, BriefingGesture::Ask);
                tx.instant();
            }
        })
        .disabled(request_disabled)
        .focusable(true)
        .key("mission-briefing-request");
        if waiting && let Some(msg_key) = phase.and_then(BriefingPhase::message_key) {
            let desc = t(msg_key);
            button = button.help(desc).description(desc);
        }
        row = row.child(button);
    }

    let coord_open = coordinator.clone();
    row = row.child(
        layout::button_tx(
            t("missionsPanel.action.openConversation"),
            false,
            move |s: &mut S, tx| {
                open(s, coord_open.clone(), tx);
                tx.instant();
            },
        )
        .key("mission-open-coordinator"),
    );

    let mut view = col().full_width().child(row);

    if let Some(phase) = phase
        && let Some(msg_key) = phase.message_key()
    {
        let role = if phase.is_alert() { "alert" } else { "status" };
        view = view.child(theme::note(t(msg_key), role).key("mission-briefing-feedback"));
        if phase.offers_followup() {
            let coord_followup = coordinator;
            let origin_occ = occurrence.to_owned();
            let origin_key = key.clone();
            let followup_new_disabled = !available || messaging_disabled;
            let followup = layout::action_row()
                .child(
                    layout::button_tx(
                        t("missions.control.openCoordinator"),
                        false,
                        move |s: &mut S, tx| {
                            if !messaging_disabled {
                                open(s, coord_followup.clone(), tx);
                                tx.instant();
                            }
                        },
                    )
                    .disabled(messaging_disabled)
                    .focusable(true)
                    .key("mission-briefing-open-coordinator"),
                )
                .child(
                    layout::button_tx(
                        t("missions.briefing.newRequest"),
                        false,
                        move |s: &mut S, tx| {
                            if !followup_new_disabled {
                                act(
                                    s,
                                    &origin_occ,
                                    &origin_key,
                                    BriefingGesture::ConfirmNewDialog,
                                );
                                tx.instant();
                            }
                        },
                    )
                    .disabled(followup_new_disabled)
                    .focusable(true)
                    .key("mission-briefing-new-request"),
                );
            view = view.child(followup);
        }
    }

    view
}

pub(crate) fn confirmation(owner: &BriefingRequests, act: BriefingAct) -> Option<El> {
    let (occurrence, key) = owner.confirmation.clone()?;
    Some(editor::confirmation(
        layout::dark(),
        t("missions.briefing.newConfirm"),
        t("missions.control.cancel"),
        t("missions.briefing.newRequest"),
        move |s: &mut State, accept, tx: &mut Tx| {
            act(s, &occurrence, &key, BriefingGesture::ConfirmNew(accept));
            tx.instant();
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use codenomad_client::missions::MapHeader;
    use rune::{Env, Runtime};
    use serde_json::json;

    fn sample_header() -> MapHeader {
        serde_json::from_value(json!({
            "root": {
                "id": "msn-1", "title": "Mission", "excerpt": "Obj",
                "status": "active", "runState": "running", "revision": 5,
                "projectID": "proj-1", "projectCanonical": "/repo",
                "coordinatorSessionId": "ses_coord", "version": 1,
                "template": "custom", "createdAt": 1.0, "updatedAt": 2.0,
                "historyTruncated": false, "bodies": {}
            },
            "tasks": {
                "page": {"order": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "offset": 0, "end": 0, "total": 0, "counts": {}, "reports": 0},
                "pins": [], "reportPins": [], "version": "1"
            },
            "collections": {
                "actors": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true},
                "history": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true},
                "reports": {"characters": 2, "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "total": 0, "array": true}
            }
        }))
        .unwrap()
    }

    #[test]
    fn uncertain_briefing_renders_disabled_uncertain_button_alert_and_followup_actions() {
        let header = sample_header();
        let key = BriefingKey::fixture(&header);
        let mut owner = BriefingRequests::default();
        owner.fixture_phase(&key, "req-1", BriefingPhase::Uncertain);

        struct Fixture {
            key: BriefingKey,
            header: MapHeader,
            owner: BriefingRequests,
            asks: usize,
            confirm_dialogs: usize,
            opened: Vec<String>,
        }
        let mut rt = Runtime::new(
            Fixture {
                key,
                header,
                owner,
                asks: 0,
                confirm_dialogs: 0,
                opened: vec![],
            },
            |fixture, _| {
                crate::strings::with_locale("en", || {
                    controls_body(
                        &fixture.key,
                        &fixture.header,
                        &fixture.owner,
                        false,
                        "tab-0",
                        |s: &mut Fixture, _, _, gesture| match gesture {
                            BriefingGesture::Ask => s.asks += 1,
                            BriefingGesture::ConfirmNewDialog => s.confirm_dialogs += 1,
                            BriefingGesture::ConfirmNew(_) => {}
                        },
                        |s: &mut Fixture, id, _| s.opened.push(id),
                    )
                })
            },
            (480.0, 480.0),
            Env::new(false, 1.0),
        );
        rt.frame(1.0 / 60.0);

        let by_key = |rt: &Runtime<Fixture>, key: &str| {
            rt.elements()
                .iter()
                .find(|el| el.key.as_deref() == Some(key))
                .cloned()
        };
        assert!(by_key(&rt, "mission-briefing-request").is_some());
        let feedback = by_key(&rt, "mission-briefing-feedback").expect("feedback note");
        assert_eq!(feedback.role, "alert");
        assert!(by_key(&rt, "mission-open-coordinator").is_some());
        assert!(by_key(&rt, "mission-briefing-open-coordinator").is_some());
        assert!(by_key(&rt, "mission-briefing-new-request").is_some());

        // Clicking disabled request button must not fire Ask.
        let (x, y) = rt.find("mission-briefing-request").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.asks, 0);

        // Clicking followup controls triggers coordinator open and new-request confirmation.
        let (x, y) = rt.find("mission-briefing-open-coordinator").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.opened, vec!["ses_coord"]);

        let (x, y) = rt.find("mission-briefing-new-request").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(1.0 / 60.0);
        assert_eq!(rt.state.confirm_dialogs, 1);
    }
}
