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
    let mut agent = super::Ui::new(super::Handle {
        connection: None,
        jobs,
        stop,
        results,
    });
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
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        jobs,
        stop,
        results,
    });
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
    let mut ui = Ui::new(Handle {
        connection: None,
        jobs,
        stop,
        results,
    });
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
    let (stop, _) = super::bounded(1);
    let (_, results) = super::bounded(1);
    let mut ui = super::Ui::new(super::Handle {
        connection: None,
        jobs,
        stop,
        results,
    });
    let _ = incoming.try_recv();
    ui.reading = false;
    ui.pending_known = true;
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
    assert!(!ui.busy);
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
        let (wake_tx, wake_rx) = super::bounded::<()>(8);
        let wake = Arc::new(move || {
            let _ = wake_tx.try_send(());
        });
        let mut ui = super::Ui::new(super::start(http.backend.clone(), wake));
        ui.online = true;

        // Initial refresh(true) reads session, then blocks GET /api/model until explicitly released.
        let session = http.accept().await;
        assert!(
            session
                .header
                .starts_with("GET /workspaces/owned/instance/api/session/session "),
            "{}",
            session.header
        );
        session
            .reply(
                200,
                json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":2,"idle":1}}}),
            )
            .await;

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

        // Result::Stop must clear `stopping` cleanly even while GET /api/model remains blocked.
        while ui.stopping {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert!(!ui.stopping);
        assert!(!ui.error);

        // Now release GET /api/model and let the in-flight snapshot finish, then drive the
        // trailing refresh(false) queued by Result::Stop.
        held_model
            .reply(
                200,
                json!({"data":[{"id":"m","providerID":"p","name":"Model","enabled":true}]}),
            )
            .await;
        for prefix in [
            "GET /workspaces/owned/instance/api/session/session/permission ",
            "GET /workspaces/owned/instance/api/session/session/form ",
        ] {
            let req = http.accept().await;
            assert!(
                req.header.starts_with(prefix),
                "expected {prefix}, got {}",
                req.header
            );
            req.reply(200, json!({"data":[]})).await;
        }
        while ui.models.is_empty() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        for prefix in [
            "GET /workspaces/owned/instance/api/session/session ",
            "GET /workspaces/owned/instance/api/session/session/permission ",
            "GET /workspaces/owned/instance/api/session/session/form ",
        ] {
            let req = http.accept().await;
            assert!(
                req.header.starts_with(prefix),
                "expected {prefix}, got {}",
                req.header
            );
            let body = if prefix.ends_with("session ") {
                json!({"data":{"id":"session","location":{"directory":"/private"},"time":{"busy":2,"idle":3}}})
            } else {
                json!({"data":[]})
            };
            req.reply(200, body).await;
        }
        while !ui.idle() {
            wait(wake_rx.recv()).await.unwrap();
            ui.poll();
        }
        assert_eq!(ui.models.len(), 1);
        assert!(!ui.error);
        assert!(!ui.running);
    });
}
