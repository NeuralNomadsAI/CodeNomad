use super::window_restore::{finish, tap, type_text, wait};
use crate::{State, workspace};
use rune::{
    Env, Runtime,
    render::{
        cpu_boot::{CpuPainter, Scene, Target, attach_text},
        write_png,
    },
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const TITLE: &str = "Rune private journey";
const PROMPT: &str = "RUNE-JOURNEY: update journey.txt";
const REPLY: &str = "Journey complete.";
const COMMIT: &str = "Rune journey commit";
const SIZE: (u32, u32) = (1400, 900);

fn nodes(tree: &Value) -> impl Iterator<Item = &Value> {
    let mut pending = vec![tree];
    std::iter::from_fn(move || {
        let node = pending.pop()?;
        pending.extend(node["children"].as_array().into_iter().flatten());
        Some(node)
    })
}

fn a11y(rt: &Runtime<State>, key: &str) -> bool {
    nodes(&rt.accessibility_json()).any(|node| node["key"] == key && node["role"].is_string())
}

fn text(rt: &Runtime<State>, needle: &str) -> bool {
    contains(&rt.accessibility_json(), needle)
}

fn contains(root: &Value, needle: &str) -> bool {
    nodes(root).any(|node| {
        ["name", "value", "text"].iter().any(|attr| {
            node[*attr]
                .as_str()
                .is_some_and(|value| value.contains(needle))
        })
    })
}

fn ui(rt: &mut Runtime<State>, label: &str, condition: impl Fn(&Runtime<State>) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition(rt) {
        assert!(Instant::now() < deadline, "missing {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn evidence(rt: &mut Runtime<State>, path: &Path, name: &str) {
    let ax = rt.accessibility_json();
    std::fs::write(
        path.join(format!("windows-{name}.aria.json")),
        serde_json::to_vec_pretty(&ax).unwrap(),
    )
    .unwrap();
    let mut pixels = vec![0; SIZE.0 as usize * SIZE.1 as usize * 4];
    let mut painter = CpuPainter::new(2);
    painter.fill_masks(&mut rt.text.atlas);
    let scene = Scene::new(
        &rt.instances,
        &rt.text.atlas,
        &rt.images,
        SIZE,
        rt.clear_color(),
    )
    .srgb_blend(rt.srgb_blend())
    .font_smoothing(rt.font_smoothing());
    painter
        .paint(&scene, &mut Target::new(&mut pixels, SIZE.0, SIZE.1))
        .unwrap();
    assert!(
        pixels.chunks_exact(4).any(|pixel| pixel != &pixels[..4]),
        "blank screenshot"
    );
    write_png(
        &path.join(format!("windows-{name}.png")),
        SIZE.0,
        SIZE.1,
        &pixels,
    )
    .unwrap();
}

fn step(rt: &mut Runtime<State>, path: &Path, name: &str, run: impl FnOnce(&mut Runtime<State>)) {
    let start = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(rt)));
    let proof = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| evidence(rt, path, name)));
    let ok = result.is_ok() && proof.is_ok();
    println!(
        "{}",
        json!({"step":true,"name":name,"ok":ok,"durationMs":start.elapsed().as_millis()})
    );
    if let Err(error) = result.and(proof) {
        std::panic::resume_unwind(error);
    }
}

