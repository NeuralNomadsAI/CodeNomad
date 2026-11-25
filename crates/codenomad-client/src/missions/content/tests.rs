use super::*;
use serde_json::json;

const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[test]
fn slice_validation_checks_utf16_lengths_offsets_and_selector_echo() {
    let selector = ContentSelector::task("task.1", "brief");
    // 😀 is 2 UTF-16 code units (4 UTF-8 bytes)
    let slice = ContentSlice {
        kind: "task".into(),
        field: "brief".into(),
        task_key: Some("task.1".into()),
        report_id: None,
        change: None,
        digest: DIGEST_A.into(),
        offset: 0,
        characters: 5,
        json: false,
        text: "a😀".into(),
        next: Some(3),
    };
    assert!(slice.valid(&selector, 0, None));
    assert!(slice.valid(&selector, 0, Some(DIGEST_A)));
    assert!(!slice.valid(&selector, 0, Some(DIGEST_B)));
    assert!(!slice.valid(&selector, 1, Some(DIGEST_A)));

    let final_slice = ContentSlice {
        offset: 3,
        text: "bc".into(),
        next: None,
        ..slice.clone()
    };
    assert!(final_slice.valid(&selector, 3, Some(DIGEST_A)));

    // Empty continuation slice must be rejected.
    let empty_next = ContentSlice {
        offset: 3,
        text: String::new(),
        next: Some(4),
        ..slice.clone()
    };
    assert!(!empty_next.valid(&selector, 3, Some(DIGEST_A)));

    // Mismatched task_key must be rejected.
    let wrong_key = ContentSlice {
        task_key: Some("other".into()),
        ..slice
    };
    assert!(!wrong_key.valid(&selector, 0, None));
}

#[test]
fn markdown_page_preserves_surrogate_pairs_and_fenced_blocks() {
    // Surrogate pair straddling a 3-unit page boundary: "ab😀cd" -> page 0 = "ab", page 1 = "😀cd"
    let text = "ab😀cd";
    let p0 = markdown_page(text, 0, 3).unwrap();
    let p1 = markdown_page(text, 1, 3).unwrap();
    assert_eq!(p0.source_text, "ab");
    assert_eq!(p1.source_text, "😀cd");
    assert_eq!(format!("{}{}", p0.source_text, p1.source_text), text);

    // Fenced code block spanning two pages receives synthetic continuation fences.
    let fenced = "```rust\nlet a = 1;\nlet b = 2;\n```\n";
    let first = markdown_page(fenced, 0, 19).unwrap();
    assert_eq!(first.source_text, "```rust\nlet a = 1;\n");
    assert_eq!(
        first.markdown_text.as_deref(),
        Some("```rust\nlet a = 1;\n```\n")
    );
    let second = markdown_page(fenced, 1, 19).unwrap();
    assert_eq!(second.source_text, "let b = 2;\n```\n");
    assert_eq!(
        second.markdown_text.as_deref(),
        Some("```rust\nlet b = 2;\n```\n")
    );

    // Cutting inside a fence opener falls back to literal source (`markdown_text: None`).
    let cut_opener = markdown_page("```rust\nbody\n```\n", 0, 4).unwrap();
    assert_eq!(cut_opener.source_text, "```r");
    assert!(cut_opener.markdown_text.is_none());
}

#[test]
fn body_covers_and_need_match_solid_utf16_semantics() {
    assert!(body_covers("hello", 5, 0, 10));
    assert!(!body_covers("hello world", 20, 0, 5));
    assert!(body_covers("hello\nworld", 20, 0, 5));
    assert_eq!(body_need(None, 20, false, 0, 5), 6);
    assert_eq!(body_need(Some(8), 20, false, 0, 5), 9);
    assert_eq!(body_need(Some(11), 20, true, 0, 5), 11);
}

#[test]
fn mission_content_fetches_slice_refusal_and_auth_expired() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let replies = [
                (
                    200,
                    json!({
                        "available": true,
                        "version": 1,
                        "projectID": "prj_1",
                        "missionID": "msn_1",
                        "revision": 4,
                        "content": {
                            "kind": "mission",
                            "field": "objective",
                            "digest": DIGEST_A,
                            "offset": 0,
                            "characters": 11,
                            "text": "Hello world"
                        }
                    })
                    .to_string(),
                ),
                (
                    200,
                    json!({
                        "available": true,
                        "version": 1,
                        "projectID": "prj_1",
                        "missionID": "msn_1",
                        "revision": 5,
                        "refused": "content-changed"
                    })
                    .to_string(),
                ),
                (401, json!({"error": "unauthorized"}).to_string()),
            ];
            let mut seen_paths = Vec::new();
            for (status, body) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("").to_owned();
                seen_paths.push(first_line);
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(resp.as_bytes()).await.unwrap();
            }
            seen_paths
        });

        let mut backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
        backend.workspace = "ws_1".into();
        let sel = ContentSelector::mission("objective");

        let ok = backend
            .mission_content("prj_1", "msn_1", &sel, 0, None)
            .await
            .unwrap();
        assert_eq!(
            ok,
            ContentOutcome::Slice {
                revision: 4,
                slice: ContentSlice {
                    kind: "mission".into(),
                    field: "objective".into(),
                    task_key: None,
                    report_id: None,
                    change: None,
                    digest: DIGEST_A.into(),
                    offset: 0,
                    characters: 11,
                    json: false,
                    text: "Hello world".into(),
                    next: None,
                }
            }
        );

        let refused = backend
            .mission_content("prj_1", "msn_1", &sel, 5, Some(DIGEST_A))
            .await
            .unwrap();
        assert_eq!(
            refused,
            ContentOutcome::Refused {
                revision: Some(5),
                refusal: ContentRefusal::ContentChanged,
            }
        );

        let auth = backend
            .mission_content("prj_1", "msn_1", &sel, 0, None)
            .await
            .unwrap();
        assert_eq!(auth, ContentOutcome::AuthExpired);

        let seen = server.await.unwrap();
        assert!(seen[0].starts_with(
            "GET /api/workspaces/ws_1/missions/msn_1/content?kind=mission&field=objective&offset=0 "
        ));
        assert!(seen[1].contains(&format!("offset=5&digest={DIGEST_A}")));
    });
}
