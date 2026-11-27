//! Explicit real-service qualification on the launcher-owned disposable session.
use crate::{Phase, State, init, poll, view};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::Value;
use std::time::{Duration, Instant};
fn wait(rt: &mut Runtime<State>, label: &str, p: impl Fn(&State) -> bool) {
    eprintln!("Real control stage: {label}");
    let until = Instant::now() + Duration::from_secs(120);
    while !p(&rt.state) {
        assert!(Instant::now() < until, "real controls timeout: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
}
fn tap(rt: &mut Runtime<State>, key: &str) {
    rt.update(|_, tx| {
        tx.scroll_into_view(key.to_string());
        tx.instant()
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing real control {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}
pub fn run() {
    assert_eq!(std::env::var("RUNE_EMPTY_SESSION").as_deref(), Ok("1"));
    let target: Value = serde_json::from_str(&std::env::var("RUNE_TEST_MODEL").unwrap()).unwrap();
    let mut s = init();
    crate::setup(&mut s, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(s, view, (1200.0, 1000.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    wait(&mut rt, "empty session and catalogue", |s| {
        s.phase == Phase::Ready
            && s.agent
                .as_ref()
                .is_some_and(|a| a.known && a.pending_known && a.idle())
    });
    assert!(rt.state.messages.is_empty());
    let label = rt
        .state
        .agent
        .as_ref()
        .unwrap()
        .models
        .iter()
        .find(|m| m.reference == target)
        .expect("configured existing model in native catalogue")
        .label
        .clone();
    tap(&mut rt, "model-picker");
    wait(&mut rt, "fresh native catalogue", |s| {
        s.agent.as_ref().unwrap().idle()
    });
    rt.state.agent.as_mut().unwrap().search = TextEdit::new(label);
    rt.frame(0.0);
    tap(&mut rt, &format!("model-{target}"));
    wait(&mut rt, "native model persisted", |s| {
        s.agent
            .as_ref()
            .is_some_and(|a| a.idle() && a.current.as_ref() == Some(&target))
    });
    assert!(!rt.state.agent.as_ref().unwrap().error);
    rt.state.draft = TextEdit::new(
        "Réponds uniquement par une liste numérotée de 1500 lignes, chaque ligne contenant son numéro puis le mot Rune. Aucun outil. Commence directement la liste, sans introduction.",
    );
    rt.frame(0.0);
    tap(&mut rt, "send");
    wait(&mut rt, "real streamed text", |s| {
        s.phase == Phase::Streaming
            && s.messages
                .last()
                .is_some_and(|m| m.role == "assistant" && m.body.len() > 400)
    });
    let partial = rt.state.messages.last().unwrap().body.len();
    tap(&mut rt, "stop-response");
    wait(&mut rt, "real interruption settled", |s| {
        s.phase == Phase::Ready && s.agent.as_ref().is_some_and(|a| a.idle())
    });
    assert!(!rt.state.agent.as_ref().unwrap().error);
    assert!(
        rt.state.agent.as_ref().unwrap().permissions.is_empty()
            && rt.state.agent.as_ref().unwrap().forms.is_empty()
    );
    assert_eq!(
        rt.state
            .messages
            .iter()
            .filter(|m| m.role == "user")
            .count(),
        1
    );
    assert_eq!(
        rt.state
            .messages
            .iter()
            .map(|m| &m.id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        rt.state.messages.len()
    );
    println!(
        "{}",
        serde_json::json!({"result":"real-agent-controls-ok","models":rt.state.agent.as_ref().unwrap().models.len(),"partialBytesBeforeStop":partial,"rows":rt.state.messages.len(),"modelConfirmed":true,"readyAfterStop":true})
    );
}
