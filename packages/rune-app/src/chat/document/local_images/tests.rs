use super::*;
use crate::{Phase, history, init};
use rune::{Env, Runtime};
use serde_json::json;

const PNG_A: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";
const PNG_B: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=";

fn candidate(paths: &[&str], tag: &str) -> Candidate {
    Candidate {
        paths: paths.iter().map(|s| (*s).to_owned()).collect(),
        source: PictureSource::Inline(tag.into()),
        mime: "image/png".into(),
    }
}

#[test]
fn local_image_path_matches_solid_rules() {
    assert_eq!(
        local_image_path("C:/Users/me/image.png").as_deref(),
        Some("C:/Users/me/image.png")
    );
    assert_eq!(
        local_image_path(r"C:\Users\me\image.png").as_deref(),
        Some("C:/Users/me/image.png")
    );
    assert_eq!(
        local_image_path("file:///C:/Users/me/My%20image.png").as_deref(),
        Some("C:/Users/me/My image.png")
    );
    assert_eq!(
        local_image_path("file:///C:/Users/me/a%23b.png").as_deref(),
        Some("C:/Users/me/a#b.png")
    );
    assert_eq!(
        local_image_path("file://localhost/C:/x.png").as_deref(),
        Some("C:/x.png")
    );
    assert_eq!(
        local_image_path("file://server/share/x.png").as_deref(),
        Some("//server/share/x.png")
    );
    assert_eq!(
        local_image_path(r"\\server\share\x.png").as_deref(),
        Some("//server/share/x.png")
    );
    assert_eq!(
        local_image_path("file:///tmp/out.png").as_deref(),
        Some("/tmp/out.png")
    );
    assert_eq!(
        local_image_path("/tmp/opencode/images/x.png").as_deref(),
        Some("/tmp/opencode/images/x.png")
    );
    assert_eq!(
        local_image_path("./assets/logo.png").as_deref(),
        Some("./assets/logo.png")
    );
    assert_eq!(
        local_image_path("file:///C|/out.png").as_deref(),
        Some("C:/out.png")
    );
    assert_eq!(local_image_path("file://server:123/share/out.png"), None);
    assert_eq!(local_image_path("file:///tmp/a/../out.png"), None);
    for rejected in [
        "",
        "   ",
        "//cdn.example.com/a.png",
        "https://example.com/a.png",
        "HTTP://example.com/a.png",
        "data:image/png;base64,abc",
        "blob:https://example.com/123",
        "mailto:user@example.com",
        "#section",
        "javascript:alert(1)",
        "ftp://example.com/a.png",
    ] {
        assert_eq!(local_image_path(rejected), None, "{rejected}");
    }
    assert!(is_file_url("FILE:///tmp/a.png"));
    assert!(!is_file_url("C:/tmp/a.png"));
}

