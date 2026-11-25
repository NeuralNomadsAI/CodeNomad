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
const WAIT_TIMEOUT: Duration = Duration::from_secs(25);

fn focusable(rt: &Runtime<State>, key: &str) -> bool {
    let exact_suffix = format!("/{key}");
    let nested = format!("/{key}/");
    rt.elements().iter().any(|el| {
        !el.exiting
            && el.focusable
            && (el.key.as_deref() == Some(key)
                || el.path.ends_with(&exact_suffix)
                || el.path.contains(&nested))
    })
}

fn observable_error(state: &State, allow_launcher_error: Option<&str>) -> Option<String> {
    if let Some(error) = crate::git::probe_observable_error(state) {
        return Some(error);
    }
    let launcher_error = state.screen.launcher().and_then(|launcher| launcher.error);
    if let Some(error) = launcher_error
        && allow_launcher_error != Some(error)
    {
        return Some(format!("launcher error: {error}"));
    }
    None
}

fn diagnostic(rt: &Runtime<State>, step: &str) -> String {
    let launcher = rt.state.screen.launcher();
    format!(
        "step={step}, session={:?}, Git={:?}, held={}, ready={}, phase_failed={}, can_change_session={}, launcher_pending={:?}, launcher_error={:?}, {}",
        workspace::active_session(&rt.state),
        crate::git::placement(&rt.state),
        crate::git::placement_unconfirmed(&rt.state),
        rt.state.phase == Phase::Ready,
        rt.state.phase == Phase::Failed,
        crate::launcher::can_change_session(&rt.state),
        launcher.map(|l| l.pending),
        launcher.and_then(|l| l.error),
        crate::git::probe_slots_diagnostic(&rt.state),
    )
}

