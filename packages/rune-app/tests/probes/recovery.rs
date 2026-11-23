//! CPU-only Rune runtime: no window, GPU presentation, global input or clipboard access.
use crate::{Phase, State, init, poll, request_older, send, setup, view};
use rune::{Env, Runtime};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
fn wait(rt: &mut Runtime<State>, label: &str, predicate: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !predicate(&rt.state) {
        assert!(
            Instant::now() < deadline,
            "timed out: {label}, {} rows",
            rt.state.messages.len()
        );
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
}
pub(crate) fn control(path: &str) -> Value {
    let base = std::env::var("RUNE_TEST_CONTROL").unwrap();
    let url = reqwest::Url::parse(&base).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    crate::platform::block_on(async {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{base}{path}"))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    })
}
pub(crate) fn anchor(rt: &Runtime<State>) -> (String, f32) {
    let prefix = "/history/rows/";
    let row = rt
        .elements()
        .into_iter()
        .find(|e| {
            e.visible[3] > 2.0
                && e.path
                    .rsplit_once(prefix)
                    .map(|(_, tail)| tail)
                    .is_some_and(|tail| !tail.contains('/'))
        })
        .expect("visible native row");
    (row.path.rsplit_once(prefix).unwrap().1.into(), row.rect[1])
}
pub(crate) fn check_anchor(rt: &Runtime<State>, anchor: &(String, f32)) -> f32 {
    let y = rt
        .elements()
        .iter()
        .find(|row| row.path.ends_with(&format!("/{}", anchor.0)))
        .expect("reading anchor retained")
        .rect[1];
    let delta = (y - anchor.1).abs();
    assert!(delta < 0.5, "reading anchor jumped by {delta} points");
    delta
}
pub fn suspend() {
    let backend = crate::platform::block_on(async {
        let target = crate::platform::configured_target(true)?;
        target
            .authenticate(&std::env::var("RUNE_PASSWORD").unwrap_or_default(), None)
            .await?;
        crate::history::Result::Ok(target)
    })
    .unwrap();
    let mut state = init();
    crate::gallery::shell::fixture(&mut state);
    let mut project = state.screen.launcher().unwrap().project.clone().unwrap();
    project.id.clone_from(&backend.workspace);
    state.screen.launcher_mut().unwrap().project = Some(project.clone());
    state.workspace = Some(crate::workspace::Ui::new());
    crate::workspace::connected(&mut state);
    crate::workspace::opened(&mut state, &project);
    crate::workspace::bound(&mut state, &backend);
    let tab = state.workspace.as_ref().unwrap().active_key().to_owned();
    let mut rt = Runtime::new(state, view, (960.0, 760.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    rt.update(move |s, _| crate::transport::start_bound(s, backend));
    wait(&mut rt, "initial observed transcript", |s| {
        s.messages.len() == 200 && s.phase == Phase::Ready
    });
    let toggle = "toggle-tool-message-00410:6:reveal";
    rt.update(|_, tx| tx.scroll_key_to("message-00410", 0.0));
    for _ in 0..12 {
        rt.frame(0.02);
    }
    let (x, y) = rt.find(toggle).expect("fixture tool disclosure");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert!(
        rt.state
            .transcript_display
            .toggled("tool-message-00410:6:reveal")
    );
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 1600.0));
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let viewport_relative = |rt: &Runtime<State>, y: f32| {
        y - rt
            .elements()
            .into_iter()
            .find(|e| e.key.as_deref() == Some("history"))
            .unwrap()
            .rect[1]
    };
    let (id, y) = anchor(&rt);
    let offset = viewport_relative(&rt, y);
    control("hold-window");
    rt.update(request_older);
    assert!(rt.state.paging);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if control("stats")["heldReadStarted"] == 1 {
            break;
        }
        assert!(Instant::now() < until, "history body dispatched");
        rt.frame(0.02);
    }
    rt.update(|s, _| s.draft = rune::TextEdit::new("keep this draft"));
    rt.update(crate::workspace::new_tab);
    assert_ne!(rt.state.workspace.as_ref().unwrap().active_key(), tab);
    rt.update(|s, _| {
        assert_eq!(crate::workspace::evict_for_probe(s, &tab), Some((200, 0)));
    });
    control("step-while-hidden");
    let busy_label = crate::strings::t("instanceTab.status.working");
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        rt.frame(0.02);
        if rt.accessibility_json().to_string().contains(busy_label) {
            break;
        }
        assert!(
            Instant::now() < until,
            "first hidden step marks the project tab as working"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    control("finish-hidden-step");
    control("question-while-hidden");
    let question_badge = crate::strings::t("instanceTab.status.permission");
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        rt.frame(0.02);
        if rt.accessibility_json().to_string().contains(question_badge) {
            break;
        }
        assert!(
            Instant::now() < until,
            "hidden tab observes the new question"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let pages = control("permission-while-hidden")["pages"].clone();
    assert!(rt.state.messages.is_empty());
    assert_eq!(control("stats")["pages"], pages);
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if control("stats")["heldReadCancelled"] == 1 {
            break;
        }
        assert!(Instant::now() < until, "suspension cancels the HTTP body");
        rt.frame(0.02);
    }
    control("permission-during-gap");
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        if control("stats")["gapPermissionReads"].as_u64().unwrap() > 0 {
            break;
        }
        assert!(
            Instant::now() < until,
            "hidden tab must reconcile permissions"
        );
        rt.frame(0.02);
        std::thread::sleep(Duration::from_millis(5));
    }
    let stats = control("stats");
    assert_eq!(stats["pages"], pages);
    assert_eq!(stats["transportConnections"], 1, "upstream-only reconnect");
    for attempt in 1..=7 {
        let before = control("cut-observer");
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            let stats = control("stats");
            if stats["transportConnections"] == attempt + 1
                && stats["gapPermissionReads"].as_u64() > before["gapPermissionReads"].as_u64()
            {
                break;
            }
            assert!(
                Instant::now() < until,
                "suspended observer reconnect {attempt}"
            );
            rt.frame(0.02);
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    assert_eq!(control("permission-after-reopens")["pages"], pages);
    let (x, y) = rt.find(&format!("t-{tab}")).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    wait(&mut rt, "resume on the native anchor", |s| {
        s.messages
            .first()
            .is_some_and(|row| row.id.as_str() < "message-00400")
            && s.messages.iter().any(|row| row.id == id)
    });
    let restored = rt
        .elements()
        .into_iter()
        .find(|e| e.key.as_deref() == Some(id.as_str()))
        .unwrap();
    let shift = (viewport_relative(&rt, restored.rect[1]) - offset).abs();
    assert!(shift < 0.5, "reading anchor shifted by {shift} points");
    assert_eq!(control("stats")["resumedAnchor"], id);
    wait(
        &mut rt,
        "permissions are available after returning to the tab",
        |s| {
            s.agent.as_ref().is_some_and(|agent| {
                agent.online
                    && agent.forms.iter().any(|form| form.id == "form-suspended")
                    && [
                        "permission-suspended",
                        "permission-during-gap",
                        "permission-after-reopens",
                    ]
                    .iter()
                    .all(|id| agent.permissions.iter().any(|p| p.id == *id))
            })
        },
    );
    rt.update(|s, _| {
        s.agent
            .as_mut()
            .unwrap()
            .select_request("permission-suspended".into())
    });
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("synthetic.txt")
    );
    assert_eq!(rt.state.draft.text, "keep this draft");
    assert!(
        rt.state
            .transcript_display
            .toggled("tool-message-00410:6:reveal")
    );
    rt.update(|s, _| {
        s.agent
            .as_mut()
            .unwrap()
            .select_request("form-suspended".into())
    });
    assert!(
        rt.accessibility_json()
            .to_string()
            .contains("Question received while hidden")
    );
    assert!(rt.find("answer-question").is_some());
    rt.update(|_, tx| tx.scroll_key_to("message-00410", 0.0));
    for _ in 0..12 {
        rt.frame(0.02);
    }
    assert!(rt.find(toggle).is_some());
    assert!(
        rt.accessibility_tree().nodes.into_iter().any(|(_, node)| {
            node.author_id() == Some(toggle) && node.is_expanded() == Some(true)
        })
    );
    println!(
        "{}",
        json!({"kind":"suspended-reader", "anchor":id, "shift":shift, "permissionVisible":true,
            "questionVisible":true, "disclosureAfterEviction":true})
    );
}
fn canonical(rt: &Runtime<State>, count: usize) {
    assert_eq!(rt.state.messages.len(), count);
    for (i, row) in rt.state.messages.iter().enumerate() {
        assert_eq!(
            row.id,
            format!("message-{i:05}"),
            "ordered, unique native rows"
        );
    }
    let expected = control("expected");
    for (row, expected) in rt.state.messages.iter().zip(expected.as_array().unwrap()) {
        assert_eq!(row.id, expected["id"]);
        assert_eq!(row.body, expected["body"]);
    }
}
pub fn run() {
    let mut rt = Runtime::new(init(), view, (960.0, 760.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    setup(&mut rt.state, std::sync::Arc::new(|| {}));
    wait(&mut rt, "initial window", |s| {
        s.messages.len() == 200 && s.phase == Phase::Ready
    });
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    rt.frame(0.0);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let reading = anchor(&rt);
    rt.update(request_older);
    wait(&mut rt, "first old page", |s| {
        s.messages.len() == 384 && !s.paging
    });
    let mut max_jump = check_anchor(&rt, &reading);
    let before = rt.state.messages.clone();
    control("block-older");
    rt.update(request_older);
    wait(&mut rt, "blocked page", |s| s.history_error && !s.paging);
    assert_eq!(
        rt.state.messages, before,
        "failed page keeps the current snapshot"
    );
    max_jump = max_jump.max(check_anchor(&rt, &reading));
    rt.update(request_older);
    wait(&mut rt, "explicit page retry", |s| {
        s.messages.len() == 568 && !s.paging
    });
    max_jump = max_jump.max(check_anchor(&rt, &reading));
    control("stale-older");
    rt.update(request_older);
    wait(&mut rt, "late page fenced after disconnect", |s| {
        s.phase == Phase::Ready
            && !s.paging
            && s.messages
                .iter()
                .any(|r| r.id == "message-00250" && r.body.contains("edited during stale page"))
    });
    assert_eq!(
        rt.state.messages.len(),
        568,
        "stale older response is rejected"
    );
    assert_eq!(rt.state.messages[0].id, "message-00032");
    max_jump = max_jump.max(check_anchor(&rt, &reading));
    rt.update(request_older);
    wait(&mut rt, "oldest page", |s| {
        s.messages.len() == 600 && !s.paging
    });
    canonical(&rt, 600);
    max_jump = max_jump.max(check_anchor(&rt, &reading));
    rt.update(|s, tx| {
        s.draft = rune::TextEdit::new("Recovery synthetic prompt");
        send(s, tx);
    });
    wait(&mut rt, "initial live delta", |s| {
        s.messages
            .iter()
            .any(|r| r.id == "message-00601" && r.body.contains("début"))
    });
    control("transport-cut");
    wait(&mut rt, "transport recovery", |s| {
        s.phase == Phase::Ready && s.messages.len() == 604
    });
    canonical(&rt, 604);
    max_jump = max_jump.max(check_anchor(&rt, &reading));
    let pages = control("stats")["pages"].as_u64().unwrap();
    control("replay");
    wait(&mut rt, "post-reconnect authoritative read", |s| {
        s.phase == Phase::Ready
            && s.messages.len() == 604
            && control("stats")["pages"].as_u64().unwrap() > pages
    });
    canonical(&rt, 604);
    control("upstream-cut");
    wait(&mut rt, "Rust upstream generation recovery", |s| {
        s.phase == Phase::Ready
            && s.messages.len() == 606
            && s.messages[10].body.contains("upstream")
    });
    canonical(&rt, 606);
    max_jump = max_jump.max(check_anchor(&rt, &reading));
    let final_snapshot = rt.state.messages.clone();
    control("remove-anchor");
    wait(&mut rt, "missing anchor fails closed", |s| {
        s.phase == Phase::Failed
    });
    assert_eq!(
        rt.state.messages, final_snapshot,
        "missing anchors keep the last display and disable sending"
    );
    let stats = control("stats");
    assert_eq!(stats["prompts"], 1, "reconnect never resends a prompt");
    assert_eq!(
        stats["latestReads"], 1,
        "recovery never falls back to a mass latest read"
    );
    println!(
        "{}",
        json!({"result":"recovery-probe-ok","canonicalRows":606,"maxAnchorJumpPoints":max_jump,
        "checks":["overlap-pagination","page-error-retention","stale-page-fence","transport-resume","seeded-delta-replay","upstream-generation","missing-anchor"],"stats":stats})
    );
}
