use super::*;
use serde_json::json;

#[test]
fn every_generic_category_uses_its_own_confirmed_system_route() {
    let categories = [
        Category::Updates,
        Category::Files,
        Category::Projects,
        Category::Sessions,
        Category::Opencode,
        Category::Copy,
        Category::Settings,
    ];
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    s.notifications.record();
    s.notifications.focused = false;
    for enabled in categories {
        let mut routing = serde_json::Map::new();
        for category in categories {
            routing.insert(category.key().into(), json!({"system":category == enabled}));
        }
        crate::settings::notification_test_config(
            &s,
            json!({"settings":{"notificationRouting":routing}}),
        );
        let prior = s.notifications.recorded().len();
        for category in categories {
            emit(&mut s, category, None, category.key());
        }
        messages::poll(&mut s);
        assert_eq!(s.notifications.recorded().len(), prior + 1);
        assert_eq!(s.notifications.recorded()[prior].2, enabled.key());
    }
    s.notifications.focused = true;
    emit(&mut s, Category::Settings, None, "Focused");
    messages::poll(&mut s);
    assert_eq!(s.notifications.recorded().len(), categories.len());
}

#[test]
fn the_same_native_event_notifies_once_per_window_even_after_its_first_tab_closes() {
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    s.notifications.record();
    s.notifications.focused = false;
    let target = Target {
        tab: Some("first".into()),
        backend_url: "http://127.0.0.1:9/".into(),
        server: None,
        occurrence: 3,
        workspace: "one".into(),
        session: "ses_root".into(),
    };
    let publish = |s: &mut State, target| {
        deliver(
            s,
            Notice {
                target,
                category: Category::NeedsInput,
                id: "1:form-1".into(),
                project: "Private project".into(),
                label: "Conversation".into(),
            },
        )
    };
    publish(&mut s, target.clone());
    s.notifications.forget_tab("first");
    publish(
        &mut s,
        Target {
            tab: Some("second".into()),
            occurrence: 4,
            workspace: "two".into(),
            ..target.clone()
        },
    );
    assert_eq!(s.notifications.recorded().len(), 1);
    let mut other = crate::init();
    crate::settings::notification_fixture(&other);
    other.notifications.record();
    other.notifications.focused = false;
    publish(&mut other, target);
    assert_eq!(other.notifications.recorded().len(), 1);
}

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
