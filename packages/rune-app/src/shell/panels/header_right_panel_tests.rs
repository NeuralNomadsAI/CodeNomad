use crate::{Phase, State, gallery::shell::fixture, init, strings};
use rune::{Cx, El, Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;

fn english(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("en", || crate::view(s, cx))
}

fn hebrew(s: &State, cx: &mut Cx<State>) -> El {
    strings::with_locale("he", || crate::view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..8 {
        rt.frame(1.0 / 60.0);
    }
}

fn project_state(model: serde_json::Value) -> State {
    let mut s = init();
    fixture(&mut s);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    s.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::opened(&mut s, &project);
    s.phase = Phase::Ready;
    s.chat_title = "Short conversation".into();
    s.messages.push(
        crate::history::decode_message(&json!({
            "id": "m-1",
            "type": "assistant",
            "time": { "completed": 1 },
            "tokens": { "input": 18, "output": 10 },
            "cost": 0.0,
            "content": [{ "type": "text", "text": "Reply" }]
        }))
        .unwrap()
        .into(),
    );
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let mut agent = crate::agent::Ui::new(crate::agent::start(backend, s.wake.clone()));
    agent.current = Some(model);
    s.agent = Some(agent);
    s
}

#[test]
fn conversation_header_renders_context_meter_and_connection_status_in_light_and_dark() {
    let inspect = |dark: bool| {
        let model = json!({
            "id": "model-a",
            "providerID": "provider-a",
            "limit": { "input": 64000, "context": 128000 }
        });
        let mut rt = Runtime::new(
            project_state(model),
            english,
            (1280.0, 800.0),
            Env::new(dark, 1.0),
        );
        settle(&mut rt);

        let elements = rt.elements();
        let header = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("session-header"))
            .expect("session-header mounted");
        assert_eq!(header.radius, 0.0, "session-header must stay square");
        assert!(
            header.fill.a > 0.0,
            "session-header must paint surface fill"
        );

        // limit.input takes precedence over limit.context like Solid session-info.ts.
        let meter = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("context-meter"))
            .expect("context-meter mounted for active conversation");
        assert!(
            meter.help.as_deref().is_some_and(|tip| tip.contains("28")
                && tip.contains("64,000")
                && tip.contains('%')),
            "context-meter tooltip must prefer limit.input and include percentage: {:?}",
            meter.help
        );

        let meter_values = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("context-meter-values"))
            .expect("context-meter-values mounted");
        assert!(
            meter_values.radius > 0.0,
            "context-meter-values chip uses chip radius"
        );
        assert_eq!(
            meter_values.fill.a, 0.0,
            "context-meter-values uses transparent background like Solid"
        );
        let values_prefix = format!("{}/", meter_values.path);
        let values_text: Vec<&str> = elements
            .iter()
            .filter(|el| el.path.starts_with(&values_prefix))
            .filter_map(|el| el.text.as_deref())
            .collect();
        assert!(
            values_text.contains(&"28") && values_text.contains(&"64K"),
            "context meter must display compact used and preferred input limit: {values_text:?}"
        );

        // When non-zero usage is small (28/64000 < 0.001), sector stays omitted; bumping usage draws it.
        assert!(
            elements
                .iter()
                .all(|el| el.key.as_deref() != Some("context-meter-sector")),
            "negligible ratio must leave dial track empty"
        );

        let conn = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("connection-status"))
            .expect("connection-status mounted");
        assert_eq!(conn.role, "img");
        assert_eq!(conn.label.as_deref(), Some("Connected"));
        assert_eq!(conn.help.as_deref(), Some("Connected"));
        let ready_dot = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("connection-status-dot"))
            .expect("connection status dot mounted");
        assert!(ready_dot.fill.a > 0.0, "connected dot must be painted");

        // When left sidebar is open, duplicate centered chat-title stays hidden like Solid.
        assert!(
            elements
                .iter()
                .all(|el| el.key.as_deref() != Some("chat-title")),
            "chat-title must not duplicate the open left session sidebar"
        );

        // Collapsing left sidebar reveals accessible chat-title heading in center.
        let (tx_x, tx_y) = rt.find("sessions-panel-toggle").expect("left toggle");
        rt.pointer_down(tx_x, tx_y);
        rt.pointer_up(tx_x, tx_y);
        settle(&mut rt);
        let collapsed = rt.elements();
        let title = collapsed
            .iter()
            .find(|el| el.key.as_deref() == Some("chat-title"))
            .expect("chat-title appears when left sidebar is collapsed");
        assert_eq!(title.role, "heading");
        assert_eq!(title.text.as_deref(), Some("Short conversation"));

        // Reconnecting and Failed use distinct semantic status dot colors; Failed mounts retry.
        rt.update(|s, _| {
            s.phase = Phase::Reconnecting;
        });
        settle(&mut rt);
        let reconnecting_dot = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some("connection-status-dot"))
            .expect("reconnecting dot mounted");
        assert!(reconnecting_dot.fill.a > 0.0);
        assert_ne!(
            reconnecting_dot.fill, ready_dot.fill,
            "reconnecting dot must differ from connected dot (dark={dark})"
        );

        rt.update(|s, _| {
            s.phase = Phase::Failed;
        });
        settle(&mut rt);
        let failed = rt.elements();
        let failed_conn = failed
            .iter()
            .find(|el| el.key.as_deref() == Some("connection-status"))
            .expect("connection-status stays mounted on failure");
        assert_eq!(failed_conn.label.as_deref(), Some("Disconnected"));
        let failed_dot = failed
            .iter()
            .find(|el| el.key.as_deref() == Some("connection-status-dot"))
            .expect("error status dot mounted");
        assert!(failed_dot.fill.a > 0.0);
        assert_ne!(
            failed_dot.fill, ready_dot.fill,
            "disconnected dot must differ from connected dot (dark={dark})"
        );
        assert_ne!(
            failed_dot.fill, reconnecting_dot.fill,
            "disconnected dot must differ from reconnecting dot (dark={dark})"
        );
        assert!(
            failed
                .iter()
                .any(|el| el.key.as_deref() == Some("connection-retry") && el.role == "button"),
            "connection-retry button must appear on Phase::Failed"
        );

        (
            header.fill,
            ready_dot.fill,
            reconnecting_dot.fill,
            failed_dot.fill,
        )
    };

    let (light_header, light_ready, light_pending, light_error) = inspect(false);
    let (dark_header, dark_ready, dark_pending, dark_error) = inspect(true);
    assert_ne!(
        light_header, dark_header,
        "session-header surface must adapt between light and dark themes"
    );
    assert_eq!(light_ready, dark_ready);
    assert_eq!(light_pending, dark_pending);
    assert_eq!(light_error, dark_error);
}