pub(super) fn run() {
    assert!(std::env::var("CODENOMAD_PROFILE").is_ok_and(|profile| profile.starts_with("trial-")));
    let folder = std::env::var("RUNE_TEST_FOLDER").unwrap();
    let path = PathBuf::from(std::env::var_os("RUNE_JOURNEY_OUTPUT").unwrap());
    let session = PathBuf::from(std::env::var_os("RUNE_JOURNEY_SESSION_FILE").unwrap());
    let phase = std::env::var("RUNE_JOURNEY_PHASE").unwrap();
    let mut state = crate::init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    let mut rt = Runtime::new(
        state,
        crate::view,
        (SIZE.0 as f32, SIZE.1 as f32),
        Env::new(false, 1.0),
    );
    attach_text(&mut rt.text.atlas);
    rt.set_srgb_blend(true);
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    if phase == "reopen" {
        let expected = std::fs::read_to_string(session).unwrap();
        step(&mut rt, &path, "reopen-session", |rt| {
            tap(rt, "connect");
            wait(rt, "restored session", |s| {
                workspace::active_session(s) == Some(expected.as_str())
            });
            ui(rt, REPLY, |rt| text(rt, REPLY));
            assert!(text(rt, TITLE));
        });
        finish(rt);
        return;
    }
    assert_eq!(phase, "start");
    step(&mut rt, &path, "launch", |rt| assert!(a11y(rt, "connect")));
    step(&mut rt, &path, "open-project", |rt| {
        tap(rt, "connect");
        ui(rt, "browse row", |rt| {
            workspace::input_ready(&rt.state) && rt.find("browse").is_some()
        });
        tap(rt, "browse");
        rt.resolve_file_dialog(Some(folder.clone().into())).unwrap();
        rt.frame(1.0 / 60.0);
        ui(rt, "session title field", |rt| {
            rt.find("session-title").is_some()
        });
        assert!(text(rt, &folder) && a11y(rt, "create-session"));
    });
    step(&mut rt, &path, "new-session", |rt| {
        type_text(rt, "session-title", TITLE);
        tap(rt, "create-session");
        wait(rt, "created conversation", |s| {
            workspace::active_session(s).is_some() && s.phase == crate::Phase::Ready
        });
        assert!(text(rt, TITLE) && a11y(rt, "send"));
        std::fs::write(&session, workspace::active_session(&rt.state).unwrap()).unwrap();
    });
    step(&mut rt, &path, "permission", |rt| {
        type_text(rt, "composer", PROMPT);
        let send_ready = |rt: &Runtime<State>| {
            crate::composer::can_send(&rt.state)
                && nodes(&rt.accessibility_json()).any(|node| {
                    node["key"] == "send"
                        && node["actions"]
                            .as_array()
                            .is_some_and(|actions| actions.iter().any(|action| action == "click"))
                })
        };
        let s = &rt.state;
        println!(
            "{}",
            json!({"sendReadyOnFirstFrame":send_ready(rt),
                "readerSettling":s.reader.as_ref().is_some_and(|reader| reader.blocks_send()),
                "launcherBusy":s.screen.launcher().is_some_and(|launcher| launcher.blocks_prompt()),
                "commandChannelReady":s.commands.as_ref().is_some_and(|commands| !commands.is_closed())})
        );
        rt.update(|_, tx| {
            tx.scroll_into_view("send");
            tx.instant();
        });
        rt.frame(1.0 / 60.0);
        // Check after scrolling and dispatch from that frame, with no second click.
        ui(rt, "enabled Send button", send_ready);
        let (x, y) = rt.find("send").expect("laid-out Send button");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        ui(rt, "permission button", |rt| a11y(rt, "allow_once"));
        assert_eq!(
            std::fs::read_to_string(Path::new(&folder).join("journey.txt")).unwrap(),
            "Journey before\n"
        );
    });
    step(&mut rt, &path, "tool-result", |rt| {
        tap(rt, "allow_once");
        ui(rt, REPLY, |rt| text(rt, REPLY));
        ui(rt, "tool card", |rt| text(rt, "Write journey.txt"));
        assert_eq!(
            std::fs::read_to_string(Path::new(&folder).join("journey.txt")).unwrap(),
            "Journey after permission\n"
        );
    });
    step(&mut rt, &path, "files", |rt| {
        if rt.find("right-panel-tab-1").is_none() {
            tap(rt, "right-panel-toggle");
        }
        tap(rt, "right-panel-tab-1");
        ui(rt, "workspace file", |rt| a11y(rt, "file-row-journey.txt"));
        let (x, y) = rt.find("file-row-journey.txt").unwrap();
        rt.pointer_move(x, y);
        rt.frame(1.0 / 60.0);
        tap(rt, "workspace-actions:journey.txt:pinned:preview");
        ui(rt, "file content", |rt| {
            crate::files::has_preview(&rt.state) && text(rt, "Journey after permission")
        });
    });
    step(&mut rt, &path, "diff", |rt| {
        tap(rt, "git-mode/segment1");
        let preview = "git-row-unstaged:preview:journey.txt";
        ui(rt, "diff preview action", |rt| a11y(rt, preview));
        tap(rt, preview);
        ui(rt, "removed and added lines", |rt| {
            nodes(&rt.accessibility_json()).any(|node| {
                node["name"] == "Git diff"
                    && node["role"] == "region"
                    && contains(node, "removed line 1: Journey before")
                    && contains(node, "added line 1: Journey after permission")
            })
        });
    });
    step(&mut rt, &path, "commit", |rt| {
        tap(rt, "git-row-unstaged:stage:journey.txt");
        ui(rt, "staged row", |rt| {
            a11y(rt, "git-row-staged:file:journey.txt")
        });
        type_text(rt, "git-commit-message", COMMIT);
        ui(rt, "commit enabled", |rt| {
            rt.elements().iter().any(|node| {
                node.key.as_deref() == Some("git-commit") && node.focusable && !node.exiting
            })
        });
        tap(rt, "git-commit");
        ui(rt, "staged row cleared", |rt| {
            !a11y(rt, "git-row-staged:file:journey.txt")
        });
        assert!(a11y(rt, "git-commit"));
    });
    step(&mut rt, &path, "search-history", |rt| {
        tap(rt, "git-mode/segment2");
        ui(rt, "both commits before filtering", |rt| {
            text(rt, COMMIT) && text(rt, "Journey start")
        });
        type_text(rt, "git-filter", COMMIT);
        assert!(text(rt, COMMIT) && !text(rt, "Journey start"));
    });
    #[cfg(target_os = "windows")]
    super::window_restore::close_hidden_window(rt, |state, tx| {
        super::window_restore::finish_window_state(state, tx);
        println!("{}", json!({"nativeWindowClosed":true}));
    });
    #[cfg(not(target_os = "windows"))]
    finish(rt);
}
