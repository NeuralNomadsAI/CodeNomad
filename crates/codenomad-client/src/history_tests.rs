use crate::{
    Message,
    history::{self, Page},
};
use serde_json::json;
fn rows(ids: &[&str]) -> Vec<Message> {
    ids.iter()
        .map(|id| Message {
            parts: vec![],
            id: (*id).into(),
            role: "assistant".into(),
            completed: true,
            body: format!("body {id}"),
        })
        .collect()
}
#[test]
fn overlap_preserves_native_order_and_replaces_overlap_authoritatively() {
    let a = rows(&["z", "y", "x"]);
    let mut b = rows(&["y", "x", "w"]);
    b[0].body = "changed".into();
    let merged = history::join(&a, &b).unwrap();
    assert_eq!(
        merged.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["z", "y", "x", "w"]
    );
    assert_eq!(merged[1].body, "changed");
}
#[test]
fn broken_overlap_duplicate_ids_and_resident_overflow_fail_closed() {
    assert!(history::join(&rows(&["a", "b"]), &rows(&["d", "e"])).is_err());
    assert!(history::join(&rows(&["a", "b"]), &rows(&["b", "a"])).is_err());
    let many = (0..=history::MAX_ROWS)
        .map(|i| Message {
            parts: vec![],
            id: format!("m{i}"),
            role: "user".into(),
            completed: true,
            body: "x".into(),
        })
        .collect::<Vec<_>>();
    assert!(history::check(&many).is_err());
    let mut huge = rows(&["a"]);
    huge[0].body = "x".repeat(history::MAX_BYTES + 1);
    assert!(history::check(&huge).is_err());
}
#[test]
fn malformed_and_blocked_windows_preserve_failure_instead_of_an_empty_success() {
    assert!(history::decode(json!({"status":"blocked","reason":"anchor_missing"})).is_err());
    assert!(
        history::decode(
            json!({"status":"window","messages":[],"older":null,"newer":null,"latest":false})
        )
        .is_err()
    );
    assert!(history::decode(json!({"status":"window","messages":[],"older":{"kind":"before","messageID":"../wrong"},"newer":null,"latest":true})).is_err());
    let page: Page = history::decode(
        json!({"status":"window","messages":[],"older":null,"newer":null,"latest":true}),
    )
    .unwrap();
    assert!(page.rows.is_empty());
    assert!(!page.running);
}
#[test]
fn stream_generation_rejects_a_read_started_before_a_disconnect() {
    use std::sync::atomic::Ordering::SeqCst;
    let state = crate::stream::State::default();
    state.alive.store(true, SeqCst);
    state.upstream.store(true, SeqCst);
    assert!(state.valid(0));
    state.version.fetch_add(1, SeqCst);
    assert!(!state.valid(0));
    state.alive.store(false, SeqCst);
    assert!(!state.valid(1));
}
