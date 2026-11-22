//! CPU-only Rune runtime: no window, GPU presentation, global input or clipboard access.
use crate::{Phase, State, composer::send, init, poll, request_older, setup, view};
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
    let prefix = "session-stack/history/rows/";
    let row = rt
        .elements()
        .into_iter()
        .find(|e| {
            e.visible[3] > 2.0
                && e.path
                    .split_once(prefix)
                    .is_some_and(|(_, tail)| !tail.contains('/'))
        })
        .expect("visible native row");
    (row.path.split_once(prefix).unwrap().1.into(), row.rect[1])
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
fn canonical(rt: &Runtime<State>, first: usize, count: usize) {
    assert_eq!(rt.state.messages.len(), count);
    for (i, row) in rt.state.messages.iter().enumerate() {
        assert_eq!(
            row.id,
            format!("message-{:05}", first + i),
            "ordered, unique native rows"
        );
    }
    let expected = control("expected");
    for (row, expected) in rt
        .state
        .messages
        .iter()
        .zip(expected.as_array().unwrap().iter().skip(first))
    {
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
    rt.update(request_older);
    wait(&mut rt, "first old page", |s| {
        s.messages
            .first()
            .is_some_and(|row| row.id == "message-00216")
            && !s.paging
    });
    canonical(&rt, 216, 200);
    control("revert-in-history");
    wait(
        &mut rt,
        "detached revert returns to an authoritative window",
        |s| {
            !s.history_detached
                && s.messages
                    .iter()
                    .any(|row| row.body == "authoritative after revert")
        },
    );
    canonical(&rt, 400, 200);
    rt.update(request_older);
    wait(&mut rt, "old window after revert", |s| {
        s.history_detached
            && s.messages
                .first()
                .is_some_and(|row| row.id == "message-00216")
    });
    let before = rt.state.messages.clone();
    control("block-older");
    rt.update(request_older);
    wait(&mut rt, "blocked page", |s| s.history_error && !s.paging);
    assert_eq!(
        rt.state.messages, before,
        "failed page keeps the current snapshot"
    );
    rt.update(request_older);
    wait(&mut rt, "explicit page retry", |s| {
        s.messages
            .first()
            .is_some_and(|row| row.id == "message-00032")
            && !s.paging
    });
    canonical(&rt, 32, 200);
    let connections = control("stats")["transportConnections"].as_u64().unwrap();
    control("stale-older");
    rt.update(request_older);
    wait(&mut rt, "late page fenced after disconnect", |s| {
        s.history_error
            && !s.paging
            && s.agent.as_ref().is_some_and(|agent| agent.online)
            && control("stats")["transportConnections"].as_u64().unwrap() > connections
    });
    assert_eq!(
        rt.state.messages.len(),
        200,
        "stale older response is rejected"
    );
    assert_eq!(rt.state.messages[0].id, "message-00032");
    rt.update(request_older);
    wait(&mut rt, "oldest page", |s| {
        s.messages.len() == 48 && !s.paging
    });
    canonical(&rt, 0, 48);
    rt.update(crate::latest);
    wait(&mut rt, "explicit latest page", |s| {
        s.phase == Phase::Ready && !s.history_detached && s.messages.len() == 200
    });
    canonical(&rt, 400, 200);
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    rt.frame(0.0);
    let reading = anchor(&rt);
    rt.update(|s, tx| {
        s.draft = rune::TextEdit::new("Recovery synthetic prompt");
        send(s, tx, false);
    });
    wait(&mut rt, "initial live delta", |s| {
        s.messages
            .iter()
            .any(|r| r.id == "message-00601" && r.body.contains("début"))
    });
    control("transport-cut");
    wait(&mut rt, "transport recovery", |s| {
        s.phase == Phase::Ready && s.messages.len() == 204
    });
    canonical(&rt, 400, 204);
    let mut max_jump = check_anchor(&rt, &reading);
    let pages = control("stats")["pages"].as_u64().unwrap();
    control("replay");
    wait(&mut rt, "post-reconnect authoritative read", |s| {
        s.phase == Phase::Ready
            && s.messages.len() == 204
            && control("stats")["pages"].as_u64().unwrap() > pages
    });
    canonical(&rt, 400, 204);
    control("upstream-cut");
    wait(&mut rt, "Rust upstream generation recovery", |s| {
        s.phase == Phase::Ready
            && s.messages.len() == 206
            && s.messages[10].body.contains("upstream")
    });
    canonical(&rt, 400, 206);
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
        stats["latestReads"], 3,
        "recovery never falls back to a mass latest read"
    );
    println!(
        "{}",
        json!({"result":"recovery-probe-ok","canonicalRows":206,"maxAnchorJumpPoints":max_jump,
        "checks":["window-replacement","page-error-retention","stale-page-fence","transport-resume","seeded-delta-replay","upstream-generation","missing-anchor"],"stats":stats})
    );
}
