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
pub(super) fn wait_control(rt: &mut Runtime<State>, key: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while rt.find(key).is_none() {
        assert!(Instant::now() < deadline, "restore timeout: {key}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
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
        && s.reader.as_ref().is_none_or(|reader| !reader.blocks_send())
        && active_session(s).as_deref() == Some(id)
}
fn select(rt: &mut Runtime<State>, index: usize, id: &str) {
    let tab = format!("t-tab-{index}");
    wait_control(rt, &tab);
    tap(rt, &tab);
    wait(rt, "selected conversation", |s| ready(s, id));
}
fn open(rt: &mut Runtime<State>, title: &str, id: &str) {
    wait_control(rt, "browse");
    tap(rt, "browse");
    rt.resolve_file_dialog(Some(std::env::var("RUNE_TEST_FOLDER").unwrap().into()))
        .unwrap();
    rt.frame(1.0 / 60.0);
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
    let path = super::fragment_path(&reply, 0);
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
                e.path.contains(&path)
                    && e.text.as_deref().is_some_and(|s| {
                        let s = super::rendered_text(s);
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
    finish_backend();
}

#[cfg(target_os = "windows")]
fn finish_native(rt: Runtime<State>) {
    close_hidden_window(rt, |state, tx| {
        finish_window_state(state, tx);
        report(
            &std::env::var("RUNE_TEST_RESTORE_STAGE").unwrap(),
            true,
            true,
        );
    });
}

#[cfg(target_os = "windows")]
pub(super) fn close_hidden_window(rt: Runtime<State>, closed: fn(&mut State, &mut rune::Tx)) {
    let state = rt.state;
    rune::run_windows_with_args(Default::default(), [], move |_| {
        [rune::WindowSpec::new(
            "file-draft-restart",
            crate::layout::app_spec("Rune", init, view),
        )
        .options(rune::WindowOptions {
            visible: false,
            ..Default::default()
        })
        .state(state)
        .inactive()
        .on_created(|handle| handle.close())
        .on_close(closed)]
    });
    finish_backend();
}

#[cfg(target_os = "windows")]
pub(super) fn finish_window_state(state: &mut State, tx: &mut rune::Tx) {
    workspace::finish(state, tx);
    assert!(
        workspace::status(state).is_none(),
        "native close must flush the snapshot"
    );
}

fn report(stage: &str, native_window: bool, file_drafts: bool) {
    println!(
        "{}",
        json!({"type":"window-restore-stage","stage":stage,"occurrences":2,
        "selectedSession":"ses_created_2","draftsDistinct":true,"flushAndRelease":true,"nativeWindow":native_window,
        "fileDrafts":file_drafts})
    );
}

fn finish_backend() {
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
    let mut rt = Runtime::new(state, view, (1400.0, 1200.0), Env::new(true, 1.0));
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
            let (x, y) = rt.find("sessions-panel-resize").unwrap();
            rt.pointer_down(x, y);
            rt.frame(1.0 / 60.0);
            rt.pointer_move(x + 50.0, y);
            rt.frame(1.0 / 60.0);
            rt.pointer_up(x + 50.0, y);
            rt.frame(1.0 / 60.0);
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
    let shown_width = rt
        .elements()
        .into_iter()
        .find(|element| element.key.as_deref() == Some("sessions-panel"))
        .expect("restored docked sessions panel")
        .rect[2];
    assert_eq!(shown_width, 390.0);
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().snapshot().panel_widths[0],
        Some(390)
    );
    if stage != "prepare" {
        let saved = rt.state.workspace.as_ref().unwrap().snapshot();
        assert!(saved.tabs.iter().all(
            |tab| matches!(tab, Tab::Workspace(w) if w.drafts.values().all(String::is_empty))
        ));
    }
    let file_drafts = std::env::var("RUNE_TEST_FILE_DRAFTS").as_deref() == Ok("1");
    if file_drafts {
        rt.update(|state, _| state.files.as_mut().unwrap().open("draft.txt".into()));
        wait(&mut rt, "file draft baseline verified", |state| {
            state.files.as_ref().is_some_and(|files| {
                files.reader.receipt().1 && files.document.editable() && !files.reader.busy()
            })
        });
        const TEXT: &str = "retained · été 日本語 🦀";
        if stage == "prepare" {
            assert!(!workspace::file_wrap(&rt.state));
            tap(&mut rt, "file-wrap");
            super::files_document::edit(&mut rt, TEXT);
        }
        assert!(
            workspace::file_wrap(&rt.state),
            "source wrap survives relaunch"
        );
        let doc = &rt.state.files.as_ref().unwrap().document;
        assert!(doc.dirty());
        assert!(!doc.not_retained());
        assert_eq!(doc.edit().text, TEXT);
        assert_eq!(
            matches!(
                doc.error(),
                Some(crate::files::document::store::Error::Conflict(_))
            ),
            stage == "verify"
        );
    }
    let native_window = cfg!(target_os = "windows") && file_drafts;
    #[cfg(target_os = "windows")]
    if native_window {
        finish_native(rt);
        return;
    } else {
        finish(rt);
    }
    #[cfg(not(target_os = "windows"))]
    finish(rt);
    report(&stage, native_window, file_drafts);
}