fn wait_until(
    rt: &mut Runtime<State>,
    step: &str,
    timeout: Duration,
    allow_launcher_error: Option<&str>,
    ready: impl Fn(&Runtime<State>) -> bool,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if ready(rt) {
            return Ok(());
        }
        if let Some(error) = observable_error(&rt.state, allow_launcher_error) {
            return Err(format!(
                "Git panel observable error: {error} ({})",
                diagnostic(rt, step)
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!("Git panel timeout: {}", diagnostic(rt, step)));
        }
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait(rt: &mut Runtime<State>, step: &str, ready: impl Fn(&Runtime<State>) -> bool) {
    if let Err(message) = wait_until(rt, step, WAIT_TIMEOUT, None, ready) {
        panic!("{message}");
    }
}

fn wait_allowing_launcher_error(
    rt: &mut Runtime<State>,
    step: &str,
    expected: &str,
    ready: impl Fn(&Runtime<State>) -> bool,
) {
    if let Err(message) = wait_until(rt, step, WAIT_TIMEOUT, Some(expected), ready) {
        panic!("{message}");
    }
}

fn tap_ready(rt: &mut Runtime<State>, step: &str, key: &str) {
    wait(rt, step, |rt| focusable(rt, key));
    tap(rt, key);
}

fn choose_session(rt: &mut Runtime<State>, step: &str, session_id: &str) {
    wait(rt, step, |rt| {
        crate::launcher::can_change_session(&rt.state)
            && rt.state.screen.launcher().is_some_and(|l| !l.pending)
    });
    rt.update(|s, tx| crate::launcher::choose(s, session_id.into(), tx));
}

fn focusable_option(
    rt: &Runtime<State>,
    path_filter: Option<&str>,
    prefix: &str,
) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| {
            !el.exiting
                && el.focusable
                && el.role == "option"
                && path_filter.is_none_or(|fragment| el.path.contains(fragment))
                && el
                    .label
                    .as_deref()
                    .is_some_and(|label| label.starts_with(prefix))
        })
        .and_then(|el| el.key)
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
    rt.on_key = Some(|s, event, tx| {
        crate::strings::with_locale(crate::settings::app_locale(s), || {
            crate::shell::keys(s, event, tx)
        })
    });
    rt.frame(0.0);
    tap_ready(&mut rt, "connect button focusable", "connect");
    wait(&mut rt, "backend connected", |rt| {
        workspace::input_ready(&rt.state)
            && rt
                .state
                .screen
                .launcher()
                .is_some_and(|l| l.connection.is_some())
            && focusable(rt, "folder-path")
    });
    type_text(
        &mut rt,
        "folder-path",
        &std::env::var("RUNE_TEST_FOLDER").unwrap(),
    );
    tap_ready(&mut rt, "open-folder button focusable", "open-folder");
    wait(&mut rt, "existing session listed", |rt| {
        focusable(rt, "session-ses_existing")
    });
    tap_ready(
        &mut rt,
        "existing session button focusable",
        "session-ses_existing",
    );
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

    tap_ready(
        &mut rt,
        "unstaged preview button focusable",
        &format!("git-row-unstaged:preview:{FILE}"),
    );
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
    tap_ready(&mut rt, "Workspace preview button focusable", &eye);
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
    tap_ready(
        &mut rt,
        "unstaged preview button focusable after mode switch",
        &format!("git-row-unstaged:preview:{FILE}"),
    );
    wait(&mut rt, "Git diff replaces Workspace", |rt| {
        !crate::files::has_preview(&rt.state)
            && visible_text(rt, "/git-reader-", "git-panel edited")
    });
    tap_ready(
        &mut rt,
        "stage button focusable",
        &format!("git-row-unstaged:stage:{FILE}"),
    );
    wait(&mut rt, "staged", |rt| {
        rt.find(STAGED).is_some() && rt.find(UNSTAGED).is_none()
    });
    tap_ready(
        &mut rt,
        "unstage button focusable",
        &format!("git-row-staged:stage:{FILE}"),
    );
    wait(&mut rt, "unstaged again", |rt| {
        rt.find(UNSTAGED).is_some() && rt.find(STAGED).is_none()
    });
    wait(&mut rt, "index mutable before drag to staged", |rt| {
        focusable(rt, &format!("git-row-unstaged:stage:{FILE}"))
            && focusable(rt, "git-section-staged")
            && focusable(rt, UNSTAGED)
    });
    tap(&mut rt, "git-section-staged");
    drag(&mut rt, UNSTAGED, "git-section-staged");
    tap_ready(
        &mut rt,
        "staged section expand button focusable",
        "git-section-staged",
    );
    wait(
        &mut rt,
        "staged by dropping on the collapsed section",
        |rt| rt.find(STAGED).is_some() && rt.find(UNSTAGED).is_none(),
    );
    tap_ready(&mut rt, "staged row focusable", STAGED);
    tap_ready(&mut rt, "bulk unstage button focusable", "git-bulk-staged");
    wait(
        &mut rt,
        "unstaged through the actions above the commit field",
        |rt| rt.find(UNSTAGED).is_some() && rt.find(STAGED).is_none(),
    );
    tap_ready(&mut rt, "unstaged row focusable", UNSTAGED);
    tap_ready(&mut rt, "bulk stage button focusable", "git-bulk-unstaged");
    wait(
        &mut rt,
        "restaged through the actions above the commit field",
        |rt| rt.find(STAGED).is_some() && rt.find(UNSTAGED).is_none(),
    );

    wait(&mut rt, "commit message field focusable", |rt| {
        focusable(rt, "git-commit-message")
    });
    type_text(&mut rt, "git-commit-message", "Commit from Rune");
    tap_ready(
        &mut rt,
        "commit available after status reconciliation",
        "git-commit",
    );
    wait(&mut rt, "committed", |rt| rt.find(STAGED).is_none());
    tap_mode(&mut rt, 2);
    wait(&mut rt, "commit appears in history", |rt| {
        commit_key(rt).is_some()
    });
    let key = commit_key(&rt).unwrap();
    tap_ready(&mut rt, "commit row focusable", &key);
    let preview = format!("git-commit-file-preview-{FILE}");
    tap_ready(&mut rt, "commit detail preview focusable", &preview);
    wait(&mut rt, "commit diff", |rt| {
        visible_text(rt, "/git-reader-", "git-panel edited")
    });

    tap_ready(
        &mut rt,
        "worktree trigger focusable",
        "git-worktree-trigger",
    );
    wait(&mut rt, "linked checkout option focusable", |rt| {
        focusable_option(rt, None, "review · ").is_some()
    });
    let option = focusable_option(&rt, None, "review · ").expect("linked checkout option");
    tap(&mut rt, &option);
    wait(&mut rt, "linked checkout history", |rt| {
        visible_text(rt, "/git-history-list", "Initial Git panel fixture")
    });
    let project = std::path::PathBuf::from(std::env::var_os("RUNE_TEST_FOLDER").unwrap());
    let linked = project.with_file_name("review");
    assert!(rt.elements().iter().any(|element| {
        !element.exiting
            && element.key.as_deref() == Some("git-worktree-trigger")
            && element.help.as_deref().is_some_and(|directory| {
                codenomad_client::same_server_path(directory, &linked.to_string_lossy())
            })
    }));
    assert!(!crate::git::has_preview(&rt.state));
    assert!(rt.find("composer").is_some());
    if let Ok(placement) = std::env::var("RUNE_TEST_PLACE_WORKTREE") {
        let unconfirmed = placement == "ambiguous";
        let trigger = "session-worktree-trigger";
        assert!(visible_text(&rt, trigger, "synthetic · main"));
        type_text(&mut rt, "composer", "keep this draft across placement");
        wait(&mut rt, "placement picker enabled", |rt| {
            crate::git::can_place(&rt.state) && focusable(rt, trigger)
        });
        rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
        rt.frame(0.02);
        let anchor = super::recovery::anchor(&rt);
        tap_ready(&mut rt, "session worktree trigger focusable", trigger);
        let escape = rune::KeyEvent {
            key: rune::Key::Escape,
            mods: Default::default(),
        };
        rt.key(escape.clone());
        rt.key_up(escape);
        rt.frame(0.02);
        super::recovery::check_anchor(&rt, &anchor);
        let choose_review = |rt: &mut Runtime<State>, allow_error: Option<&str>| {
            if let Some(expected) = allow_error {
                wait_allowing_launcher_error(
                    rt,
                    "session worktree trigger focusable",
                    expected,
                    |rt| focusable(rt, trigger),
                );
            } else {
                wait(rt, "session worktree trigger focusable", |rt| {
                    focusable(rt, trigger)
                });
            }
            tap(rt, trigger);
            if let Some(expected) = allow_error {
                wait_allowing_launcher_error(
                    rt,
                    "session placement option focusable",
                    expected,
                    |rt| focusable_option(rt, Some("session-worktree"), "review · ").is_some(),
                );
            } else {
                wait(rt, "session placement option focusable", |rt| {
                    focusable_option(rt, Some("session-worktree"), "review · ").is_some()
                });
            }
            let option = focusable_option(rt, Some("session-worktree"), "review · ")
                .expect("session placement option");
            tap(rt, &option);
        };
        choose_review(&mut rt, None);
        if placement == "busy" {
            wait_allowing_launcher_error(
                &mut rt,
                "busy family refusal leaves the original placement usable",
                "sessionList.worktreeMove.error",
                |rt| {
                    rt.state.screen.launcher().unwrap().error
                        == Some("sessionList.worktreeMove.error")
                        && crate::git::can_place(&rt.state)
                },
            );
            assert!(visible_text(&rt, trigger, "synthetic · main"));
            choose_review(&mut rt, Some("sessionList.worktreeMove.error"));
        }
        wait(&mut rt, "family placement settled", |rt| {
            crate::workspace::active_session(&rt.state) == Some("ses_existing")
                && if unconfirmed {
                    crate::git::placement_unconfirmed(&rt.state)
                } else {
                    rt.state.phase == Phase::Ready && visible_text(rt, trigger, "review · ")
                }
        });
        if !unconfirmed {
            wait(
                &mut rt,
                "placed transcript restores its visible anchor",
                |rt| {
                    rt.elements().into_iter().any(|row| {
                        !row.exiting
                            && row.visible[3] > 0.0
                            && row.path.ends_with(&format!("/{}", anchor.0))
                            && (row.rect[1] - anchor.1).abs() < 0.5
                    })
                },
            );
            super::recovery::check_anchor(&rt, &anchor);
        }
        if unconfirmed {
            assert!(visible_text(&rt, trigger, "synthetic · main"));
            rt.update(crate::send);
        }
        assert_eq!(rt.state.draft.text, "keep this draft across placement");
        if unconfirmed {
            choose_session(
                &mut rt,
                "can switch to child session under placement hold",
                "ses_child",
            );
            wait(&mut rt, "hold covers another member of the family", |rt| {
                crate::workspace::active_session(&rt.state) == Some("ses_child")
                    && crate::git::placement_unconfirmed(&rt.state)
            });
            type_text(&mut rt, "composer", "child draft");
            rt.update(crate::send);
            assert_eq!(rt.state.draft.text, "child draft");
            tap_ready(&mut rt, "placement retry focusable", "placement-retry");
            wait(
                &mut rt,
                "complete inventory and fresh activity lift the hold",
                |rt| !crate::git::placement_unconfirmed(&rt.state),
            );
            assert_eq!(rt.state.draft.text, "child draft");
            wait(
                &mut rt,
                "placement selector available after reconciliation",
                |rt| crate::git::can_place(&rt.state) && focusable(rt, trigger),
            );
            tap(&mut rt, trigger);
            wait(
                &mut rt,
                "placement option visible after reconciliation",
                |rt| focusable_option(rt, Some("session-worktree"), "review · ").is_some(),
            );
        }
        println!(
            "{{\"type\":\"worktree-placement-proof\",\"draftRetained\":true,\"unconfirmed\":{unconfirmed}}}"
        );
    } else {
        choose_session(&mut rt, "can switch to linked session", "ses_another");
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
            wait(rt, "linked Workspace preview mounted", |rt| {
                rt.find(&eye).is_some()
            });
            let (x, y) = rt.find(&eye).unwrap();
            rt.pointer_move(x, y);
            rt.frame(1.0 / 60.0);
            tap_ready(rt, "linked Workspace preview focusable", &eye);
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
                tap_ready(&mut rt, "linked reader close button focusable", close);
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
        tap_ready(
            &mut rt,
            "right panel toggle focusable",
            "right-panel-toggle",
        );
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
        choose_session(
            &mut rt,
            "can rebind evacuated session at root",
            "ses_another",
        );
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
    }
    println!("{{\"type\":\"git-panel-proof\",\"mounted\":true}}");
}

