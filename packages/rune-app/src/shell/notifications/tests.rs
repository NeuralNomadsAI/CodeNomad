use super::*;
use serde_json::json;

#[test]
fn notice_waits_for_the_confirmed_route_instead_of_claiming_delivery_early() {
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    s.notifications.record();
    s.notifications.focused = false;
    let target = Target {
        tab: None,
        backend_url: "http://127.0.0.1:9/".into(),
        server: None,
        occurrence: 0,
        workspace: "workspace".into(),
        session: "session".into(),
    };
    crate::settings::invalidate(&s, codenomad_client::settings::Owner::Config);
    for _ in 0..2 {
        deliver(
            &mut s,
            Notice {
                target: target.clone(),
                category: Category::NeedsInput,
                id: "1:question".into(),
                project: "Private project".into(),
                label: "Conversation".into(),
            },
        );
    }
    assert_eq!(s.notifications.deferred.len(), 1);
    assert!(s.notifications.delivered.is_empty());
    assert!(s.notifications.recorded().is_empty());
    crate::settings::notification_fixture(&s);
    let notice = s.notifications.deferred.pop_front().unwrap();
    deliver(&mut s, notice);
    assert_eq!(s.notifications.recorded().len(), 1);
}

#[test]
fn system_delivery_requires_confirmed_routing_and_the_focus_override() {
    let defaults = json!({});
    let allow = json!({"settings":{"osNotificationsAllowWhenVisible":true}});
    let disabled = json!({"settings":{"notificationRouting":{"needsInput":{"system":false}}}});
    assert!(!system_allowed(None, Category::NeedsInput, false));
    assert!(!system_allowed(
        Some(&disabled),
        Category::NeedsInput,
        false
    ));
    assert!(!system_allowed(Some(&defaults), Category::NeedsInput, true));
    assert!(system_allowed(Some(&defaults), Category::NeedsInput, false));
    assert!(system_allowed(Some(&allow), Category::SessionDone, true));
}

#[test]
fn notification_observation_requires_a_root_and_a_new_confirmed_idle() {
    use crate::agent_api::Form;
    let mut attention = Attention::default();
    let mut snapshot = Snapshot {
        models: None,
        current: None,
        session_known: true,
        running: false,
        root_directory: None,
        usage: None,
        permissions: None,
        forms: Some(vec![Form {
            id: "form-1".into(),
            title: "Question".into(),
            fields: vec![],
        }]),
    };
    attention.observe(&snapshot, true);
    assert!(attention.pending.is_empty());
    snapshot.root_directory = Some("/checkout".into());
    attention.observe(&snapshot, true);
    assert!(
        attention.pending.is_empty(),
        "revisiting does not announce existing requests"
    );
    attention.request(true, "form-1".into());
    attention.observe(&snapshot, true);
    attention.observe(&snapshot, true);
    assert_eq!(attention.pending.len(), 1);
    attention.execution(Some("done".into()));
    assert_eq!(
        attention.verify_idle(),
        Some(("done".into(), "/checkout".into()))
    );
    assert!(attention.verify_idle().is_none());
    attention.execution(None);
    attention.confirm_idle("done".into(), true);
    assert_eq!(attention.pending.len(), 1);
    attention.execution(Some("next".into()));
    attention.confirm_idle("next".into(), true);
    assert!(matches!(
        attention.pending.as_slice(),
        [(Category::NeedsInput, _), (Category::SessionDone, _)]
    ));
}
