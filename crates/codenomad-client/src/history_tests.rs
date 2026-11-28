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
            usage: None,
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
            usage: None,
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

#[test]
fn resident_heavy_window_trims_around_anchor_at_start_middle_end_and_without_anchor() {
    // 60 assistant messages x 100 KiB text -> ~6 MiB wire (< 24 MiB) but ~12 MiB resident
    // (body + Part::Text > 8 MiB MAX_BYTES).
    let text = "A".repeat(100 * 1024);
    let rows: Vec<_> = (0..60)
        .map(|i| {
            json!({
                "id": format!("msg_{i}"),
                "type": "assistant",
                "time": {"completed": i + 1},
                "content": [{"type": "text", "text": text}]
            })
        })
        .collect();
    let payload = json!({
        "status": "window",
        "latest": true,
        "older": null,
        "newer": null,
        "messages": rows
    });

    // Without anchor (default decode) -> keeps newest tail and synthesizes older cursor.
    let no_anchor = history::decode(payload.clone()).expect("window > 8 MiB must trim, not fail");
    assert_eq!(no_anchor.rows.last().unwrap().id, "msg_59");
    assert!(no_anchor.rows.len() < 60 && no_anchor.rows.len() >= 30);
    assert_eq!(
        no_anchor.older,
        Some(json!({"kind": "before", "messageID": no_anchor.rows[0].id}))
    );
    assert!(no_anchor.newer.is_none());
    assert!(history::check(&no_anchor.rows).is_ok());

    // Anchor at end (around msg_59).
    let end_anchor = history::decode_target(
        payload.clone(),
        &json!({"kind": "around", "messageID": "msg_59"}),
    )
    .unwrap();
    assert_eq!(end_anchor.rows.last().unwrap().id, "msg_59");
    assert!(end_anchor.older.is_some() && end_anchor.newer.is_none());
    assert!(history::check(&end_anchor.rows).is_ok());

    // Anchor at start (oldest and around msg_0).
    let start_oldest = history::decode_target(payload.clone(), &json!({"kind": "oldest"})).unwrap();
    assert_eq!(start_oldest.rows.first().unwrap().id, "msg_0");
    assert!(start_oldest.older.is_none());
    assert_eq!(
        start_oldest.newer,
        Some(json!({"kind": "after", "messageID": start_oldest.rows.last().unwrap().id}))
    );
    assert!(history::check(&start_oldest.rows).is_ok());

    let start_around = history::decode_target(
        payload.clone(),
        &json!({"kind": "around", "messageID": "msg_0"}),
    )
    .unwrap();
    assert_eq!(start_around.rows.first().unwrap().id, "msg_0");
    assert!(start_around.older.is_none() && start_around.newer.is_some());
    assert!(history::check(&start_around.rows).is_ok());

    // Anchor in the middle (around msg_30) -> preserves msg_30 intact and sets both cursors.
    let mid =
        history::decode_target(payload, &json!({"kind": "around", "messageID": "msg_30"})).unwrap();
    let anchored = mid.rows.iter().find(|r| r.id == "msg_30").unwrap();
    assert_eq!(anchored.body, text);
    assert_eq!(
        mid.older,
        Some(json!({"kind": "before", "messageID": mid.rows.first().unwrap().id}))
    );
    assert_eq!(
        mid.newer,
        Some(json!({"kind": "after", "messageID": mid.rows.last().unwrap().id}))
    );
    assert!(history::check(&mid.rows).is_ok());
}

#[test]
fn resident_heavy_tool_json_window_trims_around_anchor_instead_of_rejecting() {
    // Many tiny JSON array elements inflate resident_json far beyond wire size:
    // ~250 KiB resident per message x 50 messages = ~12.5 MiB resident, < 2 MiB on the wire.
    let items: Vec<_> = (0..10_000).map(|_| json!("")).collect();
    let rows: Vec<_> = (0..50)
        .map(|i| {
            json!({
                "id": format!("tool_{i}"),
                "type": "assistant",
                "time": {"completed": i + 1},
                "content": [{
                    "type": "tool",
                    "id": format!("call_{i}"),
                    "name": "search",
                    "state": {
                        "status": "completed",
                        "input": {"rows": items},
                        "content": [{"type": "text", "text": "ok"}]
                    }
                }]
            })
        })
        .collect();
    let payload = json!({
        "status": "window",
        "latest": true,
        "older": null,
        "newer": null,
        "messages": rows
    });
    let page = history::decode_target(payload, &json!({"kind": "around", "messageID": "tool_25"}))
        .unwrap();
    assert!(page.rows.iter().any(|r| r.id == "tool_25"));
    assert!(page.rows.len() < 50);
    assert!(page.older.is_some() && page.newer.is_some());
    assert!(history::check(&page.rows).is_ok());
}