#[test]
fn production_model_reference_without_limit_renders_used_tokens_and_placeholder_avail() {
    // Mirrors session.data.model from agent_api.rs ({id, providerID} without limit).
    let model = json!({ "id": "fixture", "providerID": "fixture" });
    let mut rt = Runtime::new(
        project_state(model),
        english,
        (1280.0, 800.0),
        Env::new(true, 1.0),
    );
    settle(&mut rt);

    let elements = rt.elements();
    let meter_values = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("context-meter-values"))
        .expect("context-meter-values mounted");
    let prefix = format!("{}/", meter_values.path);
    let values_text: Vec<&str> = elements
        .iter()
        .filter(|el| el.path.starts_with(&prefix))
        .filter_map(|el| el.text.as_deref())
        .collect();
    assert!(
        values_text.contains(&"28") && values_text.contains(&"--"),
        "model ref without limit must show used tokens and -- avail: {values_text:?}"
    );
    assert!(
        elements
            .iter()
            .all(|el| el.key.as_deref() != Some("context-meter-sector")),
        "missing limit must keep dial ring empty"
    );
}

#[test]
fn narrow_phone_header_collapses_density_and_stays_inside_toggle_bounds() {
    let model = json!({
        "id": "model-a",
        "providerID": "provider-a",
        "limit": { "context": 100000 }
    });
    let mut s = project_state(model);
    s.messages.clear();
    s.messages.push(
        crate::history::decode_message(&json!({
            "id": "m-1",
            "type": "assistant",
            "time": { "completed": 1 },
            "tokens": { "input": 32000, "output": 1000 },
            "cost": 0.0,
            "content": [{ "type": "text", "text": "Reply" }]
        }))
        .unwrap()
        .into(),
    );
    let mut rt = Runtime::new(s, english, (360.0, 800.0), Env::new(true, 1.0));
    settle(&mut rt);

    let elements = rt.elements();
    let header = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("session-header"))
        .expect("session-header mounted on 360px viewport");
    let left_toggle = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("sessions-panel-toggle"))
        .expect("left toggle mounted");
    let right_toggle = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("right-panel-toggle"))
        .expect("right toggle mounted");
    assert!(
        elements
            .iter()
            .any(|el| el.key.as_deref() == Some("context-meter-sector")),
        "33% usage must paint proportional SVG sector"
    );
    assert!(
        elements
            .iter()
            .all(|el| el.key.as_deref() != Some("context-meter-values")),
        "360px phone width must collapse context meter to dial-only density"
    );
    let min_x = left_toggle.rect[0] + left_toggle.rect[2] - 0.5;
    let max_x = right_toggle.rect[0] + 0.5;
    for key in ["context-meter", "connection-status"] {
        let item = elements
            .iter()
            .find(|el| el.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("{key} must stay mounted at 360px"));
        assert!(
            item.rect[0] >= min_x && item.rect[0] + item.rect[2] <= max_x,
            "{key} ({:?}) must stay between left ({min_x}) and right ({max_x}) toggles inside header ({:?})",
            item.rect,
            header.rect
        );
    }
}

