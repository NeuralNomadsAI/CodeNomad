//! Real OpenCode qualification, using Rune's CPU-only runtime and an owned fault proxy.
use super::recovery::{anchor, check_anchor, control};
use crate::{Phase, State, composer::send, init, poll, request_older, setup, view};
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
fn canonical(rt: &Runtime<State>) {
    let expected = control("expected");
    let rows = expected["rows"].as_array().unwrap();
    assert_eq!(
        rt.state.messages.len(),
        rows.len(),
        "all native rows retained"
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
    rt.update(|_, tx| tx.scroll_to_instant("history", 0.0, 0.0));
    rt.frame(0.0);
    let reading = anchor(&rt);
    let mut max_jump = 0.0f32;
    while rt.state.messages.len() < 600 {
        let before = rt.state.messages.len();
        rt.update(request_older);
        wait(&mut rt, "older native page", |s| {
            !s.paging && s.messages.len() > before
        });
        max_jump = max_jump.max(check_anchor(&rt, &reading));
    }
    canonical(&rt);
    println!("real history: 600 native stored rows, pagination and reading anchor verified");
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
    canonical(&rt);
    max_jump = max_jump.max(check_anchor(&rt, &reading));
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
