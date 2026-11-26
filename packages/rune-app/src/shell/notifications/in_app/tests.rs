use super::*;

#[test]
fn an_error_on_the_current_connection_is_visible_without_confirmed_settings() {
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    crate::settings::notification_test_config(&s, None);
    s.notifications.record();
    s.notifications.focused = false;
    super::super::emit_outcome(
        &mut s,
        super::super::Category::Settings,
        None,
        "Write failed",
        true,
    );
    super::super::messages::poll(&mut s);
    assert_eq!(s.notifications.in_app.unread(), 1);
    assert_eq!(s.notifications.in_app.bubbles.len(), 1);
    assert!(s.notifications.recorded().is_empty());
}

#[test]
fn the_bell_opens_history_from_the_keyboard_without_sending_a_system_notice() {
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    crate::settings::notification_test_config(
        &s,
        serde_json::json!({"settings":{"notificationRouting":{
            "settings":{"screen":false,"history":false,"system":false}
        }}}),
    );
    s.notifications.record();
    super::super::emit_outcome(
        &mut s,
        super::super::Category::Settings,
        None,
        "Recorded failure",
        true,
    );
    super::super::messages::poll(&mut s);
    assert!(s.notifications.recorded().is_empty());
    assert_eq!(s.notifications.in_app.unread(), 1);
    assert_eq!(s.notifications.in_app.bubbles.len(), 1);
    let mut runtime =
        rune::Runtime::new(s, crate::view, (900.0, 650.0), rune::Env::new(false, 1.0));
    runtime.frame(0.0);
    let bell = runtime
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(theme::ANCHOR))
        .unwrap();
    assert_eq!(
        bell.label.as_deref(),
        Some(
            format!(
                "{} · {}",
                t("toastHistory.title"),
                t("toastHistory.unread").replace("{count}", "1")
            )
            .as_str()
        )
    );
    runtime.update(|_, tx| tx.focus(theme::ANCHOR, true));
    runtime.frame(0.02);
    let enter = rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    };
    runtime.key(enter.clone());
    runtime.key_up(enter);
    runtime.frame(0.04);
    assert!(runtime.state.notifications.in_app.opened);
    let tree = runtime.accessibility_json().to_string();
    assert!(
        tree.contains("notification-history") && tree.contains("Recorded failure"),
        "{tree}"
    );
    assert!(tree.contains("notification-history-close"), "{tree}");
    runtime.update(|_, tx| tx.focus("notification-read-0", true));
    runtime.frame(0.06);
    let enter = rune::KeyEvent {
        key: rune::Key::Enter,
        mods: rune::Mods::default(),
    };
    runtime.key(enter.clone());
    runtime.key_up(enter);
    runtime.frame(0.08);
    assert_eq!(runtime.state.notifications.in_app.unread(), 0);
    assert_eq!(runtime.state.notifications.in_app.history.len(), 1);
}

#[test]
fn confirmed_destinations_control_history_and_bubbles_per_window() {
    let mut s = crate::init();
    let other = crate::init();
    super::super::messages::publish(
        &mut s,
        "Project",
        "Screen",
        None,
        Route {
            screen: true,
            history: false,
            system: false,
        },
        false,
        BubbleOptions::Default,
    );
    super::super::messages::publish(
        &mut s,
        "Project",
        "History",
        None,
        Route {
            screen: false,
            history: true,
            system: false,
        },
        false,
        BubbleOptions::Default,
    );
    let inbox = &s.notifications.in_app;
    assert_eq!(inbox.unread(), 1);
    assert_eq!(inbox.bubbles[0].0.body, "Screen");
    assert_eq!(inbox.history[0].0.body, "History");
    assert_eq!(other.notifications.in_app.unread(), 0);
    for _ in 0..HISTORY {
        s.notifications.in_app.push(
            "Project",
            "Earlier",
            None,
            &Route {
                screen: true,
                history: true,
                system: false,
            },
            BubbleOptions::Default,
        );
    }
    let inbox = &mut s.notifications.in_app;
    assert_eq!(inbox.history.len(), HISTORY);
    assert_eq!(inbox.bubbles.len(), BUBBLES);
    inbox.read(inbox.history[0].0.id);
    assert_eq!(inbox.unread(), HISTORY - 1);
}
#[test]
fn opening_history_pauses_screen_only_bubbles() {
    let mut inbox = Inbox::default();
    let start = 10.0;
    inbox.pause_bubbles(start);
    inbox.push(
        "Private",
        "Only on screen",
        None,
        &Route {
            screen: true,
            history: false,
            system: false,
        },
        BubbleOptions::Default,
    );
    let later = start + 30.0;
    inbox.resume_bubbles(later);
    assert_eq!(
        inbox.bubbles[0].1,
        BubbleDeadline::At(later + LIFETIME.as_secs_f64())
    );
    assert_eq!(inbox.unread(), 0);
}

