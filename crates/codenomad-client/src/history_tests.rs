use crate::{
    Message,
    history::{self, Page},
};
use serde_json::json;

#[test]
fn older_pages_preserve_complete_tool_text_above_the_metadata_budget() {
    let rows: Vec<_> = (0..20).map(|i| history::decode_message(&json!({
        "id": format!("part_{i}"),
        "type": "assistant",
        "content": [{
            "type": "tool", "id": "call", "name": "read",
            "state": {"status": "completed", "content": [{"type": "text", "text": "x".repeat(450 * 1024)}]}
        }]
    })).unwrap().into()).collect();
    let mut resident = rows[17..].to_vec();
    for index in (0usize..17).rev().step_by(2) {
        resident = history::join(&rows[index.saturating_sub(1)..=index + 1], &resident).unwrap();
    }
    assert_eq!(resident, rows);
    assert_eq!(
        crate::content::tool_text_bytes(&resident[0].parts),
        450 * 1024
    );
}

#[test]
fn edit_patches_in_metadata_share_the_tool_text_budget() {
    let rows: Vec<_> = (0..25)
        .map(|i| {
            history::decode_message(&json!({
                "id": format!("edit_{i}"),
                "type": "assistant",
                "content": [{
                    "type": "tool", "id": "call", "name": "edit",
                    "state": {"status": "completed", "input":{"newString":"x".repeat(170 * 1024)},
                        "metadata":{"files":[{"patch":"p".repeat(180 * 1024)}]}}
                }]
            }))
            .unwrap()
            .into()
        })
        .collect();
    let mut resident = rows[24..].to_vec();
    for i in (0..24).rev() {
        resident = history::join(&rows[i..=i + 1], &resident).unwrap();
    }
    assert_eq!(resident, rows);
}

fn rows(ids: &[&str]) -> Vec<history::Row> {
    ids.iter()
        .map(|id| Message {
            parts: vec![],
            id: (*id).into(),
            role: "assistant".into(),
            completed: true,
            body: format!("body {id}"),
        })
        .map(std::sync::Arc::new)
        .collect()
}
#[test]
fn overlap_preserves_native_order_and_replaces_overlap_authoritatively() {
    let a = rows(&["z", "y", "x"]);
    let mut b = rows(&["y", "x", "w"]);
    std::sync::Arc::make_mut(&mut b[0]).body = "changed".into();
    let merged = history::join(&a, &b).unwrap();
    assert_eq!(
        merged.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["z", "y", "x", "w"]
    );
    assert_eq!(merged[1].body, "changed");
    assert!(std::sync::Arc::ptr_eq(&a[0], &merged[0]));
    assert!(std::sync::Arc::ptr_eq(&b[0], &merged[1]));
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
        .map(std::sync::Arc::new)
        .collect::<Vec<_>>();
    assert!(history::check(&many).is_err());
    let mut huge = rows(&["a"]);
    std::sync::Arc::make_mut(&mut huge[0]).body = "x".repeat(history::MAX_BYTES + 1);
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
