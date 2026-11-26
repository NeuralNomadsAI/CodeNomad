use super::scan::parse_bounded_image_uri;
use super::*;
use serde_json::{Value, json};

fn run_stream(workspace: &str, session: &str, input: &[u8], chunk_size: usize) -> (axum::body::Bytes, bool) {
    let mut stream = MessageListStream::new(workspace, session);
    for chunk in input.chunks(chunk_size) {
        let mut pos = 0;
        while let Some(pending) = stream.feed(chunk, &mut pos).unwrap() {
            let (ws, ses) = stream.ids().unwrap();
            let (out, undo) = project_item(ws, ses, pending.bytes);
            stream.commit_item(out, undo, pending.delimiter).unwrap();
        }
    }
    let (segments, total, backing, changed) = stream.finish().unwrap();
    let mut flat = Vec::with_capacity(total);
    let mut released = 0usize;
    for (seg, release) in segments {
        flat.extend_from_slice(&seg);
        released += release;
    }
    assert_eq!(flat.len(), total);
    assert_eq!(released, backing);
    (axum::body::Bytes::from(flat), changed)
}

#[test]
fn preserves_non_object_invalid_and_small_json_byte_for_byte() {
    for raw in [b"".as_slice(), b"[]", b"{}", b"null", b"not json", b"{\"data\":[]}", b"{\"other\":[1],\"data\":null}"]
    {
        for chunk in [1, 7, 1024] {
            let (out, changed) = run_stream("ws_1", "ses_1", raw, chunk);
            assert!(!changed);
            assert_eq!(out.as_ref(), raw);
        }
    }
}

#[test]
fn restores_original_bytes_when_document_tail_is_invalid_json() {
    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let valid_prefix = json!({
        "data": [
            {"id": "msg_big", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]}
        ]
    })
    .to_string();
    let trailing_garbage = format!("{valid_prefix} trailing");
    let truncated = valid_prefix[..valid_prefix.len() - 1].to_owned();
    let bad_tail = format!("{},\"tail\": [1,]}}", &valid_prefix[..valid_prefix.len() - 1]);
    for bad in [&trailing_garbage, &truncated, &bad_tail] {
        for chunk in [97, 4096, bad.len()] {
            let (out, changed) = run_stream("ws_1", "ses_1", bad.as_bytes(), chunk);
            assert!(!changed, "invalid JSON must not report changed");
            assert_eq!(out.as_ref(), bad.as_bytes());
        }
    }
}

#[test]
fn projects_large_tool_images_across_arbitrary_chunk_boundaries_and_other_keys() {
    let small = format!("data:image/png;base64,{}", "A".repeat(16));
    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let payload = json!({
        "meta": {"nested": [1, {"data": "ignored \"quoted\""}]},
        "data": [
            {"id": "msg_small", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": small}]}}]},
            {"id": "msg_big", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]}
        ],
        "next": "cursor_1"
    });
    let raw = payload.to_string();
    for chunk in [13, 4096, raw.len()] {
        let (out, changed) = run_stream("ws 1", "ses_1", raw.as_bytes(), chunk);
        assert!(changed);
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["meta"], payload["meta"]);
        assert_eq!(parsed["next"], "cursor_1");
        assert_eq!(parsed["data"][0]["content"][0]["state"]["content"][0]["uri"], small);
        let uri = parsed["data"][1]["content"][0]["state"]["content"][0]["uri"].as_str().unwrap();
        assert!(uri.starts_with("/api/workspaces/ws%201/session-media/ses_1/msg_big/0/0/"), "{uri}");
    }
}

#[test]
fn skips_dense_numeric_items_and_preserves_unknown_fields_without_value_tree() {
    let dense = format!("{{\"id\":\"msg_n\",\"type\":\"assistant\",\"nums\":[{}]}}", vec!["1"; 20_000].join(","));
    let (out, undo) = project_item("ws_1", "ses_1", dense.clone().into_bytes());
    assert!(undo.is_empty());
    assert_eq!(out, dense.as_bytes());

    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let with_nums = json!({
        "id": "msg_mix",
        "type": "assistant",
        "extra": [1, 2, 3, 4, 5],
        "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]
    });
    let (out, undo) = project_item("ws_1", "ses_1", with_nums.to_string().into_bytes());
    assert!(!undo.is_empty());
    let parsed: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(parsed["extra"], json!([1, 2, 3, 4, 5]));
    assert!(
        parsed["content"][0]["state"]["content"][0]["uri"]
            .as_str()
            .unwrap()
            .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_mix/0/0/")
    );

    let escaped_slash = format!(
        "{{\"id\":\"msg_esc\",\"type\":\"assistant\",\"content\":[{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"data:image\\/png;base64,{}\"}}]}}}}]}}",
        "A".repeat(40 * 1024)
    );
    let (out, undo) = project_item("ws_1", "ses_1", escaped_slash.into_bytes());
    assert!(!undo.is_empty());
    let parsed: Value = serde_json::from_slice(&out).unwrap();
    assert!(
        parsed["content"][0]["state"]["content"][0]["uri"]
            .as_str()
            .unwrap()
            .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_esc/0/0/")
    );

    let escaped_unicode = format!(
        "{{\"id\":\"msg_uni\",\"type\":\"assistant\",\"content\":[{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"\\u0064ata:image/png;base64,{}\"}}]}}}}]}}",
        "A".repeat(40 * 1024)
    );
    let (out, undo) = project_item("ws_1", "ses_1", escaped_unicode.into_bytes());
    assert!(!undo.is_empty());
    let parsed: Value = serde_json::from_slice(&out).unwrap();
    assert!(
        parsed["content"][0]["state"]["content"][0]["uri"]
            .as_str()
            .unwrap()
            .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_uni/0/0/")
    );

    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let mut big_parts = String::from("{\"id\":\"msg_huge\",\"type\":\"assistant\",\"content\":[");
    big_parts.push_str(&format!(
        "{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"{large}\"}}]}}}}",
    ));
    for _ in 0..100_005 {
        big_parts.push_str(",1");
    }
    big_parts.push_str("]}");
    let (out, undo) = project_item("ws_1", "ses_1", big_parts.into_bytes());
    assert!(!undo.is_empty());
    let parsed: Value = serde_json::from_slice(&out).unwrap();
    let parts = parsed["content"].as_array().unwrap();
    assert_eq!(parts.len(), 100_006);
    assert!(
        parts[0]["state"]["content"][0]["uri"]
            .as_str()
            .unwrap()
            .starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_huge/0/0/")
    );
    assert_eq!(parts[100_005], 1);
}

