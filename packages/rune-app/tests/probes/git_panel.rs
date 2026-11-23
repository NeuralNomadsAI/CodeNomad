//! Drive the assembled application against the isolated launcher fixture.
use super::window_restore::{tap, type_text};
use crate::{Phase, State, init, poll, setup, view, workspace};
use rune::{Env, Runtime};
use std::time::{Duration, Instant};

const FILE: &str = "git-panel.txt";
const STAGED: &str = "git-row-staged:file:git-panel.txt";
const UNSTAGED: &str = "git-row-unstaged:file:git-panel.txt";

fn wait(rt: &mut Runtime<State>, step: &str, ready: impl Fn(&Runtime<State>) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while !ready(rt) {
        assert!(Instant::now() < deadline, "Git panel timeout: {step}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn visible_text(rt: &Runtime<State>, prefix: &str, text: &str) -> bool {
    rt.elements().iter().any(|el| {
        !el.exiting
            && el.visible[2] > 0.0
            && el.visible[3] > 0.0
            && el.path.contains(prefix)
            && el.text.as_deref().is_some_and(|value| value.contains(text))
    })
}

pub(super) fn run() {
    assert!(std::env::var("CODENOMAD_PROFILE").is_ok_and(|profile| profile.starts_with("trial-")));
    let mut state = init();
    setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(state, view, (1450.0, 920.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.frame(0.0);
    tap(&mut rt, "connect");
    wait(&mut rt, "backend connected", |rt| {
        workspace::input_ready(&rt.state)
            && rt
                .state
                .screen
                .launcher()
                .is_some_and(|l| l.connection.is_some())
    });
    type_text(
        &mut rt,
        "folder-path",
        &std::env::var("RUNE_TEST_FOLDER").unwrap(),
    );
    tap(&mut rt, "open-folder");
    wait(&mut rt, "existing session listed", |rt| {
        rt.find("session-ses_existing").is_some()
    });
    tap(&mut rt, "session-ses_existing");
    wait(&mut rt, "conversation", |rt| {
        !rt.state.screen.is_launcher() && rt.state.phase == Phase::Ready
    });
    if rt.find("right-panel-tab-1").is_none() {
        tap(&mut rt, "right-panel-toggle");
    }
    tap(&mut rt, "right-panel-tab-1");
    wait(&mut rt, "Files mounted", |rt| rt.find("git-mode").is_some());
    tap_mode(&mut rt, 1);
    wait(&mut rt, "working-tree status", |rt| {
        rt.find(UNSTAGED).is_some()
    });

    tap(&mut rt, &format!("git-row-unstaged:preview:{FILE}"));
    wait(&mut rt, "local diff", |rt| {
        visible_text(rt, "/git-reader-", "git-panel edited")
    });
    assert!(rt.find("composer").is_some());
    tap(&mut rt, &format!("git-row-unstaged:stage:{FILE}"));
    wait(&mut rt, "staged", |rt| {
        rt.find(STAGED).is_some() && rt.find(UNSTAGED).is_none()
    });
    tap(&mut rt, &format!("git-row-staged:stage:{FILE}"));
    wait(&mut rt, "unstaged again", |rt| {
        rt.find(UNSTAGED).is_some() && rt.find(STAGED).is_none()
    });
    tap(&mut rt, &format!("git-row-unstaged:stage:{FILE}"));
    wait(&mut rt, "restaged", |rt| {
        rt.find(STAGED).is_some() && rt.find(UNSTAGED).is_none()
    });

    type_text(&mut rt, "git-commit-message", "Commit from Rune");
    tap(&mut rt, "git-commit");
    wait(&mut rt, "committed", |rt| rt.find(STAGED).is_none());
    tap_mode(&mut rt, 2);
    wait(&mut rt, "commit appears in history", |rt| {
        commit_key(rt).is_some()
    });
    let key = commit_key(&rt).unwrap();
    tap(&mut rt, &key);
    let preview = format!("git-commit-file-preview-{FILE}");
    wait(&mut rt, "commit detail", |rt| rt.find(&preview).is_some());
    tap(&mut rt, &preview);
    wait(&mut rt, "commit diff", |rt| {
        visible_text(rt, "/git-reader-", "git-panel edited")
    });

    tap(&mut rt, "git-worktree-trigger");
    let option = rt
        .elements()
        .into_iter()
        .find(|el| {
            !el.exiting
                && el.role == "option"
                && el
                    .label
                    .as_deref()
                    .is_some_and(|label| label.starts_with("review · "))
        })
        .and_then(|el| el.key)
        .expect("linked checkout option");
    tap(&mut rt, &option);
    wait(&mut rt, "linked checkout history", |rt| {
        visible_text(rt, "/git-history-list", "Initial Git panel fixture")
    });
    assert!(!crate::git::has_preview(&rt.state));
    assert!(rt.find("composer").is_some());
    println!("{{\"type\":\"git-panel-proof\",\"mounted\":true}}");
}

fn tap_mode(rt: &mut Runtime<State>, index: usize) {
    tap(rt, &format!("git-mode/segment{index}"));
}

fn commit_key(rt: &Runtime<State>) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| {
            !el.exiting
                && el.role == "button"
                && el
                    .label
                    .as_deref()
                    .is_some_and(|label| label.starts_with("Commit from Rune · "))
        })
        .and_then(|el| el.key)
}