#[test]
fn right_panel_bordered_tabs_distinguish_active_and_inactive_in_light_dark_and_rtl() {
    let inspect = |dark: bool| {
        let model = json!({ "id": "fixture", "providerID": "fixture" });
        let mut rt = Runtime::new(
            project_state(model),
            english,
            (1280.0, 800.0),
            Env::new(dark, 1.0),
        );
        settle(&mut rt);

        let elements = rt.elements();
        let tablist = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("right-panel-tabs"))
            .expect("right-panel-tabs mounted");
        assert_eq!(tablist.role, "tablist");

        let tab0 = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("right-panel-tab-0"))
            .expect("Status tab mounted");
        let tab1 = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("right-panel-tab-1"))
            .expect("Files tab mounted");
        assert_eq!(tab0.role, "tab");
        assert_eq!(tab1.role, "tab");
        assert_eq!(tab0.radius, 0.0, "active right-panel tab must stay square");
        assert_eq!(
            tab1.radius, 0.0,
            "inactive right-panel tab must stay square"
        );
        assert!(tab0.fill.a > 0.0 && tab1.fill.a > 0.0);
        assert_ne!(
            tab0.fill, tab1.fill,
            "active and inactive right-panel tabs must have distinct surfaces (dark={dark})"
        );
        assert!(
            tab0.rect[0] + tab0.rect[2] <= tab1.rect[0] + 0.5,
            "LTR tabs must sit side by side without overlap: {:?} vs {:?}",
            tab0.rect,
            tab1.rect
        );

        let tab_ink = |path: &str| {
            let prefix = format!("{path}/");
            elements
                .iter()
                .find(|el| el.path.starts_with(&prefix) && el.text_color.is_some())
                .and_then(|el| el.text_color)
                .expect("tab label ink")
        };
        let active_ink = tab_ink(&tab0.path);
        let inactive_ink = tab_ink(&tab1.path);
        assert_ne!(
            active_ink, inactive_ink,
            "active and inactive tab labels must use distinct contrast ink (dark={dark})"
        );

        // Keyboard Space on focused Files tab activates it.
        rt.update(|_, tx| tx.focus("right-panel-tab-1", true));
        settle(&mut rt);
        rt.key(KeyEvent {
            key: Key::Text(" ".into()),
            mods: Mods::default(),
        });
        settle(&mut rt);
        assert!(
            crate::workspace::files_tab(&rt.state),
            "Space key must activate focused right-panel tab"
        );

        (tab0.fill, tab1.fill, active_ink)
    };

    let (light_active, light_inactive, light_ink) = inspect(false);
    let (dark_active, dark_inactive, dark_ink) = inspect(true);
    assert_ne!(
        light_active, dark_active,
        "active tab fill must adapt across themes"
    );
    assert_ne!(
        light_inactive, dark_inactive,
        "inactive tab fill must adapt across themes"
    );
    assert_ne!(
        light_ink, dark_ink,
        "active tab text ink must adapt across themes"
    );

    // Hebrew RTL root renders tab 0 on the right of tab 1 without overlap.
    let mut rtl_rt = Runtime::new(
        project_state(json!({ "id": "fixture", "providerID": "fixture" })),
        hebrew,
        (1280.0, 800.0),
        Env::new(true, 1.0),
    );
    settle(&mut rtl_rt);
    let rtl_elements = rtl_rt.elements();
    let rtl_tab0 = rtl_elements
        .iter()
        .find(|el| el.key.as_deref() == Some("right-panel-tab-0"))
        .expect("RTL tab 0 mounted");
    let rtl_tab1 = rtl_elements
        .iter()
        .find(|el| el.key.as_deref() == Some("right-panel-tab-1"))
        .expect("RTL tab 1 mounted");
    assert!(
        rtl_tab1.rect[0] + rtl_tab1.rect[2] <= rtl_tab0.rect[0] + 0.5,
        "RTL tab 0 must sit to the right of tab 1 without overlap: {:?} vs {:?}",
        rtl_tab0.rect,
        rtl_tab1.rect
    );
}

#[test]
fn open_project_without_session_displays_zero_used_and_placeholder_available() {
    let mut s = init();
    fixture(&mut s);
    let project = s.screen.launcher().unwrap().project.clone().unwrap();
    s.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::opened(&mut s, &project);
    s.phase = Phase::Ready;
    s.chat_title.clear();
    s.messages.clear();
    s.agent = None;

    let mut rt = Runtime::new(s, english, (1280.0, 800.0), Env::new(true, 1.0));
    settle(&mut rt);

    let elements = rt.elements();
    let meter = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("context-meter"))
        .expect("context-meter must appear for an open project even before selecting a session");
    assert!(meter.help.is_some());
    let meter_values = elements
        .iter()
        .find(|el| el.key.as_deref() == Some("context-meter-values"))
        .expect("context-meter-values mounted");
    let prefix = format!("{}/", meter_values.path);
    let values_text: Vec<&str> = elements
        .iter()
        .filter(|el| el.path.starts_with(&prefix))
        .filter_map(|el| el.text.as_deref())
        .collect();
    assert!(
        values_text.contains(&"0") && values_text.contains(&"--"),
        "idle project header must show 0 used and -- available: {values_text:?}"
    );
}
