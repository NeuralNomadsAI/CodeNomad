use super::*;
use crate::agent_api::ToolSource;
use rune::{Cx, El, Env, Runtime};
use serde_json::json;

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx)).on_layout_tx(
        |s, [_, _, w, h], tx| {
            if !preview_window_layout(s, [w, h]) {
                tx.live_only();
            }
        },
    )
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..30 {
        rt.frame(0.016);
    }
}

fn build_rail_state() -> State {
    let mut s = crate::init();
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    observe(&mut s, &crate::transport::Event::Connected(backend.clone()));
    s.messages.push(
        crate::history::decode_message(&json!({
            "id": "step",
            "type": "assistant",
            "time": { "completed": 1 },
            "content": [
                {
                    "type": "tool",
                    "id": "done-call",
                    "name": "read",
                    "state": { "status": "completed", "output": "ok" }
                },
                {
                    "type": "tool",
                    "id": "perm-call",
                    "name": "bash",
                    "state": { "status": "running", "input": { "command": "ls" } }
                },
                { "type": "text", "text": "Inspecting workspace status." }
            ]
        }))
        .unwrap()
        .into(),
    );
    let mut agent = crate::agent::Ui::new(crate::agent::start(backend, s.wake.clone()));
    agent.permissions = crate::agent_api::permissions(
        &json!({
            "data": [{
                "id": "perm-1",
                "sessionID": "session",
                "permission": "bash",
                "patterns": ["ls"],
                "source": { "type": "tool", "id": "perm-call", "messageID": "step" }
            }]
        }),
        "session",
    )
    .unwrap();
    s.agent = Some(agent);
    let t = owner(&mut s);
    t.width = 900.0;
    t.changed = true;
    s
}

#[test]
fn rail_pending_permission_tone_and_banners_hold_across_light_and_dark_themes() {
    let inspect = |dark: bool| {
        let mut rt = Runtime::new(
            build_rail_state(),
            view,
            (900.0, 600.0),
            Env::new(dark, 1.0),
        );
        rt.update(|s, tx| {
            poll(s, tx);
        });
        settle(&mut rt);

        let markers = &rt.state.transcript_display.timeline.markers;
        let normal_id = "step:Tool:0:false";
        let pending_id = "step:Tool:1:false";
        let normal = markers
            .iter()
            .find(|m| m.id == normal_id)
            .expect("normal tool marker projected");
        let pending = markers
            .iter()
            .find(|m| m.id == pending_id)
            .expect("pending tool marker projected");
        assert!(!normal.pending, "completed tool must not be marked pending");
        assert!(
            pending.pending,
            "permission-waiting tool must be marked pending"
        );

        let elements = rt.elements();
        let rail = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("timeline"))
            .expect("timeline rail mounted");
        assert_eq!(rail.role, "navigation");
        assert_eq!(rail.radius, 0.0, "timeline rail must stay square");
        assert!(rail.fill.a > 0.0, "timeline rail must paint surface fill");
        let rail_fill = rail.fill;

        let marker_icon_color = |id: &str| {
            let marker_path = elements
                .iter()
                .find(|el| el.key.as_deref() == Some(id))
                .expect("marker mounted")
                .path
                .clone();
            let prefix = format!("{marker_path}/");
            elements
                .iter()
                .find(|el| {
                    el.path.starts_with(&prefix) && (el.text_color.is_some() || el.fill.a > 0.0)
                })
                .map(|el| el.text_color.unwrap_or(el.fill))
                .expect("marker icon tint")
        };
        let normal_tint = marker_icon_color(normal_id);
        let pending_tint = marker_icon_color(pending_id);
        assert_ne!(
            normal_tint, pending_tint,
            "pending permission tool marker must use distinct tone from normal tool marker (dark={dark})"
        );

        // Filtered destination alert banner
        rt.update(|s, _| {
            owner(s).jump.filtered = true;
        });
        settle(&mut rt);
        let filtered_elements = rt.elements();
        let filtered = filtered_elements
            .iter()
            .find(|el| el.key.as_deref() == Some("timeline-destination-filtered"))
            .expect("filtered destination banner mounted");
        assert_eq!(filtered.role, "alert");
        assert_eq!(filtered.radius, 0.0, "filtered banner must stay square");
        assert!(
            filtered.fill.a > 0.0,
            "filtered banner must paint inset surface"
        );
        let filtered_fill = filtered.fill;
        let filtered_ink = filtered.text_color.expect("filtered banner error ink");

        // Outline retry status banner
        rt.update(|s, _| {
            owner(s).jump.filtered = false;
            owner(s).outline_error = true;
        });
        settle(&mut rt);
        let retry_elements = rt.elements();
        let retry = retry_elements
            .iter()
            .find(|el| el.key.as_deref() == Some("timeline-outline-retry"))
            .expect("outline retry banner mounted");
        assert_eq!(retry.role, "status");
        assert_eq!(retry.radius, 0.0, "retry banner must stay square");
        assert_eq!(
            retry.fill, filtered_fill,
            "banners share surface-inset role"
        );
        let retry_prefix = format!("{}/", retry.path);
        let retry_caption_ink = retry_elements
            .iter()
            .find(|el| el.path.starts_with(&retry_prefix) && el.role != "button")
            .and_then(|el| el.text_color)
            .expect("retry banner caption ink");
        assert_ne!(
            filtered_ink, retry_caption_ink,
            "filtered destination alert must use error ink distinct from status caption ink (dark={dark})"
        );
        assert!(
            retry_elements
                .iter()
                .any(|el| el.path.starts_with(&retry_prefix) && el.role == "button"),
            "retry banner must keep an interactive retry button"
        );

        (rail_fill, filtered_fill, normal_tint, pending_tint)
    };

    let (light_rail, light_banner, light_normal, light_pending) = inspect(false);
    let (dark_rail, dark_banner, dark_normal, dark_pending) = inspect(true);
    assert_ne!(
        light_rail, dark_rail,
        "rail surface must differ across themes"
    );
    assert_ne!(
        light_banner, dark_banner,
        "banner inset surface must differ across themes"
    );
    assert_ne!(
        light_normal, dark_normal,
        "tool marker tone must adapt across themes"
    );
    assert_ne!(
        light_pending, dark_pending,
        "permission marker tone must adapt across themes"
    );

    // Clearing pending state updates the marker pending flag cleanly.
    let mut s = build_rail_state();
    s.agent.as_mut().unwrap().permissions.clear();
    let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(false, 1.0));
    rt.update(|s, tx| {
        owner(s).pending.insert(ToolSource {
            message: "step".into(),
            call: "perm-call".into(),
        });
        poll(s, tx);
    });
    assert!(
        rt.state
            .transcript_display
            .timeline
            .markers
            .iter()
            .all(|m| !m.pending),
        "clearing pending permission must clear marker pending flag"
    );
}

