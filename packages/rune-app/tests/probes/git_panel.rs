//! Drive the assembled application against the isolated launcher fixture.
use crate::{Phase, State, init, poll, setup, view, workspace};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use std::{
    io::Write,
    time::{Duration, Instant},
};

const FILE: &str = "git-panel.txt";
const STAGED: &str = "git-row-staged:file:git-panel.txt";
const UNSTAGED: &str = "git-row-unstaged:file:git-panel.txt";
const WAIT_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone, Copy)]
enum AllowedLauncherError {
    None,
    Exact(&'static str),
    WhilePlacementHeld(&'static str),
}

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

fn observable_error(state: &State, allowed: AllowedLauncherError) -> Option<String> {
    if let Some(error) = crate::git::probe_observable_error(state) {
        return Some(error);
    }
    let launcher_error = state.screen.launcher().and_then(|launcher| launcher.error);
    if let Some(error) = launcher_error {
        let permitted = match allowed {
            AllowedLauncherError::None => false,
            AllowedLauncherError::Exact(expected) => error == expected,
            AllowedLauncherError::WhilePlacementHeld(expected) => {
                error == expected && crate::git::placement_unconfirmed(state)
            }
        };
        if !permitted {
            return Some(format!("launcher error: {error}"));
        }
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
    allowed: AllowedLauncherError,
    ready: impl Fn(&Runtime<State>) -> bool,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(error) = observable_error(&rt.state, allowed) {
            return Err(format!(
                "Git panel observable error: {error} ({})",
                diagnostic(rt, step)
            ));
        }
        if ready(rt) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("Git panel timeout: {}", diagnostic(rt, step)));
        }
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait(rt: &mut Runtime<State>, step: &str, ready: impl Fn(&Runtime<State>) -> bool) {
    wait_allowing(rt, step, AllowedLauncherError::None, ready);
}

fn wait_allowing(
    rt: &mut Runtime<State>,
    step: &str,
    allowed: AllowedLauncherError,
    ready: impl Fn(&Runtime<State>) -> bool,
) {
    if let Err(message) = wait_until(rt, step, WAIT_TIMEOUT, allowed, ready) {
        panic!("{message}");
    }
}

fn tap_ready(rt: &mut Runtime<State>, step: &str, key: &str) {
    tap_ready_allowing(rt, step, AllowedLauncherError::None, key);
}

fn tap_ready_allowing(
    rt: &mut Runtime<State>,
    step: &str,
    allowed: AllowedLauncherError,
    key: &str,
) {
    wait_allowing(rt, step, allowed, |rt| focusable(rt, key));
    rt.update(|_, tx| {
        tx.scroll_into_view(key);
        tx.instant();
    });
    for _ in 0..3 {
        rt.frame(1.0 / 60.0);
    }
    wait_allowing(rt, step, allowed, |rt| {
        focusable(rt, key) && rt.find(key).is_some()
    });
    let (x, y) = rt
        .find(key)
        .unwrap_or_else(|| panic!("missing control: {key} ({})", diagnostic(rt, step)));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

fn type_text_ready(rt: &mut Runtime<State>, step: &str, field: &str, text: &str) {
    tap_ready(rt, step, field);
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

fn choose_session(rt: &mut Runtime<State>, step: &str, session_id: &str) {
    choose_session_allowing(rt, step, AllowedLauncherError::None, session_id);
}

fn choose_session_allowing(
    rt: &mut Runtime<State>,
    step: &str,
    allowed: AllowedLauncherError,
    session_id: &str,
) {
    wait_allowing(rt, step, allowed, |rt| {
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
    type_text_ready(
        &mut rt,
        "folder path input focusable",
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
    wait(&mut rt, "right panel control focusable", |rt| {
        focusable(rt, "right-panel-tab-1") || focusable(rt, "right-panel-toggle")
    });
    if !focusable(&rt, "right-panel-tab-1") {
        tap_ready(
            &mut rt,
            "right panel toggle focusable",
            "right-panel-toggle",
        );
    }
    tap_ready(&mut rt, "Files tab focusable", "right-panel-tab-1");
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
    tap_ready(
        &mut rt,
        "staged section collapse button focusable",
        "git-section-staged",
    );
    let stage_action = format!("git-row-unstaged:stage:{FILE}");
    drag(
        &mut rt,
        "drag unstaged to collapsed staged section",
        UNSTAGED,
        "git-section-staged",
        |rt| {
            focusable(rt, &stage_action)
                && focusable(rt, "git-section-staged")
                && focusable(rt, UNSTAGED)
        },
    );
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

    type_text_ready(
        &mut rt,
        "commit message field focusable",
        "git-commit-message",
        "Commit from Rune",
    );
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
    tap_ready(&mut rt, "linked checkout option focusable", &option);
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
        type_text_ready(
            &mut rt,
            "composer focusable",
            "composer",
            "keep this draft across placement",
        );
        wait(&mut rt, "placement picker enabled", |rt| {
            crate::git::can_place(&rt.state) && focusable(rt, trigger)
        });
        rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
        rt.frame(0.02);
        let anchor = super::recovery::anchor(&rt);
        tap_ready(&mut rt, "session worktree trigger focusable", trigger);
        wait(
            &mut rt,
            "session worktree option focusable before Escape",
            |rt| focusable_option(rt, Some("session-worktree"), "review · ").is_some(),
        );
        let escape = rune::KeyEvent {
            key: rune::Key::Escape,
            mods: Default::default(),
        };
        rt.key(escape.clone());
        rt.key_up(escape);
        rt.frame(0.02);
        wait(&mut rt, "session worktree picker closed by Escape", |rt| {
            focusable_option(rt, Some("session-worktree"), "review · ").is_none()
        });
        super::recovery::check_anchor(&rt, &anchor);
        let choose_review = |rt: &mut Runtime<State>, allowed: AllowedLauncherError| {
            tap_ready_allowing(rt, "session worktree trigger focusable", allowed, trigger);
            wait_allowing(rt, "session placement option focusable", allowed, |rt| {
                focusable_option(rt, Some("session-worktree"), "review · ").is_some()
            });
            let option = focusable_option(rt, Some("session-worktree"), "review · ")
                .expect("session placement option");
            tap_ready_allowing(rt, "session placement option focusable", allowed, &option);
        };
        choose_review(&mut rt, AllowedLauncherError::None);
        if placement == "busy" {
            wait_allowing(
                &mut rt,
                "busy family refusal leaves the original placement usable",
                AllowedLauncherError::Exact("sessionList.worktreeMove.error"),
                |rt| {
                    rt.state.screen.launcher().unwrap().error
                        == Some("sessionList.worktreeMove.error")
                        && crate::git::can_place(&rt.state)
                },
            );
            assert!(visible_text(&rt, trigger, "synthetic · main"));
            choose_review(
                &mut rt,
                AllowedLauncherError::Exact("sessionList.worktreeMove.error"),
            );
        }
        let settled_error = if unconfirmed {
            AllowedLauncherError::WhilePlacementHeld("sessionList.worktreeMove.error")
        } else {
            AllowedLauncherError::None
        };
        wait_allowing(&mut rt, "family placement settled", settled_error, |rt| {
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
            choose_session_allowing(
                &mut rt,
                "can switch to child session under placement hold",
                AllowedLauncherError::WhilePlacementHeld("sessionList.worktreeMove.error"),
                "ses_child",
            );
            wait(&mut rt, "hold covers another member of the family", |rt| {
                crate::workspace::active_session(&rt.state) == Some("ses_child")
                    && crate::git::placement_unconfirmed(&rt.state)
            });
            type_text_ready(
                &mut rt,
                "child composer focusable",
                "composer",
                "child draft",
            );
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
            tap_ready(
                &mut rt,
                "placement selector trigger focusable after reconciliation",
                trigger,
            );
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

fn drag(
    rt: &mut Runtime<State>,
    step: &str,
    source: &str,
    target: &str,
    ready: impl Fn(&Runtime<State>) -> bool,
) {
    wait(rt, &format!("{step} (before drag)"), |rt| {
        ready(rt) && rt.find(source).is_some() && rt.find(target).is_some()
    });
    let (x, y) = rt.find(source).expect("Git drag source");
    let (end_x, end_y) = rt.find(target).expect("Git drop target");
    rt.pointer_down(x, y);
    rt.frame(1.0 / 60.0);
    for i in 1..=8 {
        let t = i as f32 / 8.0;
        rt.pointer_move(x + (end_x - x) * t, y + (end_y - y) * t);
        rt.frame(1.0 / 60.0);
    }
    wait(rt, &format!("{step} (before drop)"), |rt| {
        ready(rt) && rt.find(target).is_some()
    });
    let (drop_x, drop_y) = rt.find(target).expect("Git drop target");
    rt.pointer_move(drop_x, drop_y);
    rt.pointer_up(drop_x, drop_y);
    rt.frame(1.0 / 60.0);
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
            super::super::git_scene::view_with_width(state, 360.0)
        }
        let mut state = init();
        state.screen = crate::Screen::Launcher(Box::new(crate::launcher::Launcher::fixture()));
        state.phase = Phase::Ready;
        super::super::git_scene::changes_explicit(&mut state);
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

        // 1. Real tap_ready blocks while the stage action is disabled (!focusable) and clicks once ready.
        assert!(
            focusable(&rt, "git-commit-message"),
            "composite text input must report focusable via its inner editor"
        );
        rt.update(|state, _| {
            state
                .git
                .owner
                .as_mut()
                .unwrap()
                .fixture_set_index_stale(true);
        });
        rt.frame(1.0 / 60.0);
        assert!(
            !focusable(&rt, &stage_key),
            "stale index must disable stage action"
        );
        fn clear_stale_after_two_frames(state: &mut State, now: f64, _: &mut rune::Tx) -> bool {
            if now >= 3.0 / 60.0 - 1e-4 {
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
        assert!(
            crate::git::probe_slots_diagnostic(&rt.state).contains("mutation=None"),
            "no mutation must be running before tap_ready"
        );
        rt.poll = Some(clear_stale_after_two_frames);
        tap_ready(&mut rt, "stage focusable", &stage_key);
        rt.poll = None;
        let after_tap = crate::git::probe_slots_diagnostic(&rt.state);
        assert!(
            after_tap.contains("mutation=Some("),
            "tap_ready must wait until focusable and actually dispatch the stage gesture: {after_tap}"
        );

        // 1b. Real choose_session blocks on can_change_session == false and launcher.pending == true separately.
        let mut rt = scene_runtime();
        rt.update(|state, _| {
            state.phase = Phase::Streaming;
            state.screen.launcher_mut().unwrap().pending = false;
        });
        rt.frame(1.0 / 60.0);
        assert!(
            !crate::launcher::can_change_session(&rt.state)
                && rt.state.screen.launcher().is_some_and(|l| !l.pending),
            "streaming phase must disable can_change_session independently of pending"
        );
        fn clear_streaming_after_two_frames(state: &mut State, now: f64, _: &mut rune::Tx) -> bool {
            if now >= 3.0 / 60.0 - 1e-4 {
                state.phase = Phase::Ready;
                true
            } else {
                false
            }
        }
        rt.poll = Some(clear_streaming_after_two_frames);
        choose_session(&mut rt, "wait for can_change_session", "ses_child");
        rt.poll = None;
        assert!(rt.state.phase == Phase::Ready);
        assert!(crate::launcher::can_change_session(&rt.state));

        let mut rt = scene_runtime();
        rt.update(|state, _| {
            state.phase = Phase::Ready;
            state.screen.launcher_mut().unwrap().pending = true;
        });
        rt.frame(1.0 / 60.0);
        assert!(
            crate::launcher::can_change_session(&rt.state)
                && rt.state.screen.launcher().is_some_and(|l| l.pending),
            "pending launcher must block choose_session independently of can_change_session"
        );
        fn clear_pending_after_two_frames(state: &mut State, now: f64, _: &mut rune::Tx) -> bool {
            if now >= 3.0 / 60.0 - 1e-4 {
                state.screen.launcher_mut().unwrap().pending = false;
                true
            } else {
                false
            }
        }
        rt.poll = Some(clear_pending_after_two_frames);
        choose_session(&mut rt, "wait for !launcher.pending", "ses_child");
        rt.poll = None;
        assert!(rt.state.screen.launcher().is_some_and(|l| !l.pending));

        // 2. Observable Git slot error fails immediately (even when ready == true) with full 7-slot diagnostics.
        let mut rt = scene_runtime();
        rt.update(|state, _| {
            let owner = state.git.owner.as_mut().unwrap();
            owner.fixture_set_history_dirty(true);
            owner.load_empty_scene("error");
        });
        let started = Instant::now();
        let err = wait_until(
            &mut rt,
            "awaiting changes",
            WAIT_TIMEOUT,
            AllowedLauncherError::None,
            |_| true,
        )
        .expect_err("slot error must fail fast even if ready is true");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "observable error must fail fast without waiting 25 s: {err}"
        );
        assert!(err.contains("fixture status refused"), "{err}");
        assert!(
            err.contains("Changes(busy=false,dirty=false,err=Some(\"fixture status refused\"))"),
            "diagnostic must report non-trivial slot error state: {err}"
        );
        assert!(
            err.contains("History(busy=false,dirty=true,err=None)"),
            "diagnostic must report non-trivial dirty slot state: {err}"
        );
        for lane in [
            "Worktrees(busy=",
            "Changes(busy=",
            "History(busy=",
            "Details(busy=",
            "Preview(busy=",
            "Preferences(busy=",
            "InitSessions(busy=",
        ] {
            assert!(err.contains(lane), "missing {lane} in diagnostic: {err}");
        }

        // 3. Observable Git mutation error fails fast even when ready == true.
        let mut rt = scene_runtime();
        rt.update(|state, _| {
            state
                .git
                .owner
                .as_mut()
                .unwrap()
                .fixture_set_mutation_error("commit refused by fixture");
        });
        let started = Instant::now();
        let err = wait_until(
            &mut rt,
            "awaiting commit",
            WAIT_TIMEOUT,
            AllowedLauncherError::None,
            |_| true,
        )
        .expect_err("mutation error must fail fast even if ready is true");
        assert!(started.elapsed() < Duration::from_secs(2), "{err}");
        assert!(err.contains("commit refused by fixture"), "{err}");
        assert!(err.contains("slots=["), "{err}");

        // 4. Unexpected launcher error fails fast even when ready == true; allowed launcher errors pass
        //    even while ready is initially false and becomes true on a later frame.
        let mut rt = scene_runtime();
        rt.update(|state, _| {
            state.screen.launcher_mut().unwrap().error = Some("sessionList.reload.error");
        });
        let started = Instant::now();
        let err = wait_until(
            &mut rt,
            "awaiting session",
            WAIT_TIMEOUT,
            AllowedLauncherError::None,
            |_| true,
        )
        .expect_err("unexpected launcher error must fail fast even if ready is true");
        assert!(started.elapsed() < Duration::from_secs(2), "{err}");
        assert!(err.contains("sessionList.reload.error"), "{err}");

        // 4b. AllowedLauncherError::Exact tolerates the expected error across multiple frames while ready is false.
        let mut rt = scene_runtime();
        rt.update(|state, _| {
            state.screen.launcher_mut().unwrap().error = Some("sessionList.worktreeMove.error");
            state.phase = Phase::Streaming;
        });
        let err = wait_until(
            &mut rt,
            "strict mode rejects move error",
            WAIT_TIMEOUT,
            AllowedLauncherError::None,
            |rt| rt.state.phase == Phase::Ready,
        )
        .expect_err("strict wait must reject worktreeMove error");
        assert!(err.contains("sessionList.worktreeMove.error"), "{err}");

        rt.poll = Some(clear_streaming_after_two_frames);
        wait_until(
            &mut rt,
            "expected busy refusal",
            WAIT_TIMEOUT,
            AllowedLauncherError::Exact("sessionList.worktreeMove.error"),
            |rt| rt.state.phase == Phase::Ready,
        )
        .expect("explicitly expected launcher error must allow multi-frame wait until ready");
        rt.poll = None;

        // 4c. AllowedLauncherError::WhilePlacementHeld rejects without hold and allows while hold is active.
        let mut rt = scene_runtime();
        rt.update(|state, _| {
            state.screen.launcher_mut().unwrap().error = Some("sessionList.worktreeMove.error");
            state.phase = Phase::Streaming;
        });
        let err = wait_until(
            &mut rt,
            "unheld placement rejects error",
            WAIT_TIMEOUT,
            AllowedLauncherError::WhilePlacementHeld("sessionList.worktreeMove.error"),
            |rt| rt.state.phase == Phase::Ready,
        )
        .expect_err("WhilePlacementHeld must reject when placement is not held");
        assert!(err.contains("sessionList.worktreeMove.error"), "{err}");

        rt.update(|state, _| {
            crate::git::hold_placement(
                state,
                crate::git::PlacementHold {
                    members: std::collections::HashSet::from(["session".into()]),
                    answered: true,
                },
            );
        });
        rt.poll = Some(clear_streaming_after_two_frames);
        wait_until(
            &mut rt,
            "held placement tolerates expected error",
            WAIT_TIMEOUT,
            AllowedLauncherError::WhilePlacementHeld("sessionList.worktreeMove.error"),
            |rt| rt.state.phase == Phase::Ready && crate::git::placement_unconfirmed(&rt.state),
        )
        .expect("WhilePlacementHeld must allow expected error while placement hold is active");
        rt.poll = None;
    }
}
