use super::window_restore::{finish, tap, type_text, wait, wait_control};
use crate::{
    Phase, State, init, poll, view,
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
        click_more(rt);
        wait(rt, "next native catalogue page", |s| {
            s.screen
                .launcher()
                .is_some_and(|l| !l.pending && l.sessions.len() > before)
        });
    }
    tap(rt, "session-search-toggle");
    type_text(rt, "session-search", title);
    tap(rt, &format!("session-{id}"));
    wait(rt, "native session history", |s| ready(s, id));
}

fn click_more(rt: &mut Runtime<State>) {
    let (wheel_x, wheel_y) = rt.find("session-list").expect("session viewport");
    let (node, x, y, picked) = (0..=12)
        .find_map(|step| {
            if step != 0 {
                rt.wheel(wheel_x, wheel_y, -1200.0);
                for _ in 0..18 {
                    rt.frame(1.0 / 60.0);
                }
            }
            let node = rt.elements().into_iter().find(|e| {
                e.key.as_deref() == Some("more-sessions")
                    && !e.exiting
                    && e.visible[2] > 0.0
                    && e.visible[3] > 0.0
            })?;
            let [x, y, w, h] = node.visible;
            let (x, y) = (x + w / 2.0, y + h / 2.0);
            let picked = rt.element_at(x, y)?.path().to_owned();
            (picked == node.path || picked.starts_with(&format!("{}/", node.path)))
                .then_some((node, x, y, picked))
        })
        .expect("More button must be reachable by scrolling the session list");
    let eligible = rt
        .state
        .screen
        .launcher()
        .is_some_and(|l| l.can_page() && !l.pending);
    let start = std::time::Instant::now();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    let micros = start.elapsed().as_micros();
    assert!(micros < 500_000, "pagination must use a short click");
    rt.frame(1.0 / 60.0);
    let pending = rt.state.screen.launcher().is_some_and(|l| l.pending);
    println!(
        "{}",
        json!({"type":"native-store-catalogue-click","rect":node.rect,"visible":node.visible,
            "point":[x,y],"picked":picked,"focusable":node.focusable,"inert":node.inert,
            "eligible":eligible,"clickUs":micros,"pendingAfterClick":pending})
    );
}

fn canonical(rt: &Runtime<State>, rows: &[Value]) {
    assert_eq!(rt.state.messages.len(), rows.len());
    for (actual, expected) in rt.state.messages.iter().zip(rows) {
        assert_eq!(actual.id, expected["id"]);
        assert_eq!(actual.body, expected["text"]);
        assert_eq!(actual.role, "user");
    }
    let unique: std::collections::HashSet<_> = rt.state.messages.iter().map(|m| &m.id).collect();
    assert_eq!(unique.len(), rows.len());
}
fn paginate(rt: &mut Runtime<State>, rows: &[Value]) -> f32 {
    let mut jump = 0.0f32;
    for (first, end) in [(216, 416), (32, 232), (0, 48)] {
        assert!(rt.state.can_older, "older native page available");
        let (x, y) = rt.find("history").expect("transcript viewport");
        let id = rt.state.messages[0].id.clone();
        let at_top = |rt: &Runtime<State>| {
            let nodes = rt.elements();
            let history = nodes
                .iter()
                .find(|node| node.key.as_deref() == Some("history"))
                .unwrap();
            nodes.iter().any(|node| {
                node.key.as_deref() == Some(&id)
                    && node.visible[3] > 2.0
                    && (node.rect[1] - history.rect[1]).abs() < 1.0
            })
        };
        for _ in 0..24 {
            if at_top(rt) {
                break;
            }
            rt.wheel(x, y, 1200.0);
            rt.frame(1.0 / 60.0);
        }
        assert!(at_top(rt), "reach the top of the current history window");
        let anchor = super::recovery::anchor(rt);
        let (x, y) = rt.find("older").expect("visible Previous messages control");
        assert!(
            rt.element_at(x, y)
                .is_some_and(|hit| { hit.path().split('/').any(|key| key == "older") }),
            "Previous messages must own the click"
        );
        let start = std::time::Instant::now();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        assert!(start.elapsed() < std::time::Duration::from_millis(500));
        rt.frame(1.0 / 60.0);
        assert!(rt.state.paging, "the click must request the older window");
        wait(rt, "older stored native page", |s| !s.paging);
        canonical(rt, &rows[first..end]);
        jump = jump.max(super::recovery::check_anchor(rt, &anchor));
    }
    assert!(!rt.state.can_older);
    tap(rt, "latest");
    wait(rt, "latest stored native page", |s| {
        s.phase == Phase::Ready && !s.history_detached && s.messages.len() == 200
    });
    canonical(rt, &rows[400..]);
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
            canonical(&rt, &rows[400..]);
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
            canonical(&rt, &rows[400..]);
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
            canonical(&rt, &rows[400..]);
            snapshot(&mut rt, &long, &empty, UPDATED);
        }
        _ => panic!("unknown native restore stage"),
    }
    let proof = json!({"type":"native-store-stage","stage":stage,"nativeRowsChecked":if stage == "resume" {600} else {200},"occurrences":2,"draftsDistinct":true,"maxAnchorJumpPoints":jump,"nativeWindow":false,"scopedChat":false});
    finish(rt);
    println!("{proof}");
}
