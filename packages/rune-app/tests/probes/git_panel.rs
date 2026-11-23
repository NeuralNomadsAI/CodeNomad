//! Drive the assembled application against the isolated launcher fixture.
use super::window_restore::{tap, type_text};
use crate::{Phase, State, init, poll, setup, view, workspace};
use rune::{Env, Runtime};
use std::{
    io::Write,
    time::{Duration, Instant},
};

const FILE: &str = "git-panel.txt";
const STAGED: &str = "git-row-staged:file:git-panel.txt";
const UNSTAGED: &str = "git-row-unstaged:file:git-panel.txt";

fn wait(rt: &mut Runtime<State>, step: &str, ready: impl Fn(&Runtime<State>) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(25);
    while !ready(rt) {
        if Instant::now() >= deadline {
            let alerts: Vec<_> = rt
                .elements()
                .into_iter()
                .filter(|el| !el.exiting && el.role == "alert")
                .filter_map(|el| el.text.or(el.label))
                .collect();
            eprintln!("Git panel probe: timed out at {step}; alerts: {alerts:?}");
            std::process::exit(1);
        }
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
    if !press(&mut rt, "right-panel-tab-1")
        && !(press(&mut rt, "right-panel-toggle") && press(&mut rt, "right-panel-tab-1"))
    {
        eprintln!(
            "Git panel probe: Files tab (right-panel-tab-1) is missing. Build with the Shell Files panel mounted."
        );
        std::process::exit(1);
    }
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

    tap_mode(&mut rt, 0);
    let eye = format!("workspace-actions:{FILE}:pinned:preview");
    wait(&mut rt, "Workspace row", |rt| rt.find(&eye).is_some());
    let (x, y) = rt.find(&eye).unwrap();
    rt.pointer_move(x, y);
    rt.frame(1.0 / 60.0);
    tap(&mut rt, &eye);
    wait(&mut rt, "Workspace replaces the Git diff", |rt| {
        !crate::git::has_preview(&rt.state) && visible_text(rt, "/file-reader-", "git-panel edited")
    });
    assert!(rt.find("composer").is_some());
    tap_mode(&mut rt, 1);
    wait(&mut rt, "Changes row after mode switch", |rt| {
        rt.find(UNSTAGED).is_some()
    });
    assert!(
        crate::files::has_preview(&rt.state),
        "changing mode keeps the open reader"
    );
    tap(&mut rt, &format!("git-row-unstaged:preview:{FILE}"));
    wait(&mut rt, "Git diff replaces Workspace", |rt| {
        !crate::files::has_preview(&rt.state)
            && visible_text(rt, "/git-reader-", "git-panel edited")
    });
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
    wait(
        &mut rt,
        "commit available after status reconciliation",
        |rt| {
            rt.elements().iter().any(|element| {
                !element.exiting
                    && element.focusable
                    && element.key.as_deref() == Some("git-commit")
            })
        },
    );
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

    rt.update(|s, tx| crate::launcher::choose(s, "ses_another".into(), tx));
    wait(&mut rt, "linked conversation bound", |rt| {
        workspace::active_session(&rt.state) == Some("ses_another")
            && rt.state.phase == Phase::Ready
    });
    rt.set_viewport((1100.0, 920.0), 1.0);
    rt.frame(1.0 / 60.0);
    tap_mode(&mut rt, 0);
    wait(&mut rt, "linked Workspace row", |rt| {
        rt.find(&eye).is_some() && rt.state.messages.len() == 50
    });
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 1600.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let reading = super::recovery::anchor(&rt);
    let open = |rt: &mut Runtime<State>| {
        let (x, y) = rt.find(&eye).unwrap();
        rt.pointer_move(x, y);
        rt.frame(1.0 / 60.0);
        tap(rt, &eye);
        wait(rt, "linked file replaces the transcript", |rt| {
            rt.find("file-editor").is_some() && rt.find("history").is_none()
        });
    };
    for close in ["file-close", eye.as_str(), "Escape"] {
        open(&mut rt);
        if close == "Escape" {
            rt.key(rune::KeyEvent {
                key: rune::Key::Escape,
                mods: Default::default(),
            });
        } else {
            tap(&mut rt, close);
        }
        wait(&mut rt, "linked transcript remounted", |rt| {
            rt.find(&reading.0).is_some()
        });
        super::recovery::check_anchor(&rt, &reading);
    }
    open(&mut rt);
    wait(&mut rt, "linked editor", |rt| {
        rt.find("file-editor").is_some()
            && rt
                .state
                .files
                .as_ref()
                .is_some_and(|files| files.document.edit().text.trim() == "git-panel initial")
    });
    let workspace = rt
        .state
        .files
        .as_ref()
        .unwrap()
        .reader
        .preview()
        .unwrap()
        .workspace_id
        .clone();
    let tab = rt.state.workspace.as_ref().unwrap().active_key().to_owned();
    rt.update(|s, _| {
        let files = s.files.as_mut().unwrap();
        let scope = files.document.scope();
        files
            .document
            .input(scope)
            .replace_text("unsaved linked draft");
        files.document.changed(scope);
    });
    assert!(rt.state.documents.has_tab_edits(&tab));
    tap(&mut rt, "right-panel-toggle");
    println!(
        "{}",
        serde_json::json!({"type":"files-evacuation","workspace":workspace})
    );
    std::io::stdout().flush().unwrap();
    wait(
        &mut rt,
        "move closes the reader before checkout removal",
        |rt| rt.state.phase == Phase::Failed && !crate::files::has_preview(&rt.state),
    );
    assert!(rt.state.documents.has_tab_edits(&tab));
    println!("{{\"type\":\"files-reader-closed\"}}");
    std::io::stdout().flush().unwrap();
    let mut receipt = String::new();
    std::io::stdin().read_line(&mut receipt).unwrap();
    assert_eq!(receipt.trim(), "removed");
    rt.update(|s, tx| crate::launcher::choose(s, "ses_another".into(), tx));
    wait(&mut rt, "evacuated session rebound at root", |rt| {
        rt.state.phase == Phase::Ready
            && rt.state.files.as_ref().is_some_and(|files| {
                codenomad_client::same_server_path(
                    files.tree.directory(),
                    &std::env::var("RUNE_TEST_FOLDER").unwrap(),
                )
            })
    });
    assert!(!crate::files::has_preview(&rt.state));
    assert!(rt.state.documents.has_tab_edits(&tab));
    println!("{{\"type\":\"git-panel-proof\",\"mounted\":true}}");
}

fn tap_mode(rt: &mut Runtime<State>, index: usize) {
    tap(rt, &format!("git-mode/segment{index}"));
}

fn press(rt: &mut Runtime<State>, key: &str) -> bool {
    let Some((x, y)) = rt.find(key) else {
        return false;
    };
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
    true
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