#[test]
fn screen_toasts_use_their_own_deadline_and_announce_once_in_order() {
    let mut inbox = Inbox::default();
    let start = 10.0;
    inbox.pause_bubbles(start);
    let route = Route {
        screen: true,
        history: true,
        system: false,
    };
    inbox.push("Info", "First", None, &route, BubbleOptions::Default);
    inbox.push("Info", "Second", None, &route, BubbleOptions::Toast(1_800));
    inbox.push(
        "Info",
        "History only",
        None,
        &Route {
            screen: false,
            ..route
        },
        BubbleOptions::Default,
    );
    assert_eq!(inbox.announcement(), None);
    inbox.resume_bubbles(start);
    assert_eq!(inbox.next_expiration(), Some(start + 1.8));
    assert_eq!(
        inbox.announcement().as_deref(),
        Some("Info\nFirst\nInfo\nSecond")
    );
    assert_eq!(inbox.announcement(), None);
    assert_eq!(inbox.unread(), 3);
}

#[test]
fn a_zero_toast_duration_uses_the_toaster_default() {
    let mut inbox = Inbox::default();
    let start = 10.0;
    inbox.pause_bubbles(start);
    inbox.push(
        "Info",
        "Zero duration",
        None,
        &Route {
            screen: true,
            history: false,
            system: false,
        },
        BubbleOptions::Toast(0),
    );
    inbox.resume_bubbles(start);
    assert_eq!(inbox.next_expiration(), Some(start + 8.0));
}

#[test]
fn a_compaction_replaces_only_the_bubble_for_the_same_backend_and_session() {
    let mut inbox = Inbox::default();
    let route = Route {
        screen: true,
        history: true,
        system: false,
    };
    let target = Target {
        tab: Some("a".into()),
        backend_url: "http://127.0.0.1:9/".into(),
        server: Some("alpha".into()),
        occurrence: 1,
        workspace: "project".into(),
        session: "ses_example".into(),
    };
    let other = Target {
        server: Some("beta".into()),
        ..target.clone()
    };
    let duplicate_tab = Target {
        tab: Some("b".into()),
        occurrence: 2,
        ..target.clone()
    };
    let mut push = |body, target| {
        inbox.push(
            "Project",
            body,
            Some(target),
            &route,
            BubbleOptions::Compaction,
        )
    };
    push("First", target.clone());
    push("Other backend", other);
    push("Replacement", duplicate_tab);
    assert_eq!(
        inbox
            .bubbles
            .iter()
            .map(|(r, _)| r.body.as_str())
            .collect::<Vec<_>>(),
        ["Replacement", "Other backend"]
    );
    inbox.push(
        "Project",
        "History only",
        Some(target),
        &Route {
            screen: false,
            ..route
        },
        BubbleOptions::Compaction,
    );
    assert_eq!(inbox.bubbles.len(), 1);
    assert_eq!(inbox.bubbles[0].0.body, "Other backend");
    assert_eq!(
        inbox
            .history
            .iter()
            .map(|(r, _)| r.body.as_str())
            .collect::<Vec<_>>(),
        ["History only", "Replacement", "Other backend", "First"]
    );
}

