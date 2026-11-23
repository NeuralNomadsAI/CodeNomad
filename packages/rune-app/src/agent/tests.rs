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
    assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(true))));
    let snapshot = || agent_api::Snapshot {
        models: Some(vec![]),
        current: None,
        session_known: true,
        running: false,
        root_directory: Some("/project/worktree".into()),
        permissions: Some(vec![]),
        forms: Some(vec![Form {
            id: "question".into(),
            title: "A question".into(),
            fields: vec![],
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
            assert!(out.try_send(super::Result::Read(snapshot(), false)).is_ok());
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
        assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(false))));
        assert!(out.try_send(super::Result::Read(snapshot(), false)).is_ok());
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
    assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(true))));
    ui.known = true;
    ui.observe_running(false);
    let snapshot = |forms| agent_api::Snapshot {
        models: Some(vec![]),
        current: None,
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
                id: "form_pending".into(),
                title: "Pending question".into(),
                fields: vec![],
            }]),
            true
        ))
        .is_ok()
    );
    assert!(ui.poll());
    assert!(!ui.running);
    assert_eq!(ui.selected, "form_pending");
    ui.refresh(false);
    assert!(matches!(incoming.try_recv(), Ok(super::Job::Read(false))));
    assert!(
        out.try_send(super::Result::Read(snapshot(vec![]), false))
            .is_ok()
    );
    assert!(ui.poll());
    assert!(ui.running);
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
        Ok(super::Job::Act(agent_api::Action::Model(_)))
    ));
    assert!(ui.busy);
    assert!(!ui.picker);
}
#[test]
fn native_questions_keep_typed_defaults_conditions_and_validation() {
    let form = Form {
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
