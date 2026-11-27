use crate::{
    agent_api::{self, Form},
    agent_forms::{self, Draft},
};
use serde_json::json;

#[test]
fn notifications_deliver_a_root_question_once_and_wait_for_an_idle_verification() {
    use crate::shell::notifications::{self, Target};
    let (jobs, incoming) = super::bounded(1);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(1);
    let mut agent = super::Ui::new(super::Handle::test(jobs, stop, results));
    agent.online = true;
    assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(true, 0))));
    let snapshot = || agent_api::Snapshot {
        models: Some(vec![]),
        current: None,
        directory: None,
        session_known: true,
        running: false,
        root_directory: Some("/project/worktree".into()),
        usage: None,
        permissions: Some(vec![]),
        forms: Some(vec![Form {
            id: "question".into(),
            title: "A question".into(),
            fields: vec![],
            tool: None,
            infer_websearch: false,
        }]),
    };
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    s.chat_title = "Private conversation".into();
    s.agent = Some(agent);
    let (events, inbox) = super::bounded(1);
    s.incoming = Some(inbox);
    s.notifications.record();
    let target = Target {
        tab: Some("tab-0".into()),
        backend_url: "http://127.0.0.1:9/".into(),
        server: None,
        occurrence: 0,
        workspace: "project".into(),
        session: "session".into(),
    };
    let mut runtime =
        rune::Runtime::new(s, crate::view, (960.0, 760.0), rune::Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.window_focus(false);
    runtime.frame(0.02);
    runtime.update(|s, _| {
        let mut foreign = target.clone();
        foreign.server = Some("other-server".into());
        assert!(matches!(crate::settings::system_notification(
            s, &foreign, crate::settings::notification_routing::Category::NeedsInput, false, "foreign"
        ), crate::settings::Delivery::Suppressed));
        assert!(events.try_send(crate::transport::Event::Workspace(
            codenomad_client::transport::WorkspaceEvent::SessionRequest { form: true, id: "question".into() }
        )).is_ok());
        assert!(crate::poll_chat(s, 8));
        for _ in 0..2 {
            assert!(out.try_send(super::Result::Read(snapshot(), false, 0)).is_ok());
            assert!(crate::poll_chat(s, 8));
            notifications::collect(s, |_| Some((target.clone(), "Private project".into())));
            let _ = incoming.try_recv();
        }
        assert_eq!(
            s.notifications.recorded(),
            &[(
                0,
                "Private project".into(),
                "Session “Private conversation” needs your answer".into()
            )]
        );
        assert!(events.try_send(crate::transport::Event::Workspace(
            codenomad_client::transport::WorkspaceEvent::SessionExecution { notice: Some("finished".into()) }
        )).is_ok());
        assert!(crate::poll_chat(s, 8));
        assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(false, 0))));
        assert!(out.try_send(super::Result::Read(snapshot(), false, 0)).is_ok());
        assert!(crate::poll_chat(s, 8));
        assert!(matches!(
            incoming.try_recv(),
            Ok(super::Job::VerifyIdle(id, directory)) if id == "finished" && directory == "/project/worktree"
        ));
        notifications::collect(s, |_| Some((target.clone(), "Private project".into())));
        assert_eq!(s.notifications.recorded().len(), 1);
        assert!(out.try_send(super::Result::VerifiedIdle("finished".into(), true)).is_ok());
        assert!(crate::poll_chat(s, 8));
        notifications::collect(s, |_| Some((target, "Private project".into())));
        assert_eq!(
            s.notifications.recorded()[1].2,
            "Session “Private conversation” finished"
        );
    });
}

#[test]
fn terminal_event_fences_only_activity_in_a_pending_control_response() {
    let (jobs, incoming) = super::bounded(1);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(1);
    let mut ui = super::Ui::new(super::Handle::test(jobs, stop, results));
    assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(true, 0))));
    ui.known = true;
    ui.observe_running(false);
    let snapshot = |forms| agent_api::Snapshot {
        models: Some(vec![]),
        current: None,
        directory: None,
        session_known: true,
        root_directory: None,
        usage: None,
        running: true,
        permissions: Some(vec![]),
        forms: Some(forms),
    };
    assert!(
        out.try_send(super::Result::Read(
            snapshot(vec![Form {
                tool: None,
                infer_websearch: false,
                id: "form_pending".into(),
                title: "Pending question".into(),
                fields: vec![],
            }]),
            true,
            0
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(!ui.running);
    assert_eq!(ui.selected, "form_pending");
    ui.refresh(false);
    assert!(matches!(
        incoming.try_recv(),
        Ok(super::Job::Read(false, 0))
    ));
    assert!(
        out.try_send(super::Result::Read(snapshot(vec![]), false, 0))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.running);
}

#[test]
fn quota_model_waits_for_a_snapshot_requested_after_the_native_change() {
    use super::{Handle, Job, Result, Ui, bounded};
    let (jobs, read) = bounded(1);
    let (stop, _stopped) = bounded(1);
    let (out, results) = bounded(1);
    let mut ui = Ui::new(Handle::test(jobs, stop, results));
    assert!(matches!(read.try_recv(), Ok(Job::Read(true, 0))));
    let snapshot = |model| agent_api::Snapshot {
        models: Some(vec![]),
        current: Some(json!({"providerID":"fixture","id":model})),
        directory: Some("/fixture".into()),
        root_directory: None,
        usage: None,
        session_known: true,
        running: false,
        permissions: Some(vec![]),
        forms: Some(vec![]),
    };
    ui.refresh_usage_model(1);
    assert!(out.try_send(Result::Read(snapshot("old"), true, 0)).is_ok());
    assert!(ui.poll());
    assert!(ui.usage_model(1).is_none());
    assert!(matches!(read.try_recv(), Ok(Job::Read(false, 1))));
    assert!(
        out.try_send(Result::Read(snapshot("new"), false, 1))
            .is_ok()
    );
    assert!(ui.poll());
    assert_eq!(ui.usage_model(1).unwrap().1["id"], "new");
}

#[test]
fn settled_requests_and_removed_models_reject_late_actions_before_dispatch() {
    let (jobs, incoming) = super::bounded(4);
    let (permissions, perm_incoming) = super::bounded(4);
    let (forms, form_incoming) = super::bounded(4);
    let (catalog, _catalog_incoming) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (_, results) = super::bounded(1);
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: None,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(true, 0))));
    assert!(matches!(
        perm_incoming.try_recv(),
        Ok(super::PendingJob::Read(1))
    ));
    assert!(matches!(
        form_incoming.try_recv(),
        Ok(super::PendingJob::Read(1))
    ));
    ui.reading = false;
    ui.permissions_lane.reading = false;
    ui.forms_lane.reading = false;
    ui.mark_pending_known();
    ui.online = true;
    let model = super::Model {
        reference: json!({"id":"model","providerID":"fixture"}),
        label: "Model".into(),
        included: false,
    };
    ui.models.push(model);
    let model = ui.models.pop().unwrap();
    ui.picker = true;
    ui.choose_model(model.reference.clone());
    assert!(ui.picker);
    ui.selected = "current".into();
    ui.select_request("settled".into());
    ui.reply_permission("settled".into(), "once");
    ui.cancel_form("settled".into());
    assert_eq!(ui.selected, "current");
    assert!(incoming.try_recv().is_err());
    assert!(perm_incoming.try_recv().is_err());
    assert!(form_incoming.try_recv().is_err());
    assert!(!ui.busy);
    assert!(!ui.permissions_lane.busy);
    assert!(!ui.forms_lane.busy);
    ui.permissions.push(agent_api::Permission {
        id: "live_perm".into(),
        action: "bash".into(),
        resources: vec!["git status".into()],
        message: String::new(),
        supported: true,
        tool: None,
    });
    ui.reply_permission("live_perm".into(), "once");
    assert!(matches!(
        perm_incoming.try_recv(),
        Ok(super::PendingJob::Act(agent_api::Action::Permission(id, decision, _), 2))
            if id == "live_perm" && decision == "once"
    ));
    assert!(ui.permissions_lane.busy);
    ui.forms.push(Form {
        id: "live_form".into(),
        title: "Confirm".into(),
        fields: vec![],
        tool: None,
        infer_websearch: false,
    });
    ui.cancel_form("live_form".into());
    assert!(matches!(
        form_incoming.try_recv(),
        Ok(super::PendingJob::Act(agent_api::Action::Cancel(id), 2)) if id == "live_form"
    ));
    assert!(ui.forms_lane.busy);
    ui.models.push(model.clone());
    ui.choose_model(model.reference);
    assert!(matches!(
        incoming.try_recv(),
        Ok(super::Job::Act(agent_api::Action::Model(_), 0))
    ));
    assert!(ui.busy);
    assert!(!ui.picker);
}