#[test]
fn a_focused_bubble_action_accepts_enter_and_space() {
    for key in [rune::Key::Enter, rune::Key::Text(" ".into())] {
        let mut s = crate::init();
        crate::settings::notification_fixture(&s);
        s.notifications.in_app.push(
            "Project",
            "Bubble",
            None,
            &Route {
                screen: true,
                history: true,
                system: false,
            },
            BubbleOptions::Default,
        );
        let mut runtime =
            rune::Runtime::new(s, crate::view, (900.0, 650.0), rune::Env::new(false, 1.0));
        runtime.frame(0.0);
        runtime.update(|_, tx| tx.focus("notification-dismiss-0", true));
        runtime.frame(0.02);
        let key = rune::KeyEvent {
            key,
            mods: rune::Mods::default(),
        };
        runtime.key(key.clone());
        runtime.key_up(key);
        runtime.frame(0.04);
        assert!(runtime.state.notifications.in_app.bubbles.is_empty());
        assert_eq!(runtime.state.notifications.in_app.unread(), 1);
    }
}

#[test]
fn the_first_in_app_copy_does_not_claim_a_system_notice_while_focused() {
    let mut s = crate::init();
    let host = &mut s.notifications;
    let first = Target {
        tab: Some("a".into()),
        backend_url: "http://127.0.0.1:9/".into(),
        server: None,
        occurrence: 1,
        workspace: "first".into(),
        session: "ses_example".into(),
    };
    let second = Target {
        tab: Some("b".into()),
        occurrence: 2,
        workspace: "second".into(),
        ..first.clone()
    };
    let route = || Route {
        screen: false,
        history: true,
        system: true,
    };
    let mut initial = route();
    host.focused = true;
    super::super::messages::claim_routes(
        host,
        &first,
        super::super::Category::Sessions,
        "event",
        &mut initial,
        false,
    );
    assert!(initial.history && !initial.system);
    let mut duplicate = route();
    host.focused = false;
    super::super::messages::claim_routes(
        host,
        &second,
        super::super::Category::Sessions,
        "event",
        &mut duplicate,
        false,
    );
    assert!(!duplicate.history && duplicate.system);
}

#[test]
fn active_bubble_keeps_a_single_logical_wake_deadline_across_idle_frames() {
    let mut s = crate::init();
    crate::settings::notification_fixture(&s);
    s.notifications.in_app.push(
        "Project",
        "Saved",
        None,
        &Route {
            screen: true,
            history: true,
            system: false,
        },
        BubbleOptions::Default,
    );
    let mut rt = rune::Runtime::new(s, crate::view, (900.0, 650.0), rune::Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    let first_wake = rt
        .wake_deadline()
        .expect("active bubble must schedule its expiration wake");
    for _ in 0..180 {
        rt.frame(1.0 / 60.0);
        let wake = rt
            .wake_deadline()
            .expect("bubble remains active before LIFETIME elapses");
        assert!(
            (wake - first_wake).abs() < 1e-6,
            "bubble wake deadline must stay pinned on the logical clock instead of drifting: first={first_wake}, now={wake}"
        );
    }
    // Advancing past LIFETIME on the logical clock must expire the bubble with zero residual wakes.
    let remaining = (first_wake - rt.clock).max(0.0) + 0.05;
    rt.frame(remaining);
    assert!(
        rt.state.notifications.in_app.bubbles.is_empty(),
        "bubble must expire once logical clock passes LIFETIME"
    );
    rt.frame(1.0 / 60.0);
    assert!(
        rt.wake_deadline().is_none(),
        "expired bubble must leave no residual wake deadlines: {:?}",
        rt.wake_deadline()
    );
}
