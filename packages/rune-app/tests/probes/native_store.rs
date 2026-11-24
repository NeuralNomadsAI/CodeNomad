use super::window_restore::{finish, tap, type_text, wait, wait_control};
use crate::{
    Phase, State, init, poll, request_older, view,
    workspace::{self, Tab},
};
use rune::{Env, Runtime, text::TextSystem};
use serde_json::{Value, json};

const LONG: &str = "Longue · été 🦀\nbrouillon conservé";
const UPDATED: &str = "Longue · reprise 🦀\nbrouillon modifié";
const EMPTY: &str = "Vide · 日本語 🦀\nautre brouillon";

fn ready(s: &State, id: &str) -> bool {
    let Some(ui) = &s.workspace else { return false };
    let saved = ui.snapshot();
    workspace::input_ready(s)
        && !s.screen.is_launcher()
        && s.phase == Phase::Ready
        && matches!(saved.active.and_then(|i| saved.tabs.get(i)), Some(Tab::Workspace(w)) if w.active_session_id.as_deref() == Some(id))
}
fn select(rt: &mut Runtime<State>, index: usize, id: &str) {
    let tab = format!("t-tab-{index}");
    wait_control(rt, &tab);
    tap(rt, &tab);
    wait(rt, "selected native session", |s| ready(s, id));
}
fn open(rt: &mut Runtime<State>, id: &str, title: &str) {
    wait_control(rt, "folder-path");
    type_text(
        rt,
        "folder-path",
        &std::env::var("RUNE_TEST_FOLDER").unwrap(),
    );
    tap(rt, "open-folder");
    wait(rt, "native project catalogue", |s| {
        s.screen
            .launcher()
            .is_some_and(|l| l.project.is_some() && !l.pending)
    });
    type_text(rt, "session-search", title);
    while !rt
        .state
        .screen
        .launcher()
        .unwrap()
        .sessions
        .iter()
        .any(|s| s.id == id)
    {
        let before = rt.state.screen.launcher().unwrap().sessions.len();
        assert!(before < 600, "bounded native catalogue traversal");
        assert!(rt.state.screen.launcher().unwrap().next.is_some());
        tap(rt, "more-sessions");
        wait(rt, "next native catalogue page", |s| {
            s.screen
                .launcher()
                .is_some_and(|l| !l.pending && l.sessions.len() > before)
        });
    }
    tap(rt, &format!("session-{id}"));
    wait(rt, "native session history", |s| ready(s, id));
}
fn canonical(rt: &Runtime<State>, rows: &[Value]) {
    let count = rt.state.messages.len();
    assert!(matches!(count, 200 | 600));
    for (actual, expected) in rt.state.messages.iter().zip(&rows[rows.len() - count..]) {
        assert_eq!(actual.id, expected["id"]);
        assert_eq!(actual.body, expected["text"]);
        assert_eq!(actual.role, "user");
    }
    let unique: std::collections::HashSet<_> = rt.state.messages.iter().map(|m| &m.id).collect();
    assert_eq!(unique.len(), count);
}
fn paginate(rt: &mut Runtime<State>, rows: &[Value]) -> f32 {
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let anchor = rt
        .elements()
        .into_iter()
        .find(|e| {
            e.visible[3] > 2.0
                && rt
                    .state
                    .messages
                    .iter()
                    .any(|m| e.key.as_deref() == Some(&m.id))
        })
        .expect("visible native message");
    let mut jump = 0.0f32;
    let mut pages = 0;
    while rt.state.messages.len() < rows.len() {
        let before = rt.state.messages.len();
        assert!(rt.state.can_older && pages < 8, "bounded native pagination");
        rt.update(request_older);
        wait(rt, "older stored native page", |s| {
            !s.paging && s.messages.len() > before
        });
        let retained = rt
            .elements()
            .into_iter()
            .find(|e| e.path == anchor.path)
            .expect("reading anchor retained");
        jump = jump.max((retained.rect[1] - anchor.rect[1]).abs());
        assert!(jump < 0.5, "native reading anchor jumped by {jump}");
        pages += 1;
    }
    assert!(!rt.state.can_older);
    canonical(rt, rows);
    jump
}
fn snapshot(rt: &mut Runtime<State>, long: &str, empty: &str, draft: &str) {
    rt.update(|s, _| workspace::capture(s));
    let saved = rt.state.workspace.as_ref().unwrap().snapshot();
    assert_eq!(saved.tabs.len(), 2);
    let tabs: Vec<_> = saved
        .tabs
        .iter()
        .map(|t| match t {
            Tab::Workspace(w) => w,
            _ => panic!("native workspace required"),
        })
        .collect();
    assert_eq!(tabs[0].folder, tabs[1].folder);
    assert_ne!(tabs[0].occurrence, tabs[1].occurrence);
    assert_ne!(tabs[0].workspace_id, tabs[1].workspace_id);
    assert_eq!(tabs[0].active_session_id.as_deref(), Some(long));
    assert_eq!(tabs[1].active_session_id.as_deref(), Some(empty));
    assert_eq!(tabs[0].drafts.get(long).map(String::as_str), Some(draft));
    assert_eq!(tabs[1].drafts.get(empty).map(String::as_str), Some(EMPTY));
}
pub fn run() {
    assert!(
        std::env::var("CODENOMAD_PROFILE")
            .unwrap()
            .starts_with("trial-")
    );
    assert!(std::env::var_os("RUNE_STATE_DIR").is_some());
    assert!(std::env::var_os("RUNE_WORKSPACE").is_none());
    assert!(std::env::var_os("RUNE_SESSION").is_none());
    let stage = std::env::var("RUNE_TEST_RESTORE_STAGE").unwrap();
    let long = std::env::var("RUNE_STORE_LONG_SESSION").unwrap();
    let empty = std::env::var("RUNE_STORE_EMPTY_SESSION").unwrap();
    let rows: Vec<Value> = serde_json::from_slice(
        &std::fs::read(std::env::var("RUNE_STORE_SEED_FILE").unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(rows.len(), 600);
    let spec = rune_theme_codenomad::layout::app_spec("Rune", init, view);
    let text = TextSystem::for_window(spec.fonts, spec.families);
    let mut state = init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::with_text(state, view, (1100.0, 1200.0), Env::new(true, 1.0), text);
    rt.poll = Some(poll);
    rt.frame(0.0);
    tap(&mut rt, "connect");
    wait(&mut rt, "native authenticated store", |s| {
        workspace::input_ready(s)
            && s.screen
                .launcher()
                .is_some_and(|l| l.connection.is_some() && !l.pending)
    });
    let mut jump = 0.0;
    match stage.as_str() {
        "prepare" => {
            open(&mut rt, &long, "Rune native stored-history test");
            assert_eq!(rt.state.messages.len(), 200);
            canonical(&rt, &rows);
            type_text(&mut rt, "composer", LONG);
            tap(&mut rt, "project-tabs-new");
            open(&mut rt, &empty, "Rune native empty-session test");
            assert!(rt.state.messages.is_empty());
            type_text(&mut rt, "composer", EMPTY);
            select(&mut rt, 0, &long);
            assert_eq!(rt.state.draft.text, LONG);
            snapshot(&mut rt, &long, &empty, LONG);
        }
        "resume" => {
            wait(&mut rt, "automatic long session", |s| ready(s, &long));
            assert_eq!(rt.state.draft.text, LONG);
            assert_eq!(rt.state.messages.len(), 200);
            canonical(&rt, &rows);
            jump = paginate(&mut rt, &rows);
            type_text(&mut rt, "composer", UPDATED);
            select(&mut rt, 1, &empty);
            assert!(rt.state.messages.is_empty());
            assert_eq!(rt.state.draft.text, EMPTY);
            snapshot(&mut rt, &long, &empty, UPDATED);
        }
        "verify" => {
            wait(&mut rt, "automatic empty session", |s| ready(s, &empty));
            assert!(rt.state.messages.is_empty());
            assert_eq!(rt.state.draft.text, EMPTY);
            select(&mut rt, 0, &long);
            assert_eq!(rt.state.draft.text, UPDATED);
            assert_eq!(rt.state.messages.len(), 200);
            canonical(&rt, &rows);
            snapshot(&mut rt, &long, &empty, UPDATED);
        }
        _ => panic!("unknown native restore stage"),
    }
    let proof = json!({"type":"native-store-stage","stage":stage,"nativeRowsChecked":if stage == "resume" {600} else {200},"occurrences":2,"draftsDistinct":true,"maxAnchorJumpPoints":jump,"nativeWindow":false,"scopedChat":false});
    finish(rt);
    println!("{proof}");
}
