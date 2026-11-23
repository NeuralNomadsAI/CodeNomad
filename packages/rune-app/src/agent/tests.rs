use crate::{
    agent_api::{self, Form},
    agent_forms::{self, Draft},
};
use serde_json::json;

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
        directory: None,
        session_known: true,
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