#[test]
fn notification_qualification_is_order_independent_and_never_replays_cached_requests() {
    use crate::shell::notifications::Category;
    let session_snap = || agent_api::Snapshot {
        models: None,
        current: None,
        directory: Some("/repo".into()),
        session_known: true,
        root_directory: Some("/repo".into()),
        usage: None,
        running: false,
        permissions: None,
        forms: None,
    };
    let perm = |id: &str| agent_api::Permission {
        id: id.into(),
        action: "bash".into(),
        resources: vec![],
        message: String::new(),
        supported: true,
        tool: None,
    };

    // Order A: permissions succeed while forms fail BEFORE root session arrives.
    let (jobs, _jobs_rx) = super::bounded(4);
    let (stop, _stop_rx) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle::test(jobs, stop, results));
    ui.online = true;
    let generation = ui.permissions_lane.generation;
    ui.attention.request(false, "perm_a".into());
    assert!(
        out.try_send(super::Result::Permissions(
            Some(vec![perm("perm_a")]),
            generation
        ))
        .is_ok()
    );
    assert!(
        out.try_send(super::Result::Forms(None, ui.forms_lane.generation))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(
        !ui.pending_known,
        "failed form read keeps aggregate pending_known false"
    );
    assert!(ui.permissions_lane.known);
    assert!(!ui.permissions_locked());
    assert!(ui.forms_locked());
    assert!(ui.attention.take_pending().is_empty());
    assert!(
        out.try_send(super::Result::Session(
            session_snap(),
            Some("/repo".into()),
            false,
            0
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert_eq!(
        ui.attention.take_pending(),
        vec![(Category::NeedsInput, "0:perm_a".into())],
        "valid permissions received before session must still notify even when forms failed"
    );

    // Order B: root session arrives BEFORE permissions, and a later session during refresh
    // must never replay a stale cached permission.
    ui.attention.request(false, "perm_b".into());
    let generation = ui.permissions_lane.generation;
    assert!(
        out.try_send(super::Result::Permissions(
            Some(vec![perm("perm_b")]),
            generation
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert_eq!(
        ui.attention.take_pending(),
        vec![(Category::NeedsInput, "0:perm_b".into())]
    );

    // Simulate a late hint for already-cached perm_b while refresh is in flight; Session returns
    // before the fresh empty Permissions response and must NOT confirm stale perm_b.
    ui.notice_request(false, "perm_b".into());
    let fresh_gen = ui.permissions_lane.generation;
    assert!(
        out.try_send(super::Result::Session(
            session_snap(),
            Some("/repo".into()),
            false,
            0
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(
        ui.attention.take_pending().is_empty(),
        "session completion must never replay stale cached permissions"
    );
    assert!(
        out.try_send(super::Result::Permissions(Some(vec![]), fresh_gen))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(
        ui.attention.take_pending().is_empty(),
        "resolved permission absent from fresh pending read must not notify"
    );

    // Order C: Permissions arrives before Session, then an external settlement hint triggers
    // refresh(false) before Session responds. Session must NOT drain the invalidated deferred list.
    let (jobs, _jobs_rx) = super::bounded(4);
    let (stop, _stop_rx) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle::test(jobs, stop, results));
    ui.online = true;
    ui.attention.request(false, "perm_settled".into());
    let generation = ui.permissions_lane.generation;
    assert!(
        out.try_send(super::Result::Permissions(
            Some(vec![perm("perm_settled")]),
            generation
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.attention.take_pending().is_empty());
    ui.refresh(false);
    let fresh_gen = ui.permissions_lane.generation;
    assert!(
        out.try_send(super::Result::Session(
            session_snap(),
            Some("/repo".into()),
            false,
            0
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(
        ui.attention.take_pending().is_empty(),
        "refresh triggered by external settlement must invalidate deferred pending list before session arrives"
    );
    assert!(
        out.try_send(super::Result::Permissions(Some(vec![]), fresh_gen))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.attention.take_pending().is_empty());

    // Order D: SSE settlement arrives while an older GET /permission (gen=1) is STILL in flight ->
    // stale HTTP response (gen=1) arrives BEFORE trailing refresh (gen=2) -> must NOT notify
    // either immediately (with known root session) or deferred (before session arrives).
    for with_known_session in [true, false] {
        let (jobs, _jobs_rx) = super::bounded(4);
        let (permissions, perm_rx) = super::bounded(4);
        let (forms, _form_rx) = super::bounded(4);
        let (catalog, _cat_rx) = super::bounded(4);
        let (stop, _stop_rx) = super::bounded(1);
        let (out, results) = super::bounded(8);
        let mut ui = super::Ui::new(super::Handle {
            connection: None,
            workspace_id: None,
            jobs,
            permissions,
            forms,
            catalog,
            stop,
            results,
        });
        ui.online = true;
        assert!(matches!(perm_rx.try_recv(), Ok(super::PendingJob::Read(1))));
        if with_known_session {
            assert!(
                out.try_send(super::Result::Session(
                    session_snap(),
                    Some("/repo".into()),
                    false,
                    0
                ))
                .is_ok()
            );
            assert!(ui.poll());
        }
        // Hint for perm_in_flight while gen=1 read is still in flight; then settlement SSE calls refresh(false).
        ui.attention.request(false, "perm_in_flight".into());
        ui.refresh(false);
        assert_eq!(ui.permissions_lane.generation, 2);
        assert!(ui.permissions_lane.trailing);

        // Stale HTTP response (gen=1) returns the already-settled permission.
        assert!(
            out.try_send(super::Result::Permissions(
                Some(vec![perm("perm_in_flight")]),
                1
            ))
            .is_ok()
        );
        assert!(ui.poll());
        assert!(
            ui.attention.take_pending().is_empty(),
            "stale in-flight response (gen=1) arriving after settlement refresh must not notify"
        );
        // Trailing read (gen=2) was dispatched immediately by poll().
        assert!(matches!(perm_rx.try_recv(), Ok(super::PendingJob::Read(2))));
        if !with_known_session {
            assert!(
                out.try_send(super::Result::Session(
                    session_snap(),
                    Some("/repo".into()),
                    false,
                    0
                ))
                .is_ok()
            );
            assert!(ui.poll());
            assert!(
                ui.attention.take_pending().is_empty(),
                "stale in-flight response (gen=1) must not recreate deferred notifications either"
            );
        }
        // Fresh response (gen=2) confirms the permission is gone.
        assert!(
            out.try_send(super::Result::Permissions(Some(vec![]), 2))
                .is_ok()
        );
        assert!(ui.poll());
        assert!(ui.attention.take_pending().is_empty());
    }
}

#[test]
fn lane_errors_are_isolated_across_model_pending_catalog_and_stop() {
    let (jobs, _jobs_rx) = super::bounded(4);
    let (stop, _stop_rx) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle::test(jobs, stop, results));
    ui.online = true;
    let ok_session = || agent_api::Snapshot {
        models: None,
        current: None,
        directory: Some("/repo".into()),
        session_known: true,
        root_directory: Some("/repo".into()),
        usage: None,
        running: false,
        permissions: None,
        forms: None,
    };

    // Permission action fails -> error is set.
    let perm_gen = ui.permissions_lane.generation;
    let form_gen = ui.forms_lane.generation;
    assert!(
        out.try_send(super::Result::ActPermission(false, Some(vec![]), perm_gen))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.error);

    // Unrelated successful model, form, and stop actions must NOT clear permissions error.
    assert!(
        out.try_send(super::Result::Act(true, ok_session(), None, 0))
            .is_ok()
    );
    assert!(
        out.try_send(super::Result::ActForm(
            crate::agent_api::FormReplyOutcome::Ok,
            Some(vec![]),
            form_gen
        ))
        .is_ok()
    );
    assert!(out.try_send(super::Result::Stop(true)).is_ok());
    assert!(ui.poll());
    assert!(
        ui.error,
        "unrelated model/form/stop successes must not mask a failed permission action"
    );

    // Succeeding on the permissions lane clears permissions error.
    let perm_gen = ui.permissions_lane.generation;
    assert!(
        out.try_send(super::Result::ActPermission(true, Some(vec![]), perm_gen))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(!ui.error);

    // Reverse: failed model action must NOT be cleared by succeeding permission/form actions.
    assert!(
        out.try_send(super::Result::Act(false, ok_session(), None, 0))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.error);
    let perm_gen = ui.permissions_lane.generation;
    let form_gen = ui.forms_lane.generation;
    assert!(
        out.try_send(super::Result::ActPermission(true, Some(vec![]), perm_gen))
            .is_ok()
    );
    assert!(
        out.try_send(super::Result::ActForm(
            crate::agent_api::FormReplyOutcome::Ok,
            Some(vec![]),
            form_gen
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(
        ui.error,
        "permission/form success must not mask a failed model action"
    );

    // Catalog failure stays visible until catalog succeeds or refresh_controls resets all lanes.
    assert!(
        out.try_send(super::Result::Act(
            true,
            ok_session(),
            Some("/repo".into()),
            0
        ))
        .is_ok()
    );
    assert!(ui.poll());
    ui.refresh_catalog("/repo".into());
    let catalog_gen = ui.catalog_generation;
    assert!(
        out.try_send(super::Result::Catalog(None, "/repo".into(), catalog_gen))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.error);
    assert!(
        out.try_send(super::Result::Catalog(
            Some(vec![]),
            "/repo".into(),
            catalog_gen
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(!ui.error);
}
#[test]
fn native_questions_keep_typed_defaults_conditions_and_validation() {
    let form = Form {
        tool: None,
        infer_websearch: false,
        id: "form_one".into(),
        title: "Synthetic".into(),
        fields: vec![
            json!({"key":"choice","type":"boolean","default":false}),
            json!({"key":"detail","type":"string","required":true,"when":[{"key":"choice","op":"eq","value":true}]}),
            json!({"key":"count","type":"integer","minimum":1,"maximum":4,"required":true}),
            json!({"key":"hidden","type":"string","hidden":true,"default":"retained"}),
        ],
    };
    let mut drafts = Default::default();
    agent_forms::seed(&[form.clone()], &mut drafts);
    assert!(agent_forms::answer(&form, &drafts).is_err());
    drafts
        .get_mut(&(form.id.clone(), "count".into()))
        .unwrap()
        .edit = rune::edit::TextEdit::new("2");
    let answer = agent_forms::answer(&form, &drafts).unwrap();
    assert!(answer.get("detail").is_none());
    assert_eq!(answer["hidden"], "retained");
    drafts
        .get_mut(&(form.id.clone(), "choice".into()))
        .unwrap()
        .edit = rune::edit::TextEdit::new("true");
    assert!(
        agent_forms::answer(&form, &drafts).is_err(),
        "active required conditional field"
    );
    drafts
        .get_mut(&(form.id.clone(), "detail".into()))
        .unwrap()
        .edit = rune::edit::TextEdit::new("draft preserved");
    agent_forms::seed(&[form.clone()], &mut drafts);
    assert_eq!(
        agent_forms::answer(&form, &drafts).unwrap()["detail"],
        "draft preserved"
    );
    for invalid in ["1.5", "NaN", "Infinity", "5"] {
        let mut d = Draft::default();
        d.edit = rune::edit::TextEdit::new(invalid);
        assert!(agent_forms::value(&form.fields[2], &d).is_err())
    }
    let external = Form {
        fields: vec![json!({"key":"auth","type":"external","url":"https://example.invalid"})],
        ..form.clone()
    };
    assert!(!agent_forms::supported(&external));
    let poison = Form {
        fields: vec![json!({"key":"__proto__","type":"string"})],
        ..form
    };
    assert!(!agent_forms::supported(&poison));
}
#[test]
fn controls_reject_foreign_pending_and_strip_model_configuration() {
    let catalog = json!({"data":[{"id":"m","providerID":"p","name":"Name","enabled":true,"headers":{"Authorization":"never display"},"variants":[{"id":"fast"}]},{"id":"disabled","enabled":false}]});
    let models = agent_api::models(&catalog).unwrap();
    assert_eq!(models.len(), 2);
    assert!(!models[0].label.contains("never display"));
    assert_eq!(
        models[1].reference,
        json!({"id":"m","providerID":"p","variant":"fast"})
    );
    assert!(
        agent_api::permissions(
            &json!({"data":[{"id":"per_x","sessionID":"other","action":"read","resources":[]}]}),
            "ses_one"
        )
        .is_err()
    );
    assert!(agent_api::forms(&json!({"data":[{"id":"form_x","sessionID":"other","title":"Question","fields":[{"type":"string","key":"value"}]}]}),"ses_one").is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn stop_bypasses_blocked_catalogue_read_on_its_own_lane() {
    use crate::files::test_http::{Http, wait};
    use std::sync::Arc;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake_tx, wake_rx) = super::bounded::<()>(16);
        let wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut ui = super::Ui::new(super::start(http.backend.clone(), wake));
        ui.online = true;

        // Initial refresh(true) reads session + pending concurrently; once polled, catalog starts on its own lane.
        let (mut got_session, mut got_perm, mut got_form) = (false, false, false);
        while !got_session || !got_perm || !got_form {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
            {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":2,"idle":1}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
            {
                got_perm = true;
                req.reply(200, json!({"data":[]})).await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
            {
                got_form = true;
                req.reply(200, json!({"data":[]})).await;
            } else {
                panic!("unexpected initial request: {}", req.header);
            }
        }
        while !ui.known || !ui.pending_known {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        let held_model = http.accept().await;
        assert!(
            held_model
                .header
                .starts_with("GET /workspaces/owned/instance/api/model?"),
            "{}",
            held_model.header
        );

        // Trigger stop while GET /api/model is still held open without a response.
        ui.stop();
        assert!(ui.stopping);
        let interrupt = http.accept().await;
        assert!(
            interrupt
                .header
                .starts_with("POST /workspaces/owned/instance/api/session/session/interrupt "),
            "{}",
            interrupt.header
        );
        assert_eq!(interrupt.body, json!({"resume": false}));
        interrupt
            .reply(200, json!({"data":{"interrupted": true}}))
            .await;

        // Result::Stop must clear `stopping` and refresh session/pending even while GET /api/model remains blocked.
        while ui.stopping {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(!ui.stopping);
        assert!(!ui.error);

        let (mut got_session, mut got_perm, mut got_form) = (false, false, false);
        while !got_session || !got_perm || !got_form {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
            {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":2,"idle":3}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
            {
                got_perm = true;
                req.reply(200, json!({"data":[]})).await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
            {
                got_form = true;
                req.reply(200, json!({"data":[]})).await;
            } else {
                panic!("unexpected post-stop request: {}", req.header);
            }
        }
        while ui.running || ui.reading || ui.permissions_lane.reading || ui.forms_lane.reading {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(!ui.running);
        assert!(ui.models.is_empty());

        // Now release GET /api/model and verify the catalogue populates and Ui becomes idle.
        held_model
            .reply(
                200,
                json!({"data":[{"id":"m","providerID":"p","name":"Model","enabled":true}]}),
            )
            .await;
        while !ui.idle() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert_eq!(ui.models.len(), 1);
        assert!(!ui.error);
        assert!(!ui.running);
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn permission_and_form_reply_bypass_blocked_catalogue_read() {
    use crate::files::test_http::{Http, wait};
    use std::sync::Arc;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake_tx, wake_rx) = super::bounded::<()>(16);
        let wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut ui = super::Ui::new(super::start(http.backend.clone(), wake));
        ui.online = true;

        let perm_body = json!({"data":[{"id":"perm_1","sessionID":"session","action":"bash","resources":["git status"]}]});
        let form_body = json!({"data":[{"id":"form_1","sessionID":"session","title":"Confirm","fields":[{"type":"string","key":"value"}]}]});

        let (mut got_session, mut got_perm, mut got_form) = (false, false, false);
        while !got_session || !got_perm || !got_form {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
            {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":2,"idle":1}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
            {
                got_perm = true;
                req.reply(200, perm_body.clone()).await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
            {
                got_form = true;
                req.reply(200, form_body.clone()).await;
            } else {
                panic!("unexpected initial request: {}", req.header);
            }
        }
        while !ui.known || !ui.pending_known {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        let held_model = http.accept().await;
        assert!(
            held_model
                .header
                .starts_with("GET /workspaces/owned/instance/api/model?"),
            "{}",
            held_model.header
        );

        // Permissions and forms must be visible and unlocked while GET /api/model is still blocked.
        assert_eq!(ui.permissions.len(), 1);
        assert_eq!(ui.forms.len(), 1);
        assert!(!ui.permissions_locked());
        assert!(!ui.forms_locked());
        assert!(!ui.blocked());
        assert!(ui.models.is_empty());

        ui.reply_permission("perm_1".into(), "once");
        assert!(ui.permissions_lane.busy);
        assert!(
            ui.blocked(),
            "composer must stay blocked while a permission reply is in flight"
        );
        let check_perm = http.accept().await;
        assert!(
            check_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        check_perm.reply(200, perm_body).await;
        let reply_perm = http.accept().await;
        assert!(reply_perm.header.starts_with(
            "POST /workspaces/owned/instance/api/session/session/permission/perm_1/reply "
        ));
        assert_eq!(reply_perm.body, json!({"decision":"once","message":""}));
        reply_perm.reply(200, json!({"ok":true})).await;
        let refresh_perm = http.accept().await;
        assert!(
            refresh_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        refresh_perm.reply(200, json!({"data":[]})).await;
        while ui.permissions_lane.busy {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(ui.permissions.is_empty());
        assert_eq!(ui.forms.len(), 1);
        assert!(!ui.error);
        assert!(!ui.permissions_locked());
        assert!(!ui.forms_locked());
        assert!(!ui.blocked());

        ui.cancel_form("form_1".into());
        assert!(ui.forms_lane.busy);
        assert!(
            ui.blocked(),
            "composer must stay blocked while a form cancellation is in flight"
        );
        let check_form = http.accept().await;
        assert!(
            check_form
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
        );
        check_form.reply(200, form_body).await;
        let delete_form = http.accept().await;
        assert!(
            delete_form
                .header
                .starts_with("DELETE /workspaces/owned/instance/api/session/session/form/form_1 ")
        );
        delete_form.reply(200, json!({"ok":true})).await;
        let refresh_form = http.accept().await;
        assert!(
            refresh_form
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
        );
        refresh_form.reply(200, json!({"data":[]})).await;
        while ui.forms_lane.busy {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(ui.forms.is_empty());
        assert!(!ui.error);
        assert!(ui.models.is_empty());

        // Release GET /api/model after both replies already completed.
        held_model
            .reply(
                200,
                json!({"data":[{"id":"m","providerID":"p","name":"Model","enabled":true}]}),
            )
            .await;
        while !ui.idle() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert_eq!(ui.models.len(), 1);
        assert!(!ui.error);
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn rejected_form_reply_unlocks_draft_editing_before_followup_snapshot_finishes() {
    use crate::files::test_http::{Http, wait};
    use std::sync::Arc;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake_tx, wake_rx) = super::bounded::<()>(16);
        let wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut ui = super::Ui::new(super::start(http.backend.clone(), wake));
        ui.online = true;

        let form_body = json!({
            "data": [{
                "id": "form_1",
                "sessionID": "session",
                "title": "Code",
                "fields": [{
                    "type": "string",
                    "key": "code",
                    "required": true,
                    "pattern": "^[a-z]{257}$"
                }]
            }]
        });

        let (mut got_session, mut got_perm, mut got_form) = (false, false, false);
        while !got_session || !got_perm || !got_form {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
            {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":2,"idle":1}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
            {
                got_perm = true;
                req.reply(200, json!({"data":[]})).await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
            {
                got_form = true;
                req.reply(200, form_body.clone()).await;
            } else {
                panic!("unexpected initial request: {}", req.header);
            }
        }
        while !ui.known || !ui.pending_known {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        let model_req = http.accept().await;
        model_req.reply(200, json!({"data":[]})).await;
        while !ui.idle() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }

        ui.drafts
            .get_mut(&("form_1".into(), "code".into()))
            .unwrap()
            .edit
            .text = "bad".into();
        ui.answer_form("form_1");
        assert!(ui.forms_mutating());
        assert!(ui.forms_locked());

        let pre_check = http.accept().await;
        assert!(
            pre_check
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
        );
        pre_check.reply(200, form_body.clone()).await;

        let post_reply = http.accept().await;
        assert!(
            post_reply.header.starts_with(
                "POST /workspaces/owned/instance/api/session/session/form/form_1/reply "
            )
        );
        post_reply
            .reply(
                400,
                json!({"error":"Form field does not match pattern: code"}),
            )
            .await;

        // Hold the follow-up GET /form open while verifying the UI already unlocked draft editing.
        let held_refresh = http.accept().await;
        assert!(
            held_refresh
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
        );
        while ui.forms_mutating() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(
            !ui.forms_mutating(),
            "rejected POST must immediately unlock draft editing before follow-up GET finishes"
        );
        assert!(
            ui.forms_locked(),
            "Answer/Cancel must remain locked until follow-up GET finishes"
        );
        assert!(ui.error);
        assert_eq!(
            ui.drafts
                .get(&("form_1".into(), "code".into()))
                .unwrap()
                .server_rejected_value,
            Some(json!("bad"))
        );

        let fixed = "a".repeat(257);
        ui.drafts
            .get_mut(&("form_1".into(), "code".into()))
            .unwrap()
            .edit
            .text = fixed.clone();

        held_refresh.reply(200, form_body).await;
        while ui.forms_locked() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(!ui.forms_mutating());
        assert_eq!(
            ui.drafts
                .get(&("form_1".into(), "code".into()))
                .unwrap()
                .edit
                .text,
            fixed
        );
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn pending_requests_publish_and_accept_replies_while_session_read_stalls() {
    use crate::files::test_http::{Http, wait};
    use std::sync::Arc;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake_tx, wake_rx) = super::bounded::<()>(16);
        let wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut ui = super::Ui::new(super::start(http.backend.clone(), wake));
        ui.online = true;

        let perm_body = json!({"data":[{"id":"perm_1","sessionID":"session","action":"bash","resources":["git status"]}]});
        let mut held_session = None;
        let (mut got_perm, mut got_form) = (false, false);
        while held_session.is_none() || !got_perm || !got_form {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
            {
                held_session = Some(req);
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
            {
                got_perm = true;
                req.reply(200, perm_body.clone()).await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
            {
                got_form = true;
                req.reply(200, json!({"data":[]})).await;
            } else {
                panic!("unexpected initial request: {}", req.header);
            }
        }
        while !ui.pending_known {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        let held_session = held_session.unwrap();

        // Even while GET /session/session is still blocked, pending permissions are visible and answerable.
        assert!(!ui.known);
        assert_eq!(ui.permissions.len(), 1);
        assert!(!ui.permissions_locked());

        ui.reply_permission("perm_1".into(), "once");
        assert!(ui.permissions_lane.busy);
        let check_perm = http.accept().await;
        assert!(
            check_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        check_perm.reply(200, perm_body).await;
        let reply_perm = http.accept().await;
        assert!(reply_perm.header.starts_with(
            "POST /workspaces/owned/instance/api/session/session/permission/perm_1/reply "
        ));
        reply_perm.reply(200, json!({"ok":true})).await;
        let refresh_perm = http.accept().await;
        assert!(
            refresh_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        refresh_perm.reply(200, json!({"data":[]})).await;
        while ui.permissions_lane.busy {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(ui.permissions.is_empty());
        assert!(!ui.known);
        assert!(!ui.error);

        // Release GET /session/session, poll so catalog starts, then serve GET /api/model and confirm settlement.
        held_session
            .reply(
                200,
                json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":0,"idle":1}}}),
            )
            .await;
        while !ui.known {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        let model_req = http.accept().await;
        assert!(
            model_req
                .header
                .starts_with("GET /workspaces/owned/instance/api/model?")
        );
        model_req
            .reply(
                200,
                json!({"data":[{"id":"m","providerID":"p","name":"Model","enabled":true}]}),
            )
            .await;
        while !ui.idle() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(ui.known);
        assert_eq!(ui.models.len(), 1);
        assert!(!ui.error);
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn permission_publishes_and_accepts_reply_while_forms_read_stalls_or_fails() {
    use crate::files::test_http::{Http, wait};
    use std::sync::Arc;
    crate::platform::block_on(async {
        let http = Http::new().await;
        let (wake_tx, wake_rx) = super::bounded::<()>(16);
        let wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut ui = super::Ui::new(super::start(http.backend.clone(), wake));
        ui.online = true;

        let perm_one = json!({"data":[{"id":"perm_1","sessionID":"session","action":"bash","resources":["git status"]}]});
        let perm_two = json!({"data":[{"id":"perm_2","sessionID":"session","action":"bash","resources":["git diff"]}]});
        let mut held_form = None;
        let (mut got_session, mut got_perm) = (false, false);
        while !got_session || !got_perm || held_form.is_none() {
            let req = http.accept().await;
            if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session ")
            {
                got_session = true;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":0,"idle":1}}}),
                )
                .await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
            {
                got_perm = true;
                req.reply(200, perm_one.clone()).await;
            } else if req
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/form ")
            {
                held_form = Some(req);
            } else {
                panic!("unexpected initial request: {}", req.header);
            }
        }
        while !ui.known || !ui.permissions_lane.known {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        let held_form = held_form.unwrap();
        let model_req = http.accept().await;
        assert!(
            model_req
                .header
                .starts_with("GET /workspaces/owned/instance/api/model?")
        );
        model_req.reply(200, json!({"data":[]})).await;

        // Part 1: WHILE GET /form is still stalled, perm_1 is visible and immediately answerable.
        assert_eq!(ui.permissions.len(), 1);
        assert!(!ui.permissions_locked());
        assert!(ui.forms_locked());
        ui.reply_permission("perm_1".into(), "once");
        assert!(ui.permissions_lane.busy);
        let check_perm = http.accept().await;
        assert!(
            check_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        check_perm.reply(200, perm_one).await;
        let reply_perm = http.accept().await;
        assert!(reply_perm.header.starts_with(
            "POST /workspaces/owned/instance/api/session/session/permission/perm_1/reply "
        ));
        reply_perm.reply(200, json!({"ok":true})).await;
        let refresh_perm = http.accept().await;
        assert!(
            refresh_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        refresh_perm.reply(200, perm_two.clone()).await;
        while ui.permissions_lane.busy {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert_eq!(ui.permissions.len(), 1);
        assert_eq!(ui.permissions[0].id, "perm_2");

        // Part 2: GET /form FAILS with 500 -> forms remain locked and error=true,
        // yet perm_2 remains unlocked and answerable without waiting on forms!
        held_form.reply(500, json!({"error":"forms down"})).await;
        while ui.forms_lane.reading || ui.catalog_reading {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(!ui.forms_lane.known);
        assert!(ui.forms_locked());
        assert!(ui.error);
        assert!(!ui.permissions_locked());

        ui.reply_permission("perm_2".into(), "once");
        assert!(ui.permissions_lane.busy);
        let check_perm = http.accept().await;
        assert!(
            check_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        check_perm.reply(200, perm_two).await;
        let reply_perm = http.accept().await;
        assert!(reply_perm.header.starts_with(
            "POST /workspaces/owned/instance/api/session/session/permission/perm_2/reply "
        ));
        reply_perm.reply(200, json!({"ok":true})).await;
        let refresh_perm = http.accept().await;
        assert!(
            refresh_perm
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session/permission ")
        );
        refresh_perm.reply(200, json!({"data":[]})).await;
        while !ui.idle() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(ui.permissions.is_empty());
        assert!(
            ui.error,
            "forms failure remains visible while permissions succeeded"
        );
    });
}

#[test]
fn permission_events_never_invalidate_or_starve_in_flight_forms_read() {
    let (jobs, _jobs_rx) = super::bounded(4);
    let (permissions, perm_rx) = super::bounded(4);
    let (forms, form_rx) = super::bounded(4);
    let (catalog, _catalog_rx) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut agent = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: None,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    agent.online = true;
    assert!(matches!(perm_rx.try_recv(), Ok(super::PendingJob::Read(1))));
    assert!(matches!(form_rx.try_recv(), Ok(super::PendingJob::Read(1))));
    let initial_form_gen = agent.forms_lane.generation;

    let mut s = crate::init();
    s.agent = Some(agent);
    let (events, inbox) = super::bounded(8);
    s.incoming = Some(inbox);

    // Burst of permission SSE events arrives while GET /form (gen 1) is still in flight.
    events
        .try_send(crate::transport::Event::Workspace(
            codenomad_client::transport::WorkspaceEvent::SessionRequest {
                form: false,
                id: "perm_1".into(),
            },
        ))
        .unwrap();
    events
        .try_send(crate::transport::Event::AgentControl(
            codenomad_client::transport::AgentLane::Permissions,
        ))
        .unwrap();
    events
        .try_send(crate::transport::Event::Workspace(
            codenomad_client::transport::WorkspaceEvent::SessionRequestResolved {
                form: false,
                id: "perm_1".into(),
            },
        ))
        .unwrap();
    assert!(crate::poll_chat(&mut s, 8));
    let agent = s.agent.as_ref().unwrap();
    assert_eq!(
        agent.forms_lane.generation, initial_form_gen,
        "permission events must never bump or invalidate the forms lane"
    );
    assert!(
        !agent.forms_lane.trailing,
        "permission events must not queue redundant form reads"
    );
    assert!(
        agent.permissions_lane.generation > 1,
        "permission events must still advance the permissions lane"
    );

    // The slow initial GET /form response returns and unlocks forms immediately.
    out.try_send(super::Result::Forms(
        Some(vec![Form {
            id: "form_1".into(),
            title: "Question".into(),
            fields: vec![],
            tool: None,
            infer_websearch: false,
        }]),
        initial_form_gen,
    ))
    .unwrap();
    assert!(crate::poll_chat(&mut s, 8));
    let agent = s.agent.as_ref().unwrap();
    assert!(agent.forms_lane.known);
    assert!(!agent.forms_locked());
    assert_eq!(agent.forms.len(), 1);
    assert_eq!(agent.forms[0].id, "form_1");
    assert!(
        form_rx.try_recv().is_err(),
        "no extra GET /form may be dispatched from permission traffic"
    );

    // Symmetric check: form events must not bump the permissions lane generation.
    let perm_gen_before = agent.permissions_lane.generation;
    events
        .try_send(crate::transport::Event::AgentControl(
            codenomad_client::transport::AgentLane::Forms,
        ))
        .unwrap();
    assert!(crate::poll_chat(&mut s, 8));
    let agent = s.agent.as_ref().unwrap();
    assert_eq!(agent.permissions_lane.generation, perm_gen_before);
    assert!(agent.forms_lane.generation > initial_form_gen);
}

#[test]
fn same_tick_http_result_and_sse_resolution_cancels_notification_before_delivery() {
    use crate::agent_api::Permission;
    use crate::shell::notifications::{self, Target};
    let (jobs, _jobs_rx) = super::bounded(4);
    let (permissions, _perm_rx) = super::bounded(4);
    let (forms, _form_rx) = super::bounded(4);
    let (catalog, _catalog_rx) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut agent = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: None,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    agent.online = true;
    // Root session is already known so HTTP permission results qualify notifications immediately.
    agent.attention.observe_session(true, Some("/project"));
    agent.attention.request(false, "perm_settled".into());
    let perm_gen = agent.permissions_lane.generation;

    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    s.chat_title = "Direct session".into();
    s.agent = Some(agent);
    let (events, inbox) = super::bounded(8);
    s.incoming = Some(inbox);
    s.notifications.record();
    let target = Target {
        tab: Some("tab-0".into()),
        backend_url: "http://127.0.0.1:9/".into(),
        server: None,
        occurrence: 0,
        workspace: "project".into(),
        session: "session".into(),
    };
    let mut runtime =
        rune::Runtime::new(s, crate::view, (960.0, 760.0), rune::Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.window_focus(false);
    runtime.frame(0.02);
    runtime.update(|s, _| {
        let perm = |id: &str| Permission {
            id: id.into(),
            action: "bash".into(),
            resources: vec![],
            message: String::new(),
            supported: true,
            tool: None,
        };
        // Case 1: Pre-resolution HTTP snapshot AND SSE resolution wait in the SAME tick.
        out.try_send(super::Result::Permissions(
            Some(vec![perm("perm_settled")]),
            perm_gen,
        ))
        .unwrap();
        events
            .try_send(crate::transport::Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::SessionRequestResolved {
                    form: false,
                    id: "perm_settled".into(),
                },
            ))
            .unwrap();
        assert!(crate::poll_chat(s, 8));
        notifications::collect(s, |_| Some((target.clone(), "Private project".into())));
        assert!(
            s.notifications.recorded().is_empty(),
            "permission resolved in the same tick must never deliver a stale notification"
        );

        // Case 2: Two permissions in the same HTTP snapshot, only one resolved in the same tick ->
        // the settled permission is cancelled while the still-active permission still notifies.
        let agent = s.agent.as_mut().unwrap();
        let next_gen = agent.permissions_lane.generation;
        agent.attention.request(false, "perm_settled_2".into());
        agent.attention.request(false, "perm_active".into());
        out.try_send(super::Result::Permissions(
            Some(vec![perm("perm_settled_2"), perm("perm_active")]),
            next_gen,
        ))
        .unwrap();
        events
            .try_send(crate::transport::Event::Workspace(
                codenomad_client::transport::WorkspaceEvent::SessionRequestResolved {
                    form: false,
                    id: "perm_settled_2".into(),
                },
            ))
            .unwrap();
        assert!(crate::poll_chat(s, 8));
        notifications::collect(s, |_| Some((target.clone(), "Private project".into())));
        assert_eq!(
            s.notifications.recorded().len(),
            1,
            "only the still-active permission must deliver its notification"
        );
    });
}

#[test]
fn stale_catalog_response_for_previous_directory_or_generation_is_discarded() {
    let (jobs, _jobs_rx) = super::bounded(4);
    let (permissions, _perm_rx) = super::bounded(4);
    let (forms, _form_rx) = super::bounded(4);
    let (catalog, catalog_rx) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: None,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    let model = |id: &str| super::Model {
        reference: json!({"id": id, "providerID": "p"}),
        label: id.into(),
        included: false,
    };

    ui.refresh_catalog("/repo-a".into());
    let (dir_a, gen_a) = catalog_rx.try_recv().unwrap();
    assert_eq!(dir_a, "/repo-a");
    // A newer directory refresh starts while /repo-a is still in flight.
    ui.refresh_catalog("/repo-b".into());
    let gen_b = ui.catalog_generation;
    assert_ne!(gen_a, gen_b);

    // Late response for /repo-a (stale generation and directory) must be ignored completely.
    out.try_send(super::Result::Catalog(
        Some(vec![model("stale-model")]),
        "/repo-a".into(),
        gen_a,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(ui.models.is_empty());
    assert!(!ui.error);

    // The trailing /repo-b read was dispatched with gen_b; its response publishes cleanly.
    let (dir_b, dispatched_gen) = catalog_rx.try_recv().unwrap();
    assert_eq!(dir_b, "/repo-b");
    assert_eq!(dispatched_gen, gen_b);
    out.try_send(super::Result::Catalog(
        Some(vec![model("fresh-model")]),
        "/repo-b".into(),
        gen_b,
    ))
    .unwrap();
    assert!(ui.poll());
    assert_eq!(ui.models.len(), 1);
    assert_eq!(ui.models[0].label, "fresh-model");
    assert!(!ui.error);
}

#[test]
fn directory_change_via_session_or_action_clears_old_models_and_fetches_new_catalog() {
    let (jobs, jobs_rx) = super::bounded(4);
    let (permissions, _perm_rx) = super::bounded(4);
    let (forms, _form_rx) = super::bounded(4);
    let (catalog, catalog_rx) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: None,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    ui.online = true;
    let _ = jobs_rx.try_recv();
    let model = |id: &str| super::Model {
        reference: json!({"id": id, "providerID": "p"}),
        label: id.into(),
        included: false,
    };
    let snap = |dir: &str| agent_api::Snapshot {
        models: None,
        current: None,
        directory: Some(dir.into()),
        root_directory: Some(dir.into()),
        usage: None,
        session_known: true,
        running: false,
        permissions: None,
        forms: None,
    };

    // Initial session + catalog for /repo-a.
    out.try_send(super::Result::Session(
        snap("/repo-a"),
        Some("/repo-a".into()),
        true,
        0,
    ))
    .unwrap();
    assert!(ui.poll());
    let (dir_a, gen_a) = catalog_rx.try_recv().unwrap();
    assert_eq!(dir_a, "/repo-a");
    assert!(ui.model_locked());
    out.try_send(super::Result::Catalog(
        Some(vec![model("model-a")]),
        "/repo-a".into(),
        gen_a,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.model_locked());
    assert_eq!(ui.models.len(), 1);

    // Ordinary non-catalog Session response discovers directory changed to /repo-b:
    // old models clear immediately, model picker locks, and /repo-b catalog is fetched automatically.
    out.try_send(super::Result::Session(
        snap("/repo-b"),
        Some("/repo-b".into()),
        false,
        0,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(ui.models.is_empty());
    assert!(ui.model_locked());
    let (dir_b, gen_b) = catalog_rx.try_recv().unwrap();
    assert_eq!(dir_b, "/repo-b");
    // Stale /repo-a catalog cannot overwrite /repo-b.
    out.try_send(super::Result::Catalog(
        Some(vec![model("stale-a")]),
        "/repo-a".into(),
        gen_a,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(ui.models.is_empty());
    assert!(ui.model_locked());
    // Choosing old model-a is rejected before dispatch.
    ui.choose_model(json!({"id": "model-a", "providerID": "p"}));
    assert!(jobs_rx.try_recv().is_err());

    // /repo-b catalog arrives and unlocks.
    out.try_send(super::Result::Catalog(
        Some(vec![model("model-b")]),
        "/repo-b".into(),
        gen_b,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.model_locked());
    assert_eq!(ui.models[0].label, "model-b");

    // Action result discovers directory changed to /repo-c: clears /repo-b and dispatches /repo-c catalog.
    out.try_send(super::Result::Act(
        true,
        snap("/repo-c"),
        Some("/repo-c".into()),
        0,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(ui.models.is_empty());
    assert!(ui.model_locked());
    let (dir_c, gen_c) = catalog_rx.try_recv().unwrap();
    assert_eq!(dir_c, "/repo-c");
    out.try_send(super::Result::Catalog(
        Some(vec![model("model-c")]),
        "/repo-c".into(),
        gen_c,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.model_locked());
    assert_eq!(ui.models[0].label, "model-c");

    // Rebinding clears previously published models immediately so old binding's rows cannot be picked.
    let (jobs2, _) = super::bounded(4);
    let (stop2, _) = super::bounded(1);
    let (_, results2) = super::bounded(4);
    ui.rebind(super::Handle::test(jobs2, stop2, results2));
    assert!(ui.models.is_empty());
    assert!(ui.model_locked());
}

#[test]
fn composer_stays_blocked_until_reconciliation_read_after_superseded_pending_reply() {
    use crate::agent_api::Permission;
    let (jobs, _jobs_rx) = super::bounded(4);
    let (permissions, perm_rx) = super::bounded(4);
    let (forms, form_rx) = super::bounded(4);
    let (catalog, _catalog_rx) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: None,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    ui.online = true;
    ui.known = true;
    ui.reading = false;
    let _ = perm_rx.try_recv();
    let _ = form_rx.try_recv();
    let initial_perm_gen = ui.permissions_lane.generation;
    out.try_send(super::Result::Permissions(
        Some(vec![Permission {
            id: "perm_1".into(),
            action: "bash".into(),
            resources: vec![],
            message: String::new(),
            supported: true,
            tool: None,
        }]),
        initial_perm_gen,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.blocked());

    // Passive refresh_permissions does NOT block the composer.
    ui.refresh_permissions();
    assert!(!ui.blocked());
    let passive_gen = match perm_rx.try_recv().unwrap() {
        super::PendingJob::Read(generation) => generation,
        _ => panic!("expected passive permission read"),
    };
    out.try_send(super::Result::Permissions(
        Some(vec![Permission {
            id: "perm_1".into(),
            action: "bash".into(),
            resources: vec![],
            message: String::new(),
            supported: true,
            tool: None,
        }]),
        passive_gen,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.blocked());

    // 1. User replies to perm_1 -> POST starts, composer is blocked.
    ui.reply_permission("perm_1".into(), "once");
    assert!(ui.blocked());
    let act_gen = match perm_rx.try_recv().unwrap() {
        super::PendingJob::Act(_, generation) => generation,
        _ => panic!("expected permission act"),
    };

    // 2. SSE resolution arrives BEFORE the worker's post-POST HTTP response finishes.
    ui.resolve_request(false, "perm_1");
    let reconcile_gen = ui.permissions_lane.generation;
    assert_ne!(reconcile_gen, act_gen);
    assert!(ui.blocked());

    // 3. Worker's post-POST HTTP result returns with superseded act_gen: dock still shows perm_1
    // while the trailing reconciliation read is dispatched -> composer MUST stay blocked!
    out.try_send(super::Result::ActPermission(true, Some(vec![]), act_gen))
        .unwrap();
    assert!(ui.poll());
    assert_eq!(ui.permissions.len(), 1);
    assert!(
        ui.blocked(),
        "composer must stay blocked while awaiting reconciliation read after superseded reply"
    );
    assert!(ui.navigation_blocked());
    assert!(matches!(
        perm_rx.try_recv(),
        Ok(super::PendingJob::Read(generation)) if generation == reconcile_gen
    ));

    // 4. If the reconciliation read fails, composer & navigation stay blocked and the reply
    // button stays locked; user retries via refresh_controls (read only, never replaying POST).
    out.try_send(super::Result::Permissions(None, reconcile_gen))
        .unwrap();
    assert!(ui.poll());
    assert_eq!(ui.permissions.len(), 1);
    assert!(ui.error);
    assert!(
        ui.blocked(),
        "failed reconciliation read must keep composer blocked until a valid read settles the dock"
    );
    assert!(ui.navigation_blocked());
    assert!(ui.permissions_locked());

    ui.refresh_controls();
    let retry_gen = match perm_rx.try_recv().unwrap() {
        super::PendingJob::Read(generation) => generation,
        _ => panic!("refresh_controls must retry with a read, never replaying the reply"),
    };
    out.try_send(super::Result::Permissions(Some(vec![]), retry_gen))
        .unwrap();
    assert!(ui.poll());
    assert!(ui.permissions.is_empty());
    assert!(!ui.blocked());
    assert!(!ui.navigation_blocked());
}

#[test]
fn uncertain_reply_failure_without_sse_keeps_lock_until_read_and_unblocks_on_missing_scope() {
    use crate::agent_api::{Form, Permission};
    let (jobs, jobs_rx) = super::bounded(4);
    let (permissions, perm_rx) = super::bounded(4);
    let (forms, form_rx) = super::bounded(4);
    let (catalog, _catalog_rx) = super::bounded(4);
    let (stop, _) = super::bounded(1);
    let (out, results) = super::bounded(8);
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        workspace_id: Some("ws_dead".into()),
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    });
    ui.online = true;
    ui.known = true;
    ui.reading = false;
    let _ = perm_rx.try_recv();
    let _ = form_rx.try_recv();
    let perm_gen = ui.permissions_lane.generation;
    let form_gen = ui.forms_lane.generation;
    out.try_send(super::Result::Permissions(
        Some(vec![Permission {
            id: "perm_1".into(),
            action: "bash".into(),
            resources: vec![],
            message: String::new(),
            supported: true,
            tool: None,
        }]),
        perm_gen,
    ))
    .unwrap();
    out.try_send(super::Result::Forms(
        Some(vec![Form {
            id: "form_1".into(),
            title: String::new(),
            fields: vec![],
            tool: None,
            infer_websearch: false,
        }]),
        form_gen,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.blocked());
    assert!(!ui.navigation_blocked());

    // 1. Uncertain permission POST timeout (ok=false) + failed follow-up GET (None), no SSE:
    //    must keep composer blocked, reply locked, and navigation blocked until a valid read.
    ui.reply_permission("perm_1".into(), "once");
    let act_gen = match perm_rx.try_recv().unwrap() {
        super::PendingJob::Act(_, generation) => generation,
        _ => panic!("expected permission act"),
    };
    out.try_send(super::Result::ActPermission(false, None, act_gen))
        .unwrap();
    assert!(ui.poll());
    assert!(ui.error);
    assert!(ui.blocked());
    assert!(ui.navigation_blocked());
    assert!(ui.permissions_locked());

    ui.refresh_controls();
    let retry_perm_gen = match perm_rx.try_recv().unwrap() {
        super::PendingJob::Read(generation) => generation,
        _ => panic!("expected read-only retry on permission lane"),
    };
    let retry_form_gen = match form_rx.try_recv().unwrap() {
        super::PendingJob::Read(generation) => generation,
        _ => panic!("expected read-only retry on form lane"),
    };
    out.try_send(super::Result::Permissions(Some(vec![]), retry_perm_gen))
        .unwrap();
    out.try_send(super::Result::Forms(
        Some(vec![Form {
            id: "form_1".into(),
            title: String::new(),
            fields: vec![],
            tool: None,
            infer_websearch: false,
        }]),
        retry_form_gen,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(!ui.blocked());
    assert!(!ui.navigation_blocked());

    // 2. Uncertain form cancel (ok=false, None) with dirty draft and typed reason, then
    //    workspace disappears: navigation must unblock so the dead tab can close, while
    //    composer/model/reply locks remain active even if late online/read results arrive.
    let mut draft = crate::agent_forms::Draft::default();
    draft.choose("typed answer");
    ui.drafts.insert(("form_1".into(), "q0".into()), draft);
    ui.reasons
        .insert("perm_1".into(), rune::edit::TextEdit::new("typed reason"));
    ui.cancel_form("form_1".into());
    let form_act_gen = match form_rx.try_recv().unwrap() {
        super::PendingJob::Act(_, generation) => generation,
        _ => panic!("expected form cancel act"),
    };
    out.try_send(super::Result::ActForm(
        crate::agent_api::FormReplyOutcome::Failed,
        None,
        form_act_gen,
    ))
    .unwrap();
    assert!(ui.poll());
    assert!(ui.blocked());
    assert!(ui.navigation_blocked());
    assert!(ui.forms_locked());

    assert!(!ui.workspace_stopped("ws_other"));
    assert!(ui.navigation_blocked());
    assert!(ui.workspace_stopped("ws_dead"));
    assert!(ui.is_scope_missing());
    assert!(
        !ui.navigation_blocked(),
        "missing workspace must release tab-close/navigation lock even with dirty drafts or reasons"
    );
    assert!(ui.blocked());
    assert!(ui.model_locked());
    assert!(ui.permissions_locked());
    assert!(ui.forms_locked());

    // Late post-mutation failures, valid reads, stop failures, or online flips arriving after
    // workspace_stopped must neither set errors, dispatch VerifyIdle/reads, re-arm
    // navigation_blocked, nor unlock composer/model/reply controls.
    while jobs_rx.try_recv().is_ok() {}
    ui.online = true;
    ui.attention.observe_session(true, Some("/repo"));
    ui.attention.execution(Some("idle_1".into()));
    out.try_send(super::Result::ActPermission(false, None, act_gen))
        .unwrap();
    out.try_send(super::Result::ActForm(
        crate::agent_api::FormReplyOutcome::Failed,
        None,
        form_act_gen,
    ))
    .unwrap();
    out.try_send(super::Result::Stop(false)).unwrap();
    out.try_send(super::Result::Session(
        super::Snapshot {
            models: None,
            current: None,
            directory: Some("/repo".into()),
            root_directory: Some("/repo".into()),
            usage: None,
            session_known: true,
            running: false,
            permissions: None,
            forms: None,
        },
        Some("/repo".into()),
        false,
        0,
    ))
    .unwrap();
    let perm_gen_now = ui.permissions_lane.generation;
    let form_gen_now = ui.forms_lane.generation;
    out.try_send(super::Result::Permissions(Some(vec![]), perm_gen_now))
        .unwrap();
    out.try_send(super::Result::Forms(Some(vec![]), form_gen_now))
        .unwrap();
    assert!(ui.poll());
    assert!(!ui.error);
    assert!(!ui.known);
    assert!(!ui.pending_known);
    assert!(jobs_rx.try_recv().is_err());
    assert!(!ui.navigation_blocked());
    assert!(ui.blocked());
    assert!(ui.model_locked());
    assert!(ui.permissions_locked());
    assert!(ui.forms_locked());
}