#[test]
fn projects_subsequent_duplicate_data_keys() {
    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let item = json!({
        "id": "msg_dup",
        "type": "assistant",
        "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]
    })
    .to_string();
    for raw in [format!("{{\"data\":[],\"data\":[{item}]}}"), format!("{{\"data\":null,\"data\":[{item}]}}")] {
        let (out, changed) = run_stream("ws_1", "ses_1", raw.as_bytes(), 128);
        assert!(changed);
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        let uri = parsed["data"][0]["content"][0]["state"]["content"][0]["uri"].as_str().unwrap();
        assert!(uri.starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_dup/0/0/"), "{uri}");
    }
}

#[test]
fn projects_utf8_bom_json_and_strips_bom_on_invalid_tail() {
    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let valid = format!(
        "\u{FEFF}{}",
        json!({
            "data": [
                {"id": "msg_bom", "type": "assistant", "content": [{"type": "tool", "state": {"content": [{"type": "file", "mime": "image/png", "uri": large}]}}]}
            ]
        })
    );
    let (out, changed) = run_stream("ws_1", "ses_1", valid.as_bytes(), 2);
    assert!(changed);
    assert!(!out.starts_with(b"\xEF\xBB\xBF"));
    let parsed: Value = serde_json::from_slice(&out).unwrap();
    let uri = parsed["data"][0]["content"][0]["state"]["content"][0]["uri"].as_str().unwrap();
    assert!(uri.starts_with("/api/workspaces/ws_1/session-media/ses_1/msg_bom/0/0/"), "{uri}");

    let invalid = format!("{valid} garbage");
    let (out, changed) = run_stream("ws_1", "ses_1", invalid.as_bytes(), 2);
    assert!(changed);
    assert_eq!(out.as_ref(), &invalid.as_bytes()[3..]);
}

#[test]
fn rejects_invalid_utf8_in_json_strings_and_caps_nodes() {
    let large = format!("data:image/png;base64,{}", "A".repeat(40 * 1024));
    let prefix = format!(
        "{{\"data\":[{{\"id\":\"msg_u\",\"type\":\"assistant\",\"content\":[{{\"type\":\"tool\",\"state\":{{\"content\":[{{\"type\":\"file\",\"mime\":\"image/png\",\"uri\":\"{large}\"}}]}}}}]}}],\"bad\":\"",
    );
    let mut raw = prefix.into_bytes();
    raw.extend_from_slice(&[0xFF, 0xFE]);
    raw.extend_from_slice(b"\"}");
    let (out, changed) = run_stream("ws_1", "ses_1", &raw, 256);
    assert!(!changed);
    assert_eq!(out.as_ref(), raw.as_slice());

    assert!(json_node_count_within(br#"{"a":[1,2,3]}"#, 4));
    assert!(!json_node_count_within(br#"{"a":[1,2,3,4,5]}"#, 4));

    let dense_session = format!(
        "{{\"data\":{{\"id\":\"ses_1\",\"projectID\":\"p1\",\"location\":{{\"directory\":\"/tmp/a\",\"workspaceID\":null}},\"huge\":[{}]}}}}",
        vec!["0"; 50_000].join(",")
    );
    let extracted = extract_session_record(dense_session.as_bytes(), "ses_1", true).unwrap();
    assert_eq!(extracted["id"], "ses_1");
    assert_eq!(extracted["projectID"], "p1");
    assert_eq!(extracted["location"]["directory"], "/tmp/a");
    assert!(extracted["location"].get("workspaceID").is_some());

    assert!(parse_bounded_image_uri("\"not-an-image\\u0020payload\"", 64).is_none());
    let valid_uri = format!("\"data:image\\/png;base64,{}\"", "A".repeat(32));
    assert_eq!(
        parse_bounded_image_uri(&valid_uri, 64).as_deref(),
        Some(format!("data:image/png;base64,{}", "A".repeat(32)).as_str())
    );
    assert!(parse_bounded_image_uri(&valid_uri, 32).is_none());
}
