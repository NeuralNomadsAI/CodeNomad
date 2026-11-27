//! Background-only exercise of the real Rune widgets and opening actions.
use crate::{Phase, State, init, launcher, poll, view};
use rune::{Env, Runtime, edit::TextEdit};
use serde_json::json;
use std::io::Write;
use std::time::{Duration, Instant};
fn wait(rt: &mut Runtime<State>, label: &str, predicate: impl Fn(&State) -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while !predicate(&rt.state) {
        assert!(Instant::now() < until, "launcher timeout: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
}
fn tap(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing launcher action {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}
pub fn run() {
    let mut state = init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    assert!(state.screen.is_launcher() && state.screen.launcher().is_some());
    let mut rt = Runtime::new(state, view, (1100.0, 1000.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    rt.state.screen.launcher_mut().unwrap().password = TextEdit::new("wrong-test-password");
    tap(&mut rt, "connect");
    wait(&mut rt, "bad login", |s| {
        s.screen.launcher().unwrap().error.is_some()
    });
    assert!(rt.state.screen.launcher().unwrap().connection.is_none());
    let password = std::env::var("RUNE_PASSWORD")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "fixture-backend".into());
    rt.state.screen.launcher_mut().unwrap().password = TextEdit::new(password);
    tap(&mut rt, "connect");
    wait(&mut rt, "connect", |s| {
        s.screen.launcher().unwrap().connection.is_some()
    });
    assert!(rt.state.screen.launcher().unwrap().password.text.is_empty());
    super::window_restore::wait_control(&mut rt, "folder-path");
    let folder = std::env::var("RUNE_TEST_FOLDER").unwrap();
    super::window_restore::type_text(&mut rt, "folder-path", "relative-invalid");
    tap(&mut rt, "open-folder");
    wait(&mut rt, "bad folder", |s| {
        s.screen.launcher().unwrap().error.is_some()
    });
    tap(&mut rt, "browse");
    assert_eq!(
        rt.file_dialog().unwrap().0,
        rune::file_dialog::FileDialogKind::Folder
    );
    rt.resolve_file_dialog(None).unwrap();
    rt.frame(1.0 / 60.0);
    assert!(rt.state.screen.launcher().unwrap().project.is_none());
    tap(&mut rt, "browse");
    rt.resolve_file_dialog(Some(folder.into())).unwrap();
    rt.frame(1.0 / 60.0);
    wait(&mut rt, "folder sessions", |s| {
        s.screen.launcher().unwrap().project.is_some()
    });
    assert_eq!(rt.state.screen.launcher().unwrap().sessions.len(), 1);
    tap(&mut rt, "more-sessions");
    wait(&mut rt, "catalog next page", |s| {
        s.screen.launcher().unwrap().sessions.len() == 2
    });
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "existing history", |s| {
        !s.screen.is_launcher() && s.phase == Phase::Ready
    });
    assert_eq!(rt.state.messages.len(), 2);
    assert_eq!(rt.state.messages[0].body, "Existing project history");
    rt.state.draft = TextEdit::new("unsent draft");
    rt.frame(1.0 / 60.0);
    tap(&mut rt, "sessions-panel-toggle");
    assert!(rt.find("session-ses_existing").is_none());
    tap(&mut rt, "sessions-panel-toggle");
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "restore existing draft", |s| {
        !s.screen.is_launcher() && s.phase == Phase::Ready
    });
    assert_eq!(rt.state.draft.text, "unsent draft");
    rt.state.draft = TextEdit::new("");
    launcher::back(&mut rt.state);
    wait(&mut rt, "return session list", |s| {
        !s.screen.launcher().unwrap().pending
    });
    super::window_restore::type_text(&mut rt, "session-title", "Rune functional test");
    tap(&mut rt, "create-session");
    if std::env::var_os("RUNE_TEST_CREATE_UNCERTAIN").is_some() {
        wait(&mut rt, "uncertain create", |s| {
            s.screen.launcher().unwrap().creation_uncertain
        });
        rt.update(|s, tx| launcher::create(s, tx));
        assert!(
            !rt.state.screen.launcher().unwrap().pending,
            "no repeated creation"
        );
        tap(&mut rt, "refresh-sessions");
        wait(&mut rt, "reconcile create", |s| {
            !s.screen.launcher().unwrap().pending
        });
        tap(&mut rt, "more-sessions");
        wait(&mut rt, "find created session", |s| {
            s.screen.launcher().unwrap().sessions.len() == 3
        });
        tap(&mut rt, "session-ses_created_1");
    }
    wait(&mut rt, "fresh session", |s| {
        !s.screen.is_launcher() && s.phase == Phase::Ready
    });
    assert!(rt.state.messages.is_empty());
    let mut fragments = 0;
    let mut tool_running = false;
    let with_tools = std::env::var_os("RUNE_TEST_TOOLS").is_some();
    for turn in 1..=2 {
        let mut visible = false;
        let mut saw_live_input = false;
        let mut saw_live_progress = false;
        rt.update(move |s, _| {
            s.draft = TextEdit::new(format!("Functional turn {turn} · été 日本語 🦀"));
        });
        rt.frame(1.0 / 60.0);
        tap(&mut rt, "send");
        let until = Instant::now() + Duration::from_secs(20);
        while rt.state.phase != Phase::Ready {
            assert!(Instant::now() < until, "send {turn}");
            rt.frame(1.0 / 60.0);
            let id = format!("reply-ses_created_1-{turn}");
            let path = super::fragment_path(&id, usize::from(with_tools));
            let row = rt.state.messages.iter().find(|m| m.id == id);
            if with_tools && let Some(row) = row {
                saw_live_input |= row.parts.iter().any(|p| {
                    matches!(p, crate::content::Part::Tool(t) if t.status == "streaming" && t.input == r#"{"command":"fixture"}"#)
                });
                let marker = format!("Live output {turn}");
                saw_live_progress |= row.parts.iter().any(|p| {
                    matches!(p, crate::content::Part::Tool(t) if t.status == "running" && t.metadata["output"].as_str().is_some_and(|value| value.ends_with(&marker)))
                }) && rt.elements().iter().any(|e| {
                    e.text.as_deref().is_some_and(|text| text.contains(&marker))
                        && e.visible[2] > 0.0 && e.visible[3] > 0.0
                });
            }
            let after_tool = row.is_some_and(|m| {
                m.parts
                    .iter()
                    .any(|p| matches!(p,crate::content::Part::Tool(t) if t.status=="completed"))
            });
            if !visible
                && rt.state.phase == Phase::Streaming
                && row.is_some_and(|m| m.role == "assistant" && !m.completed)
                && (!with_tools || after_tool)
            {
                let matches: Vec<_> = rt
                    .elements()
                    .into_iter()
                    .filter(|e| {
                        e.path.contains(&path)
                            && e.text
                                .as_deref()
                                .is_some_and(|t| super::rendered_text(t).starts_with("fn main"))
                            && !e.exiting
                            && e.opacity > 0.99
                            && e.visible[2] >= 50.0
                            && e.visible[3] >= 14.0
                            && e.visible[0] <= e.rect[0] + 0.5
                            && e.visible[1] <= e.rect[1] + 0.5
                    })
                    .collect();
                if let [element] = matches.as_slice() {
                    assert_eq!(rt.state.messages.iter().filter(|m| m.id == id).count(), 1);
                    println!(
                        "{}",
                        json!({"type":"launcher-stream-visible","turn":turn,"assistantMessageID":id,
                        "afterTool":after_tool,"phase":"Streaming","path":element.path,"key":element.key,
                        "rect":element.rect,"visible":element.visible,"prefix":"fn main"})
                    );
                    std::io::stdout().flush().unwrap();
                    visible = true;
                }
            }
            tool_running |= rt
                .state
                .messages
                .iter()
                .flat_map(|m| &m.parts)
                .any(|p| matches!(p,crate::content::Part::Tool(t) if t.status=="running"));
            if rt
                .state
                .messages
                .last()
                .is_some_and(|m| m.role == "assistant" && !m.body.is_empty())
            {
                fragments += 1;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(rt.state.messages.len(), turn * 2);
        assert!(
            visible,
            "new assistant code must reach its clipped ElementInfo before completion"
        );
        if with_tools {
            assert!(
                saw_live_input,
                "tool input deltas must arrive before the call"
            );
            assert!(
                saw_live_progress,
                "SSE-only tool output must be visible before completion"
            );
        }
        assert!(rt.state.messages.last().unwrap().parts.iter().all(|p|!matches!(p,crate::content::Part::Text(t) if t.provenance!=crate::content::TextProvenance::Closed)),"native text endings must close every fragment");
        assert!(
            rt.state
                .messages
                .last()
                .unwrap()
                .body
                .contains(&format!("tour {turn}"))
        );
    }
    assert!(fragments > 2, "actual intermediate text observed");
    if std::env::var_os("RUNE_TEST_TOOLS").is_some() {
        assert!(tool_running, "live tool running state must reach the view");
        assert_eq!(
            rt.state
                .messages
                .iter()
                .flat_map(|m| &m.parts)
                .filter(|p| matches!(p,crate::content::Part::Tool(t) if t.status=="completed"))
                .count(),
            2
        );
    }
    launcher::back(&mut rt.state);
    wait(&mut rt, "relist created session", |s| {
        !s.screen.launcher().unwrap().pending
    });
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "reopen existing", |s| {
        !s.screen.is_launcher() && s.phase == Phase::Ready
    });
    assert_eq!(rt.state.messages.len(), 2);
    assert_eq!(rt.state.messages[0].body, "Existing project history");
    println!(
        "launcher probe: login failure/retry, folder failure/retry, scripted folder picker/cancel, 2 catalog pages, existing history, draft guard, create, 2 streaming sends, scoped reopen; intermediate frames={fragments}; no window or clipboard"
    );
}