#[test]
fn timeline_peek_overlay_renders_square_overlay_surface_in_light_and_dark() {
    let inspect = |dark: bool| {
        let mut s = crate::init();
        let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        observe(&mut s, &crate::transport::Event::Connected(backend));
        s.messages.push(
            crate::history::decode_message(&json!({
                "id": "m-0",
                "type": "assistant",
                "time": { "completed": 1 },
                "content": [{ "type": "text", "text": "Timeline preview body for hover inspection." }]
            }))
            .unwrap()
            .into(),
        );
        let t = owner(&mut s);
        t.width = 900.0;
        t.changed = true;
        let mut rt = Runtime::new(s, view, (900.0, 600.0), Env::new(dark, 1.0));
        rt.poll = Some(crate::poll);
        settle(&mut rt);

        let marker_id = rt.state.transcript_display.timeline.markers[0].id.clone();
        let [mx, my, mw, mh] = rt
            .presented(&marker_id)
            .expect("marker presented for hover preview")
            .0;
        rt.pointer_move(mx + mw / 2.0, my + mh / 2.0);
        settle(&mut rt);

        let elements = rt.elements();
        let peek = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("timeline-peek"))
            .expect("timeline-peek tooltip mounted on marker hover");
        assert_eq!(peek.role, "tooltip");
        assert_eq!(
            peek.radius, 0.0,
            "timeline preview popover must stay square"
        );
        assert!(
            peek.rect[2] > 0.0
                && peek.rect[2] <= 360.5
                && peek.rect[3] > 0.0
                && peek.rect[3] <= 420.5,
            "timeline preview bounds must stay within Solid 360x420 cap: {:?}",
            peek.rect
        );
        assert!(
            peek.fill.a > 0.0,
            "timeline-peek must paint overlay surface"
        );
        peek.fill
    };

    let light_fill = inspect(false);
    let dark_fill = inspect(true);
    assert_ne!(
        light_fill, dark_fill,
        "timeline preview surface-overlay must differ between light and dark themes"
    );
}
