//! Real Rune widgets and real Rust relay, driven without a native window.
use crate::{Phase, State, init, poll, view};
use rune::{Env, Runtime, edit::TextEdit};
use std::time::{Duration, Instant};
fn wait(rt: &mut Runtime<State>, label: &str, p: impl Fn(&State) -> bool) {
    let until = Instant::now() + Duration::from_secs(30);
    while !p(&rt.state) {
        assert!(Instant::now() < until, "control timeout: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    rt.frame(1.0 / 60.0);
}
fn tap(rt: &mut Runtime<State>, key: &str) {
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    rt.update(|_, tx| {
        tx.scroll_into_view(key.to_string());
        tx.instant()
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing control: {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}
fn idle(s: &State) -> bool {
    s.agent
        .as_ref()
        .is_some_and(|a| a.idle() && a.pending_known && a.known)
}
pub fn run() {
    let mut s = init();
    crate::setup(&mut s, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(s, view, (1400.0, 1600.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    tap(&mut rt, "connect");
    wait(&mut rt, "login", |s| {
        s.screen.launcher().unwrap().connection.is_some()
    });
    super::window_restore::wait_control(&mut rt, "browse");
    tap(&mut rt, "browse");
    rt.resolve_file_dialog(Some(std::env::var("RUNE_TEST_FOLDER").unwrap().into()))
        .unwrap();
    rt.frame(1.0 / 60.0);
    wait(&mut rt, "folder", |s| {
        s.screen.launcher().unwrap().project.is_some()
    });
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "controls", |s| s.phase == Phase::Ready && idle(s));
    assert_eq!(rt.state.agent.as_ref().unwrap().models.len(), 2);
    let mut backend = rt
        .state
        .screen
        .launcher()
        .unwrap()
        .connection
        .as_ref()
        .unwrap()
        .clone();
    backend.workspace = rt
        .state
        .screen
        .launcher()
        .unwrap()
        .project
        .as_ref()
        .unwrap()
        .id
        .clone();
    backend.session = "ses_existing".into();
    let control_path = |session: &str, tail: &str| {
        format!(
            "{}workspaces/{}/instance/api/session/{session}/{tail}",
            backend.base, backend.workspace
        )
    };
    for session in ["ses_existing", "ses_another"] {
        let request = if session == "ses_existing" {
            "per_stale"
        } else {
            "per_once"
        };
        let response = crate::platform::block_on(async {
            backend
                .client
                .post(control_path(
                    session,
                    &format!("permission/{request}/reply"),
                ))
                .json(&serde_json::json!({"decision":"once"}))
                .send()
                .await
                .unwrap()
        });
        assert_eq!(
            response.status().as_u16(),
            404,
            "stale or foreign request must never reach native mutation"
        );
        let refusal = crate::platform::block_on(crate::backend::read_json(response)).unwrap();
        assert_eq!(refusal["_tag"], "PermissionNotFoundError");
        assert_eq!(refusal["requestID"], request);
    }
    // A stale control snapshot cannot authorize replies while transport recovery is pending.
    let original = rt.state.incoming.take();
    let (out, incoming) = codenomad_client::bounded(4);
    rt.state.incoming = Some(incoming);
    out.send_blocking(crate::transport::Event::Reconnecting)
        .unwrap();
    rt.frame(0.0);
    {
        let a = rt.state.agent.as_mut().unwrap();
        assert!(!a.online);
        a.act(crate::agent_api::Action::Permission(
            "per_once".into(),
            "once".into(),
            "must not send".into(),
        ));
        assert!(!a.busy);
    }
    out.send_blocking(crate::transport::Event::Sync(crate::history::Page {
        rows: rt.state.messages.clone(),
        older: None,
        newer: None,
        running: false,
        user_file_references: false,
    }))
    .unwrap();
    rt.frame(0.0);
    wait(
        &mut rt,
        "controls reenabled after authoritative recovery",
        |s| idle(s) && s.agent.as_ref().unwrap().online,
    );
    rt.state.incoming = original;
    // Keep an edited question selected through replacement of native pending objects.
    {
        let a = rt.state.agent.as_mut().unwrap();
        a.selected = "form_answer".into();
        let d = a
            .drafts
            .get_mut(&("form_answer".into(), "name".into()))
            .unwrap();
        d.edit = TextEdit::new("Rune answer");
        d.dirty = true;
        a.refresh(false);
    }
    wait(&mut rt, "draft refresh", idle);
    {
        let a = rt.state.agent.as_ref().unwrap();
        assert_eq!(a.selected, "form_answer");
        assert_eq!(
            a.drafts[&("form_answer".into(), "name".into())].edit.text,
            "Rune answer"
        );
    }
    crate::launcher::back(&mut rt.state);
    assert!(
        !rt.state.screen.is_launcher(),
        "question draft guards navigation"
    );
    {
        let a = rt.state.agent.as_mut().unwrap();
        a.drafts
            .get_mut(&("form_answer".into(), "count".into()))
            .unwrap()
            .edit = TextEdit::new("2");
        a.drafts
            .get_mut(&("form_answer".into(), "tags".into()))
            .unwrap()
            .selected
            .insert("one".into());
        a.drafts
            .get_mut(&("form_answer".into(), "enabled".into()))
            .unwrap()
            .edit = TextEdit::new("true");
        a.drafts
            .get_mut(&("form_answer".into(), "detail".into()))
            .unwrap()
            .edit = TextEdit::new("conditional answer");
    }
    rt.frame(0.0);
    tap(&mut rt, "answer-question");
    wait(&mut rt, "typed answer", |s| {
        idle(s) && s.agent.as_ref().unwrap().forms.len() == 1
    });
    rt.state.agent.as_mut().unwrap().selected = "form_cancel".into();
    rt.frame(0.0);
    tap(&mut rt, "cancel-question");
    wait(&mut rt, "question cancel", |s| {
        idle(s) && s.agent.as_ref().unwrap().forms.is_empty()
    });
    for (id, key) in [
        ("per_once", "allow_once"),
        ("per_always", "allow_always"),
        ("per_reject", "reject"),
    ] {
        {
            let a = rt.state.agent.as_mut().unwrap();
            a.selected = id.into();
            *a.reasons.get_mut(id).unwrap() = TextEdit::new("kept reason");
        }
        rt.frame(0.0);
        tap(&mut rt, key);
        if id == "per_reject" {
            wait(&mut rt, "failed reply", |s| {
                idle(s) && s.agent.as_ref().unwrap().error
            });
            let a = rt.state.agent.as_ref().unwrap();
            assert_eq!(a.reasons[id].text, "kept reason");
            assert!(a.permissions.iter().any(|p| p.id == id));
            tap(&mut rt, key);
        }
        wait(&mut rt, "explicit permission", |s| {
            idle(s)
                && !s
                    .agent
                    .as_ref()
                    .unwrap()
                    .permissions
                    .iter()
                    .any(|p| p.id == id)
        });
    }
    tap(&mut rt, "model-picker");
    wait(&mut rt, "catalogue", idle);
    let reference = rt.state.agent.as_ref().unwrap().models[1].reference.clone();
    tap(&mut rt, &format!("model-{reference}"));
    wait(&mut rt, "model confirmed", |s| {
        idle(s) && s.agent.as_ref().unwrap().current.as_ref() == Some(&reference)
    });
    rt.state.draft = TextEdit::new("Synthetic interrupt test");
    rt.frame(0.0);
    tap(&mut rt, "send");
    // Bring the stop button into view before waiting for idle + holding /api/model.
    rt.update(|_, tx| {
        tx.scroll_into_view("stop-response".to_string());
        tx.instant()
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    wait(&mut rt, "stream fragments", |s| {
        s.phase == Phase::Streaming
            && s.messages
                .last()
                .is_some_and(|m| m.body.contains("fragment fragment"))
            && s.agent.as_ref().is_some_and(|a| a.idle())
    });
    assert!(rt.state.agent.as_ref().unwrap().idle());
    rt.state.agent.as_mut().unwrap().refresh(true);
    // Wait causally until the fixture confirms GET /api/model is held open; the fixture only
    // releases /api/model after Rune prints `controls-stopped` upon observing `!stopping`.
    wait(&mut rt, "slow catalogue held", |s| {
        s.messages
            .last()
            .is_some_and(|m| m.body.contains("holding-catalogue"))
    });
    rt.update(|_, tx| {
        tx.scroll_into_view("stop-response".to_string());
        tx.instant()
    });
    rt.frame(1.0 / 60.0);
    let (x, y) = rt
        .find("stop-response")
        .expect("missing control: stop-response");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    assert!(
        rt.state.agent.as_ref().unwrap().stopping,
        "stop-response click must be admitted"
    );
    wait(&mut rt, "urgent stop lane", |s| {
        !s.agent.as_ref().unwrap().stopping
    });
    assert!(!rt.state.agent.as_ref().unwrap().error);
    println!(r#"{{"type":"controls-stopped"}}"#);
    wait(&mut rt, "interrupted authoritative history", |s| {
        s.phase == Phase::Ready && idle(s)
    });
    assert!(!rt.state.agent.as_ref().unwrap().error);
    assert!(rt.state.messages.last().unwrap().body.contains("fragment"));
    assert!(
        rt.state
            .agent
            .as_ref()
            .unwrap()
            .forms
            .iter()
            .any(|f| f.id == "form_live"),
        "nested form.created must refresh the session queue"
    );
    let receipts: serde_json::Value = crate::platform::block_on(async {
        backend
            .client
            .get(format!(
                "{}api/workspaces/{}/sessions/{}/permission-receipts?unanchored=true",
                backend.base, backend.workspace, backend.session
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap()
    });
    assert_eq!(
        receipts["receipts"]
            .as_array()
            .expect("durable permission receipts")
            .len(),
        3
    );
    assert!(
        receipts["receipts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["origin"] == "codenomad" && r["reason"] == "kept reason")
    );
    println!(
        "agent controls: model + variant confirmed, typed conditional question and cancel, pinned selection + draft preserved, once/always/reject, explicit retry after 503, streaming stop; real Rune runtime + real Rust + synthetic OpenCode; no native window or clipboard"
    );
}