fn tap_mode(rt: &mut Runtime<State>, index: usize) {
    tap_ready(
        rt,
        &format!("git-mode segment {index} focusable"),
        &format!("git-mode/segment{index}"),
    );
}

fn drag(rt: &mut Runtime<State>, source: &str, target: &str) {
    let (x, y) = rt.find(source).expect("Git drag source");
    let (end_x, end_y) = rt.find(target).expect("Git drop target");
    rt.pointer_down(x, y);
    rt.frame(1.0 / 60.0);
    for i in 1..=8 {
        let t = i as f32 / 8.0;
        rt.pointer_move(x + (end_x - x) * t, y + (end_y - y) * t);
        rt.frame(1.0 / 60.0);
    }
    rt.pointer_up(end_x, end_y);
    rt.frame(1.0 / 60.0);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scene_runtime() -> Runtime<State> {
        fn scene_view(state: &State, _: &mut rune::Cx<State>) -> rune::El {
            super::super::git_scene::view(state)
        }
        let mut state = init();
        state.screen = crate::Screen::Launcher(crate::launcher::Launcher::fixture());
        state.phase = Phase::Ready;
        super::super::git_scene::changes(&mut state);
        let mut rt = Runtime::new(state, scene_view, (1450.0, 920.0), Env::new(true, 1.0));
        rt.frame(0.0);
        rt
    }

    #[test]
    fn causal_wait_gates_on_focusable_and_fails_fast_with_full_slot_diagnostic() {
        let mut rt = scene_runtime();
        let stage_key = rt
            .elements()
            .into_iter()
            .find_map(|el| {
                el.key
                    .filter(|key| key.starts_with("git-row-unstaged:stage:"))
            })
            .expect("unstaged stage button in git scene");

        // 1. Causal wait blocks while the stage action is disabled (!focusable) and succeeds once ready.
        assert!(
            focusable(&rt, "git-commit-message"),
            "composite text input must report focusable via its inner editor"
        );
        rt.state
            .git
            .owner
            .as_mut()
            .unwrap()
            .fixture_set_index_stale(true);
        rt.frame(1.0 / 60.0);
        assert!(
            !focusable(&rt, &stage_key),
            "stale index must disable stage action"
        );
        static FRAMES: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
        FRAMES.store(0, std::sync::atomic::Ordering::SeqCst);
        fn clear_stale_after_two_frames(state: &mut State, _: f64, _: &mut rune::Tx) -> bool {
            let step = FRAMES.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if step >= 2 {
                state
                    .git
                    .owner
                    .as_mut()
                    .unwrap()
                    .fixture_set_index_stale(false);
                true
            } else {
                false
            }
        }
        rt.poll = Some(clear_stale_after_two_frames);
        wait_until(&mut rt, "stage focusable", WAIT_TIMEOUT, None, |rt| {
            focusable(rt, &stage_key)
        })
        .expect("causal wait must resolve as soon as stage becomes focusable");
        rt.poll = None;

        // 1b. Session switch gate blocks while launcher.pending is true and clears once settled.
        rt.state.screen.launcher_mut().unwrap().pending = true;
        assert!(
            !rt.state.screen.launcher().is_some_and(|l| !l.pending),
            "pending launcher must block choose_session"
        );
        static PENDING_FRAMES: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
        PENDING_FRAMES.store(0, std::sync::atomic::Ordering::SeqCst);
        fn clear_pending_after_two_frames(state: &mut State, _: f64, _: &mut rune::Tx) -> bool {
            let step = PENDING_FRAMES.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if step >= 2 {
                state.screen.launcher_mut().unwrap().pending = false;
                true
            } else {
                false
            }
        }
        rt.poll = Some(clear_pending_after_two_frames);
        wait_until(&mut rt, "session switch ready", WAIT_TIMEOUT, None, |rt| {
            crate::launcher::can_change_session(&rt.state)
                && rt.state.screen.launcher().is_some_and(|l| !l.pending)
        })
        .expect("causal wait must resolve once can_change_session && !pending");
        rt.poll = None;

        // 2. Observable Git slot error fails immediately (well before 25 s) with full 7-slot diagnostics.
        rt.state
            .git
            .owner
            .as_mut()
            .unwrap()
            .load_empty_scene("error");
        let started = Instant::now();
        let err = wait_until(&mut rt, "awaiting changes", WAIT_TIMEOUT, None, |_| false)
            .expect_err("slot error must fail fast");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "observable error must fail fast without waiting 25 s: {err}"
        );
        assert!(err.contains("fixture status refused"), "{err}");
        for lane in [
            "Worktrees(",
            "Changes(",
            "History(",
            "Details(",
            "Preview(",
            "Preferences(",
            "InitSessions(",
        ] {
            assert!(err.contains(lane), "missing {lane} in diagnostic: {err}");
        }

        // 3. Observable Git mutation error fails fast with full slot diagnostics.
        let mut rt = scene_runtime();
        rt.state
            .git
            .owner
            .as_mut()
            .unwrap()
            .fixture_set_mutation_error("commit refused by fixture");
        let started = Instant::now();
        let err = wait_until(&mut rt, "awaiting commit", WAIT_TIMEOUT, None, |_| false)
            .expect_err("mutation error must fail fast");
        assert!(started.elapsed() < Duration::from_secs(2), "{err}");
        assert!(err.contains("commit refused by fixture"), "{err}");
        assert!(err.contains("slots=["), "{err}");

        // 4. Unexpected launcher error fails fast; explicitly expected launcher error is allowed.
        let mut rt = scene_runtime();
        rt.state.screen.launcher_mut().unwrap().error = Some("sessionList.reload.error");
        let started = Instant::now();
        let err = wait_until(&mut rt, "awaiting session", WAIT_TIMEOUT, None, |_| false)
            .expect_err("unexpected launcher error must fail fast");
        assert!(started.elapsed() < Duration::from_secs(2), "{err}");
        assert!(err.contains("sessionList.reload.error"), "{err}");

        rt.state.screen.launcher_mut().unwrap().error = Some("sessionList.worktreeMove.error");
        wait_until(
            &mut rt,
            "expected busy refusal",
            WAIT_TIMEOUT,
            Some("sessionList.worktreeMove.error"),
            |rt| {
                rt.state.screen.launcher().and_then(|l| l.error)
                    == Some("sessionList.worktreeMove.error")
            },
        )
        .expect("explicitly expected launcher error must not trip fail-fast");
    }
}
