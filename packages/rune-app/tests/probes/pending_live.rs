//! Real native pending requests through the real Rune widgets, without a window or model.
use super::window_restore::{tap, type_text, wait};
use crate::{Phase, State, init, poll, view};
use rune::{Env, Runtime};
use serde_json::json;

fn ready(s: &State) -> bool {
    s.phase == Phase::Ready
        && s.agent
            .as_ref()
            .is_some_and(|a| a.known && a.pending_known && a.online && a.idle())
}
fn signal(stage: &str, case: &str, id: Option<&str>) {
    println!(
        "{}",
        json!({"type":"pending-live-stage","stage":stage,"case":case,"id":id})
    );
}
fn capture(rt: &Runtime<State>, case: &str, key: &str) {
    let node = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(key))
        .expect("pending action mounted");
    assert!(!node.exiting && node.opacity > 0.99 && node.visible[2] > 0.0 && node.visible[3] > 0.0);
    let root = std::path::PathBuf::from(std::env::var("RUNE_PENDING_OUT").unwrap());
    assert!(root.is_absolute());
    std::fs::write(
        root.join(format!("{case}.a11y.json")),
        serde_json::to_vec_pretty(&rt.accessibility_json()).unwrap(),
    )
    .unwrap();
    println!(
        "{}",
        json!({"type":"pending-live-visible","case":case,"key":key,"rect":node.rect,"visible":node.visible})
    );
}
pub fn run() {
    assert_eq!(std::env::var("RUNE_EMPTY_SESSION").as_deref(), Ok("1"));
    let ids: Vec<String> =
        serde_json::from_str(&std::env::var("RUNE_PENDING_IDS").unwrap()).unwrap();
    assert_eq!(ids.len(), 3);
    let mut state = init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(state, view, (1400.0, 1600.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    wait(&mut rt, "native pending session connected", ready);
    assert!(rt.state.messages.is_empty());
    for ((decision, key), id) in [
        ("once", "allow_once"),
        ("always", "allow_always"),
        ("reject", "reject"),
    ]
    .into_iter()
    .zip(ids)
    {
        signal("ready", decision, Some(&id));
        wait(&mut rt, "native permission event", |s| {
            ready(s)
                && s.agent
                    .as_ref()
                    .unwrap()
                    .permissions
                    .iter()
                    .any(|p| p.id == id)
        });
        assert_eq!(rt.state.agent.as_ref().unwrap().selected, id);
        let reason = format!("Motif réel Rune {decision} 🦀");
        type_text(&mut rt, &format!("reason-{id}"), &reason);
        assert_eq!(rt.state.agent.as_ref().unwrap().reasons[&id].text, reason);
        capture(&rt, decision, key);
        tap(&mut rt, key);
        wait(&mut rt, "native permission settled", |s| {
            ready(s)
                && !s
                    .agent
                    .as_ref()
                    .unwrap()
                    .permissions
                    .iter()
                    .any(|p| p.id == id)
        });
        assert!(!rt.state.agent.as_ref().unwrap().error);
        signal("done", decision, Some(&id));
    }
    signal("ready", "typed-question", None);
    wait(&mut rt, "native typed question event", |s| {
        ready(s)
            && s.agent
                .as_ref()
                .unwrap()
                .forms
                .iter()
                .any(|f| f.title == "Rune native typed question")
    });
    let form = rt
        .state
        .agent
        .as_ref()
        .unwrap()
        .forms
        .iter()
        .find(|f| f.title == "Rune native typed question")
        .unwrap()
        .id
        .clone();
    assert_eq!(rt.state.agent.as_ref().unwrap().selected, form);
    type_text(
        &mut rt,
        "field-name",
        "Réponse native Rune 🦀\nDeuxième ligne",
    );
    tap(&mut rt, "controls-refresh");
    wait(&mut rt, "native question draft refresh", ready);
    assert_eq!(
        rt.state.agent.as_ref().unwrap().drafts[&(form.clone(), "name".into())]
            .edit
            .text,
        "Réponse native Rune 🦀\nDeuxième ligne"
    );
    type_text(&mut rt, "field-count", "2");
    tap(&mut rt, "bool-enabled-true");
    capture(&rt, "typed-question", "answer-question");
    tap(&mut rt, "answer-question");
    wait(&mut rt, "native question answered", |s| {
        ready(s) && !s.agent.as_ref().unwrap().forms.iter().any(|f| f.id == form)
    });
    assert!(!rt.state.agent.as_ref().unwrap().error);
    signal("done", "typed-question", Some(&form));
    signal("ready", "cancel-question", None);
    wait(&mut rt, "native cancelled question event", |s| {
        ready(s)
            && s.agent
                .as_ref()
                .unwrap()
                .forms
                .iter()
                .any(|f| f.title == "Rune native cancelled question")
    });
    let form = rt
        .state
        .agent
        .as_ref()
        .unwrap()
        .forms
        .iter()
        .find(|f| f.title == "Rune native cancelled question")
        .unwrap()
        .id
        .clone();
    capture(&rt, "cancel-question", "cancel-question");
    tap(&mut rt, "cancel-question");
    wait(&mut rt, "native question cancelled", |s| {
        ready(s) && !s.agent.as_ref().unwrap().forms.iter().any(|f| f.id == form)
    });
    assert!(!rt.state.agent.as_ref().unwrap().error);
    signal("done", "cancel-question", Some(&form));
    wait(&mut rt, "confirmed receipts reached the transcript", |s| {
        s.transcript_display.receipts.session_count() == 3
    });
    tap(&mut rt, "session-permission-receipts");
    let receipt_tree = rt.accessibility_json().to_string();
    for decision in ["once", "always", "reject"] {
        assert!(receipt_tree.contains(&format!("Motif réel Rune {decision} 🦀")));
    }
    assert!(rt.state.messages.is_empty());
    assert!(rt.state.agent.as_ref().unwrap().ids().is_empty());
    println!(
        "{}",
        json!({"type":"pending-live-complete","nativeWindow":false,"modelCalls":0,"toolCalls":0,"cases":5,"transcriptReceipts":3})
    );
}
