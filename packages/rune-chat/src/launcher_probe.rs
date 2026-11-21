//! Background-only exercise of the real Rune widgets and opening actions.
use crate::{Phase, State, init, launcher, poll, view};
use rune::{Env, Runtime, edit::TextEdit};
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
    assert!(state.launcher_visible && state.launcher.is_some());
    let mut rt = Runtime::new(state, view, (1100.0, 1000.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    rt.state.launcher.as_mut().unwrap().password = TextEdit::new("wrong-test-password");
    tap(&mut rt, "connect");
    wait(&mut rt, "bad login", |s| {
        s.launcher.as_ref().unwrap().error.is_some()
    });
    assert!(rt.state.launcher.as_ref().unwrap().connection.is_none());
    rt.state.launcher.as_mut().unwrap().password = TextEdit::new("fixture-backend");
    tap(&mut rt, "connect");
    wait(&mut rt, "connect", |s| {
        s.launcher.as_ref().unwrap().connection.is_some()
    });
    assert!(rt.state.launcher.as_ref().unwrap().password.text.is_empty());
    let folder = std::env::var("RUNE_TEST_FOLDER").unwrap();
    rt.state.launcher.as_mut().unwrap().folder = TextEdit::new("relative-invalid");
    rt.frame(1.0 / 60.0);
    tap(&mut rt, "open-folder");
    wait(&mut rt, "bad folder", |s| {
        s.launcher.as_ref().unwrap().error.is_some()
    });
    tap(&mut rt, "browse");
    assert_eq!(
        rt.file_dialog().unwrap().0,
        rune::file_dialog::FileDialogKind::Folder
    );
    rt.resolve_file_dialog(None).unwrap();
    rt.frame(1.0 / 60.0);
    assert!(rt.state.launcher.as_ref().unwrap().project.is_none());
    tap(&mut rt, "browse");
    rt.resolve_file_dialog(Some(folder.into())).unwrap();
    rt.frame(1.0 / 60.0);
    wait(&mut rt, "folder sessions", |s| {
        s.launcher.as_ref().unwrap().project.is_some()
    });
    assert_eq!(rt.state.launcher.as_ref().unwrap().sessions.len(), 1);
    tap(&mut rt, "more-sessions");
    wait(&mut rt, "catalog next page", |s| {
        s.launcher.as_ref().unwrap().sessions.len() == 2
    });
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "existing history", |s| {
        !s.launcher_visible && s.phase == Phase::Ready
    });
    assert_eq!(rt.state.messages.len(), 2);
    assert_eq!(rt.state.messages[0].body, "Existing project history");
    rt.state.draft = TextEdit::new("unsent draft");
    launcher::back(&mut rt.state);
    assert!(!rt.state.launcher_visible);
    assert_eq!(rt.state.draft.text, "unsent draft");
    rt.state.draft = TextEdit::new("");
    launcher::back(&mut rt.state);
    wait(&mut rt, "return session list", |s| {
        !s.launcher.as_ref().unwrap().pending
    });
    rt.state.launcher.as_mut().unwrap().title = TextEdit::new("Rune functional test");
    rt.frame(1.0 / 60.0);
    tap(&mut rt, "create-session");
    if std::env::var_os("RUNE_TEST_CREATE_UNCERTAIN").is_some() {
        wait(&mut rt, "uncertain create", |s| {
            s.launcher.as_ref().unwrap().creation_uncertain
        });
        rt.update(|s, tx| launcher::create(s, tx));
        assert!(
            !rt.state.launcher.as_ref().unwrap().pending,
            "no repeated creation"
        );
        tap(&mut rt, "refresh-sessions");
        wait(&mut rt, "reconcile create", |s| {
            !s.launcher.as_ref().unwrap().pending
        });
        tap(&mut rt, "more-sessions");
        wait(&mut rt, "find created session", |s| {
            s.launcher.as_ref().unwrap().sessions.len() == 3
        });
        tap(&mut rt, "session-ses_created_1");
    }
    wait(&mut rt, "fresh session", |s| {
        !s.launcher_visible && s.phase == Phase::Ready
    });
    assert!(rt.state.messages.is_empty());
    let mut fragments = 0;
    for turn in 1..=2 {
        rt.state.draft = TextEdit::new(format!("Functional turn {turn} · été 日本語 🦀"));
        rt.frame(1.0 / 60.0);
        tap(&mut rt, "send");
        let until = Instant::now() + Duration::from_secs(20);
        while rt.state.phase != Phase::Ready {
            assert!(Instant::now() < until, "send {turn}");
            rt.frame(1.0 / 60.0);
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
            rt.state
                .messages
                .last()
                .unwrap()
                .body
                .contains(&format!("tour {turn}"))
        );
    }
    assert!(fragments > 2, "actual intermediate text observed");
    launcher::back(&mut rt.state);
    wait(&mut rt, "relist created session", |s| {
        !s.launcher.as_ref().unwrap().pending
    });
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "reopen existing", |s| {
        !s.launcher_visible && s.phase == Phase::Ready
    });
    assert_eq!(rt.state.messages.len(), 2);
    assert_eq!(rt.state.messages[0].body, "Existing project history");
    println!(
        "launcher probe: login failure/retry, folder failure/retry, scripted folder picker/cancel, 2 catalog pages, existing history, draft guard, create, 2 streaming sends, scoped reopen; intermediate frames={fragments}; no window or clipboard"
    );
}