#[test]
fn match_local_image_handles_windows_case_relative_suffix_ambiguity_and_percent_decoding() {
    let items = vec![
        candidate(&[r"C:\Work\Out\Chart.PNG"], "newest-win"),
        candidate(&[r"C:\Work\Out\chart.png"], "older-win"),
        candidate(&[r"\\Server\Share\Spec.PNG"], "unc"),
        candidate(&["/tmp/a/dup.png"], "dup-a"),
        candidate(&["/tmp/b/dup.png"], "dup-b"),
        candidate(&["/tmp/only/Unique.png"], "posix"),
    ];
    // Windows case-insensitivity and newest-first precedence on re-read.
    assert_eq!(
        match_local_image(&items, "c:/work/out/chart.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("newest-win".into()))
    );
    // UNC case-insensitivity and relative suffix.
    assert_eq!(
        match_local_image(&items, "//server/share/spec.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("unc".into()))
    );
    assert_eq!(
        match_local_image(&items, "./out/chart.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("newest-win".into()))
    );
    // POSIX path stays case-sensitive.
    assert_eq!(
        match_local_image(&items, "/tmp/only/unique.png", true),
        None
    );
    assert_eq!(
        match_local_image(&items, "only/Unique.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("posix".into()))
    );
    // Ambiguous relative suffix returns None; explicit path still resolves.
    assert_eq!(match_local_image(&items, "dup.png", true), None);
    assert_eq!(match_local_image(&items, "./dup.png", true), None);
    assert_eq!(
        match_local_image(&items, "/tmp/a/dup.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("dup-a".into()))
    );
    // Parent traversal is never matched via exact or suffix matching.
    assert_eq!(match_local_image(&items, "../only/Unique.png", true), None);
    let traversal = vec![candidate(&["../x.png"], "bad")];
    assert_eq!(match_local_image(&traversal, "../x.png", true), None);

    // Ambiguity must stop matching and never fall through to percent-decoding.
    let ambiguous_encoded = vec![
        candidate(&["/a/x%20y.png"], "a"),
        candidate(&["/b/x%20y.png"], "b"),
        candidate(&["/c/x y.png"], "c"),
    ];
    assert_eq!(
        match_local_image(&ambiguous_encoded, "x%20y.png", true),
        None
    );

    // Plain paths try literal first, then percent-decoded fallback; file: URLs do not double-decode.
    let encoded = vec![
        candidate(&["C:/images/a b.png"], "space"),
        candidate(&["C:/images/a%20b.png"], "literal"),
    ];
    let plain = local_image_path("C:/images/a%20b.png").unwrap();
    assert_eq!(
        match_local_image(&encoded, &plain, true).map(|c| &c.source),
        Some(&PictureSource::Inline("literal".into()))
    );
    assert_eq!(
        match_local_image(&encoded[..1], &plain, true).map(|c| &c.source),
        Some(&PictureSource::Inline("space".into()))
    );
    let from_file_url = local_image_path("file:///C:/images/a%2520b.png").unwrap();
    assert_eq!(from_file_url, "C:/images/a%20b.png");
    assert_eq!(
        match_local_image(&encoded, &from_file_url, false).map(|c| &c.source),
        Some(&PictureSource::Inline("literal".into()))
    );
    assert_eq!(
        match_local_image(&encoded[..1], &from_file_url, false),
        None
    );
}

#[test]
fn session_candidates_only_reads_completed_tools_newest_first_and_scopes_input_path() {
    let older = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[
            {"id":"t1","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"C:/work/plot.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }},
            {"id":"t2","type":"tool","name":"read","state":{
                "status":"running",
                "input":{"filePath":"C:/work/running.png"},
                "content":[{"type":"file","name":"running.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}]
            }},
            {"id":"t3","type":"tool","name":"mcp","state":{
                "status":"completed",
                "input":{"path":"C:/work/shared.png"},
                "content":[
                    {"type":"file","name":"first.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")},
                    {"type":"file","name":"second.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}
                ]
            }}
        ]
    }))
    .unwrap();
    let newer = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[
            {"id":"t4","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"path":"C:/work/plot.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}]
            }}
        ]
    }))
    .unwrap();
    let candidates = session_candidates(&[older.into(), newer.into()]);
    // Latest completed tool wins for plot.png.
    assert_eq!(
        match_local_image(&candidates, "c:/work/plot.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline(PNG_B.into()))
    );
    // Running tool is ignored.
    assert_eq!(
        match_local_image(&candidates, "C:/work/running.png", true),
        None
    );
    // Multi-image tool does not bind input.path, only each image's own name.
    assert_eq!(
        match_local_image(&candidates, "C:/work/shared.png", true),
        None
    );
    assert_eq!(
        match_local_image(&candidates, "first.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline(PNG_A.into()))
    );
    assert_eq!(
        match_local_image(&candidates, "second.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline(PNG_B.into()))
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn prose_reuses_completed_tool_image_when_collapsed_and_keeps_alt_text_otherwise() {
    let tool_msg = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[
            {"id":"read-chart","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":r"C:\Work\Out\Chart.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }},
            {"id":"read-dup-a","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/a/dup.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }},
            {"id":"read-dup-b","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/b/dup.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}]
            }},
            {"id":"read-bad","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/bad.png"},
                "content":[{"type":"file","mime":"image/png","uri":"data:image/png;base64,PGh0bWw+"}]
            }}
        ]
    }))
    .unwrap();
    let prose_msg = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[{
            "type":"text",
            "text":"![Sales chart](c:/work/out/chart.png)\n\n![Missing diagram](missing.png)\n\n![Ambiguous icon](dup.png)\n\n![Broken tool image](/tmp/bad.png)"
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![tool_msg.into(), prose_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json().to_string();
        if tree.contains("\"role\":\"image\"") && tree.contains("Sales chart") {
            // Exactly one rendered image (the matched chart), even though the tool card is collapsed.
            assert_eq!(tree.matches("\"role\":\"image\"").count(), 1, "{tree}");
            // Unmatched, ambiguous, and unavailable tool images keep plain alt text without role="image".
            assert!(tree.contains("Missing diagram"), "{tree}");
            assert!(tree.contains("Ambiguous icon"), "{tree}");
            assert!(tree.contains("Broken tool image"), "{tree}");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{tree}");
        std::thread::yield_now();
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn memoized_large_prose_invalidates_when_matched_local_image_loads() {
    let tool_msg = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[{
            "id":"read-big","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/large/plot.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let padding = "x".repeat(crate::chat::document::TOOL_LIMIT + 512);
    let prose_msg = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[{
            "type":"text",
            "text":format!("![Memoized chart](plot.png)\n\n{padding}")
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![tool_msg.into(), prose_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json().to_string();
        if tree.contains("\"role\":\"image\"") && tree.contains("Memoized chart") {
            assert_eq!(tree.matches("\"role\":\"image\"").count(), 1, "{tree}");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{tree}");
        std::thread::yield_now();
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn empty_alt_loads_per_image_while_heading_and_offscreen_images_do_not_queue() {
    let tool_msg = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[
            {"id":"read-empty","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/empty-alt.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }},
            {"id":"read-head","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/head.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}]
            }},
            {"id":"read-far","type":"tool","name":"read","state":{
                "status":"completed",
                "input":{"filePath":"/tmp/far.png"},
                "content":[{"type":"file","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}]
            }}
        ]
    }))
    .unwrap();
    let empty_alt_msg = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[{"type":"text","text":"![](empty-alt.png)"}]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![tool_msg.clone().into(), empty_alt_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (800.0, 600.0),
        Env::new(false, 1.0),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
        let tree = rt.accessibility_json().to_string();
        if tree.contains("\"role\":\"image\"") {
            assert_eq!(tree.matches("\"role\":\"image\"").count(), 1, "{tree}");
            break;
        }
        assert!(std::time::Instant::now() < deadline, "{tree}");
        std::thread::yield_now();
    }

    let spacer = "line\n\n".repeat(120);
    let prose_msg = history::decode_message(&json!({
        "id":"m3","type":"assistant","time":{"completed":3},
        "content":[{"type":"text","text":format!("## ![Heading plot](head.png)\n\n{spacer}![Far plot](far.png)")}]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![tool_msg.into(), prose_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (800.0, 320.0),
        Env::new(false, 1.0),
    );
    for _ in 0..8 {
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Heading plot"), "{tree}");
    assert_eq!(tree.matches("\"role\":\"image\"").count(), 0, "{tree}");
    rt.update(|s, _| {
        assert!(
            s.transcript_display
                .pictures
                .local_slot(
                    "fragment-m3:0-local-image-0",
                    &PictureSource::Inline(PNG_B.into()),
                    "image/png",
                )
                .2
                .is_none(),
            "offscreen or non-liftable image should not be decoded"
        );
    });
}
