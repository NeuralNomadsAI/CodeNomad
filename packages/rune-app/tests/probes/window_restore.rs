use crate::{
    Phase, State, init, platform, poll, view,
    workspace::{self, Tab},
};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::json;
use std::time::{Duration, Instant};

const ALPHA: &str = "Alpha · été 🦀\npremier brouillon";
const BETA: &str = "Bêta · 日本語 🦀\nsecond brouillon";

pub(super) fn wait(rt: &mut Runtime<State>, label: &str, condition: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition(&rt.state) {
        assert!(Instant::now() < deadline, "restore timeout: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
}
pub(super) fn tap(rt: &mut Runtime<State>, key: &str) {
    rt.update(|_, tx| {
        tx.scroll_into_view(key);
        tx.instant();
    });
    for _ in 0..3 {
        rt.frame(1.0 / 60.0);
    }
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing restore control: {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}
pub(super) fn type_text(rt: &mut Runtime<State>, field: &str, text: &str) {
    tap(rt, field);
    rt.key(KeyEvent {
        key: Key::Command('a'),
        mods: Mods {
            cmd: true,
            ctrl: true,
            ..Mods::default()
        },
    });
    rt.key(KeyEvent {
        key: Key::Text(text.into()),
        mods: Mods::default(),
    });
    rt.frame(1.0 / 60.0);
}
fn active_session(s: &State) -> Option<String> {
    let saved = s.workspace.as_ref()?.snapshot();
    match saved.tabs.get(saved.active?)? {
        Tab::Workspace(w) => w.active_session_id.clone(),
        _ => None,
    }
}
fn ready(s: &State, id: &str) -> bool {
    workspace::input_ready(s)
        && !s.screen.is_launcher()
        && s.phase == Phase::Ready
        && active_session(s).as_deref() == Some(id)
}
fn select(rt: &mut Runtime<State>, index: usize, id: &str) {
    tap(rt, &format!("t-tab-{index}"));
    wait(rt, "selected conversation", |s| ready(s, id));
}
fn open(rt: &mut Runtime<State>, title: &str, id: &str) {
    type_text(
        rt,
        "folder-path",
        &std::env::var("RUNE_TEST_FOLDER").unwrap(),
    );
    tap(rt, "open-folder");
    wait(rt, "new occurrence", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| l.project.is_some() && !l.pending)
    });
    type_text(rt, "session-title", title);
    tap(rt, "create-session");
    wait(rt, "new conversation", |s| ready(s, id));
    assert!(rt.state.messages.is_empty());
}
fn occurrences(rt: &mut Runtime<State>) {
    rt.update(|s, _| workspace::capture(s));
    let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
    assert_eq!(snapshot.tabs.len(), 2);
    let rows: Vec<_> = snapshot
        .tabs
        .iter()
        .map(|tab| match tab {
            Tab::Workspace(w) => w,
            _ => panic!("workspace required"),
        })
        .collect();
    assert_eq!(rows[0].folder, rows[1].folder);
    assert_ne!(rows[0].occurrence, rows[1].occurrence);
    assert_ne!(rows[0].workspace_id, rows[1].workspace_id);
    assert_eq!(rows[0].active_session_id.as_deref(), Some("ses_created_1"));
    assert_eq!(rows[1].active_session_id.as_deref(), Some("ses_created_2"));
}
fn send(rt: &mut Runtime<State>, id: &str, turn: usize, prompt: &str) {
    assert_eq!(rt.state.draft.text, prompt);
    tap(rt, "send");
    assert!(rt.state.draft.text.is_empty(), "submitted composer clears");
    let reply = format!("reply-{id}-{turn}");
    let key = format!("body-{reply}");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut visible = false;
    while rt.state.phase != Phase::Ready {
        assert!(Instant::now() < deadline, "restore streaming timeout");
        rt.frame(1.0 / 60.0);
        if !visible
            && rt.state.phase == Phase::Streaming
            && rt
                .state
                .messages
                .iter()
                .any(|m| m.id == reply && !m.completed)
        {
            if let Some(element) = rt.elements().into_iter().find(|e| {
                e.key.as_deref() == Some(key.as_str())
                    && e.text.as_deref().is_some_and(|s| {
                        s.starts_with("fn main") && s.contains(&format!("tour {turn}"))
                    })
                    && !e.exiting
                    && e.opacity > 0.99
                    && e.visible[2] >= 50.0
                    && e.visible[3] >= 28.0
                    && e.visible[0] <= e.rect[0] + 0.5
                    && e.visible[1] <= e.rect[1] + 0.5
            }) {
                println!(
                    "{}",
                    json!({"type":"window-restore-stream-visible","turn":turn,
                    "sessionID":id,"assistantMessageID":reply,"phase":"Streaming",
                    "path":element.path,"key":element.key,"rect":element.rect,"visible":element.visible})
                );
                visible = true;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        visible,
        "intermediate text must reach the actual Runtime element before completion"
    );
    history(rt, turn, prompt);
}
fn history(rt: &Runtime<State>, turn: usize, prompt: &str) {
    assert_eq!(rt.state.messages.len(), 2);
    assert_eq!(rt.state.messages[0].role, "user");
    assert_eq!(rt.state.messages[0].body, prompt);
    let encoded = serde_json::to_string(&format!("Rune · tour {turn}: {prompt}")).unwrap();
    assert_eq!(
        rt.state.messages[1].body,
        format!("fn main() {{\n    println!({encoded});\n}}")
    );
    assert!(rt.state.messages[1].completed);
    assert!(rt.state.draft.text.is_empty());
}
pub(super) fn finish(mut rt: Runtime<State>) {
    rt.update(workspace::finish);
    assert!(
        workspace::status(&rt.state).is_none(),
        "snapshot must flush successfully"
    );
    drop(rt);
    platform::finish();
    platform::block_on(async {
        let backend = crate::backend::Backend::connect(
            &std::env::var("RUNE_BACKEND").unwrap(),
            &std::env::var("RUNE_PASSWORD").unwrap(),
        )
        .await
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !backend.projects().await.unwrap().is_empty() {
            assert!(Instant::now() < deadline, "owned records must be released");
            platform::sleep(Duration::from_millis(10)).await;
        }
    });
}
pub fn run() {
    assert!(
        std::env::var("CODENOMAD_PROFILE")
            .unwrap()
            .starts_with("trial-")
    );
    assert!(std::env::var_os("RUNE_STATE_DIR").is_some());
    let stage = std::env::var("RUNE_TEST_RESTORE_STAGE").unwrap();
    assert!(matches!(stage.as_str(), "prepare" | "resume" | "verify"));
    let mut state = init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(state, view, (1100.0, 1200.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    tap(&mut rt, "connect");
    wait(&mut rt, "authenticated workspace store", |s| {
        workspace::input_ready(s)
            && s.screen
                .launcher()
                .is_some_and(|l| l.connection.is_some() && !l.pending)
    });
    match stage.as_str() {
        "prepare" => {
            open(&mut rt, "Alpha", "ses_created_1");
            type_text(&mut rt, "composer", ALPHA);
            assert_eq!(rt.state.draft.text, ALPHA);
            tap(&mut rt, "project-tabs-new");
            open(&mut rt, "Beta", "ses_created_2");
            type_text(&mut rt, "composer", BETA);
            assert_eq!(rt.state.draft.text, BETA);
            select(&mut rt, 0, "ses_created_1");
            assert_eq!(rt.state.draft.text, ALPHA);
            select(&mut rt, 1, "ses_created_2");
            assert_eq!(rt.state.draft.text, BETA);
        }
        "resume" => {
            wait(&mut rt, "automatic selected Beta", |s| {
                ready(s, "ses_created_2")
            });
            assert_eq!(rt.state.draft.text, BETA);
            assert!(rt.state.messages.is_empty());
            select(&mut rt, 0, "ses_created_1");
            assert_eq!(rt.state.draft.text, ALPHA);
            select(&mut rt, 1, "ses_created_2");
            assert_eq!(rt.state.draft.text, BETA);
            send(&mut rt, "ses_created_2", 1, BETA);
            select(&mut rt, 0, "ses_created_1");
            send(&mut rt, "ses_created_1", 2, ALPHA);
            select(&mut rt, 1, "ses_created_2");
            history(&rt, 1, BETA);
            select(&mut rt, 0, "ses_created_1");
            history(&rt, 2, ALPHA);
            select(&mut rt, 1, "ses_created_2");
        }
        "verify" => {
            wait(&mut rt, "read-only selected Beta", |s| {
                ready(s, "ses_created_2")
            });
            history(&rt, 1, BETA);
            select(&mut rt, 0, "ses_created_1");
            history(&rt, 2, ALPHA);
            select(&mut rt, 1, "ses_created_2");
            history(&rt, 1, BETA);
        }
        _ => unreachable!(),
    }
    occurrences(&mut rt);
    if stage != "prepare" {
        let saved = rt.state.workspace.as_ref().unwrap().snapshot();
        assert!(saved.tabs.iter().all(
            |tab| matches!(tab, Tab::Workspace(w) if w.drafts.values().all(String::is_empty))
        ));
    }
    finish(rt);
    println!(
        "{}",
        json!({"type":"window-restore-stage","stage":stage,"occurrences":2,
        "selectedSession":"ses_created_2","draftsDistinct":true,"flushAndRelease":true,"nativeWindow":false})
    );
}
