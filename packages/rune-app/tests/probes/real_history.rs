//! Real OpenCode qualification, using Rune's CPU-only runtime and an owned fault proxy.
use super::recovery::{anchor, check_anchor, control};
use crate::{Phase, State, composer::send, init, latest, poll, request_older, setup, view};
use rune::{Env, Runtime};
use serde_json::json;
use std::time::{Duration, Instant};
fn wait(rt: &mut Runtime<State>, label: &str, predicate: impl Fn(&State) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(120);
    while !predicate(&rt.state) {
        assert!(
            rt.state.phase != Phase::Failed,
            "real history operation failed: {label}"
        );
        assert!(Instant::now() < deadline, "real history timed out: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(15));
    }
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
}
fn canonical(rt: &Runtime<State>, rows: &[serde_json::Value]) {
    assert_eq!(
        rt.state.messages.len(),
        rows.len(),
        "the entire authoritative slice is visible"
    );
    let mut ids = std::collections::HashSet::new();
    for (row, stored) in rt.state.messages.iter().zip(rows) {
        assert!(ids.insert(&row.id), "no duplicate native row");
        assert_eq!(row.id, stored["id"]);
        assert_eq!(row.body, stored["body"], "exact stored text");
    }
}
pub fn run() {
    let mut rt = Runtime::new(init(), view, (960.0, 760.0), Env::new(true, 1.0));
    rt.poll = Some(poll);
    setup(&mut rt.state, std::sync::Arc::new(|| {}));
    wait(&mut rt, "latest native window", |s| {
        s.messages.len() == 200 && s.phase == Phase::Ready
    });
    let expected = control("expected");
    let rows = expected["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 600);
    canonical(&rt, &rows[400..]);
    // The bounded windows overlap; together they must cover all 600 stored rows.
    for (first, end) in [(216, 416), (32, 232), (0, 48)] {
        rt.update(request_older);
        wait(&mut rt, "older native page", |s| !s.paging);
        canonical(&rt, &rows[first..end]);
    }
    assert!(!rt.state.can_older);
    rt.update(latest);
    wait(&mut rt, "return to latest", |s| {
        s.phase == Phase::Ready && !s.history_detached && s.messages.len() == 200
    });
    canonical(&rt, &rows[400..]);
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    rt.frame(0.0);
    let reading = anchor(&rt);
    rt.update(|s,tx|{s.draft=rune::TextEdit::new("Sans aucun outil ni fichier à créer, réponds uniquement par un bloc de code Rust. Dans main, écris soixante déclarations explicites et distinctes, de let value_01 = 1; à let value_60 = 60;, chacune sur sa ligne, puis println!(\"RUNE-REAL-REPRISE\");. Ne remplace pas les déclarations par une boucle.");send(s,tx,false);});
    wait(&mut rt, "real streamed response and recovery", |s| {
        if s.phase != Phase::Ready
            || !s
                .messages
                .iter()
                .any(|r| r.role == "assistant" && r.body.contains("RUNE-REAL-REPRISE"))
        {
            return false;
        }
        let stats = control("stats");
        stats["terminals"] == 1 && stats["cuts"] == 1
    });
    let expected = control("expected");
    let rows = expected["rows"].as_array().unwrap();
    canonical(&rt, &rows[400..]);
    let max_jump = check_anchor(&rt, &reading);
    let stats = control("stats");
    assert_eq!(stats["prompts"], 1);
    assert_eq!(stats["cuts"], 1);
    assert_eq!(stats["tools"], 0);
    assert!(stats["nativeFragments"].as_u64().unwrap() >= 2);
    assert!(stats["sseConnections"].as_u64().unwrap() >= 2);
    println!(
        "{}",
        json!({"result":"real-opencode-history-recovery-ok","nativeRows":rt.state.messages.len(),"maxAnchorJumpPoints":max_jump,"stats":stats})
    );
}