#[test]
fn oversized_multibyte_single_messages_and_continuations_stay_utf8_valid_and_within_budget() {
    // 1. Single > 8 MiB user message made of 4-byte UTF-8 emojis (<= 16 MiB MESSAGE_BYTES).
    let emoji_9m = "🚀".repeat(2_300_000); // 9.2 MiB UTF-8
    let user_payload = json!({
        "status": "window",
        "latest": true,
        "older": null,
        "newer": null,
        "messages": [{"id": "u_big", "type": "user", "text": emoji_9m}]
    });
    let user_page = history::decode(user_payload).unwrap();
    assert_eq!(user_page.rows.len(), 1);
    assert_eq!(user_page.rows[0].id, "u_big");
    assert!(user_page.rows[0].body.len() <= history::MAX_BYTES);
    assert!(user_page.rows[0].body.chars().all(|c| c == '🚀'));
    assert!(history::check(&user_page.rows).is_ok());

    // 2. Single assistant message with 9 MiB of 3-byte CJK text (triggers decode_bounded + bound_message).
    let cjk_9m = "漢".repeat(3_000_000); // 9.0 MiB UTF-8
    let asst_payload = json!({
        "status": "window",
        "latest": true,
        "older": null,
        "newer": null,
        "messages": [{
            "id": "a_big",
            "type": "assistant",
            "time": {"completed": 1},
            "content": [{"type": "text", "text": cjk_9m}]
        }]
    });
    let asst_page = history::decode(asst_payload).unwrap();
    assert_eq!(asst_page.rows.len(), 1);
    assert_eq!(asst_page.rows[0].id, "a_big");
    assert!(!asst_page.rows[0].body.is_empty());
    assert!(asst_page.rows[0].body.chars().all(|c| c == '漢'));
    assert!(history::check(&asst_page.rows).is_ok());

    // 3. `before` continuation where anchor (5 MiB) + older neighbor (5 MiB) > 8 MiB:
    // keeps BOTH rows so pagination preserves overlap and makes progress, while staying <= 8 MiB.
    let five_mb = "é".repeat(2_600_000); // 5.2 MiB UTF-8
    let cont_payload = json!({
        "status": "window",
        "latest": false,
        "older": null,
        "newer": {"kind": "after", "messageID": "m_anchor"},
        "messages": [
            {"id": "m_older", "type": "user", "text": five_mb},
            {"id": "m_anchor", "type": "user", "text": five_mb}
        ]
    });
    let before_page = history::decode_target(
        cont_payload,
        &json!({"kind": "before", "messageID": "m_anchor"}),
    )
    .unwrap();
    assert_eq!(before_page.rows.len(), 2);
    assert_eq!(before_page.rows[0].id, "m_older");
    assert_eq!(before_page.rows[1].id, "m_anchor");
    assert!(before_page.rows[0].body.chars().all(|c| c == 'é'));
    assert!(before_page.rows[1].body.chars().all(|c| c == 'é'));
    assert!(history::check(&before_page.rows).is_ok());
    assert!(
        history::edge_page(
            &before_page,
            &[before_page.rows[1].clone()],
            crate::transport::HistoryEdge::Before
        )
        .is_ok()
    );

    // 4. Zero-cost `idle` neighbours around an oversized anchor must not shrink the anchor's budget.
    let idle_wrapped = json!({
        "status": "window",
        "latest": true,
        "older": null,
        "newer": null,
        "messages": [
            {"id": "idle_0", "type": "idle"},
            {"id": "u_center", "type": "user", "text": emoji_9m},
            {"id": "idle_1", "type": "idle"}
        ]
    });
    let idle_page = history::decode_target(
        idle_wrapped,
        &json!({"kind": "around", "messageID": "u_center"}),
    )
    .unwrap();
    let center = idle_page.rows.iter().find(|r| r.id == "u_center").unwrap();
    assert!(
        center.body.len() > history::MAX_BYTES - 1024,
        "idle neighbours must not shrink anchor to MAX_BYTES / 3 (got {})",
        center.body.len()
    );
    assert!(center.body.chars().all(|c| c == '🚀'));
    assert!(history::check(&idle_page.rows).is_ok());

    // 5. `system` message carrying > 8 MiB across body + content parts stays within budget.
    let sys_payload = json!({
        "status": "window",
        "latest": true,
        "older": null,
        "newer": null,
        "messages": [{
            "id": "sys_big",
            "type": "system",
            "text": "s".repeat(5 * 1024 * 1024),
            "content": [{"type": "text", "text": "漢".repeat(1_500_000)}]
        }]
    });
    let sys_page = history::decode(sys_payload).unwrap();
    assert_eq!(sys_page.rows.len(), 1);
    assert!(history::check(&sys_page.rows).is_ok());
}
