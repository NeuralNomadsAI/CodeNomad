use super::*;
use crate::{Phase, history, init};
use rune::{Env, Runtime};
use serde_json::json;

const PNG_A: &str = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";
const PNG_B: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=";

fn candidate(paths: &[&str], tag: &str) -> Candidate {
    Candidate {
        paths: paths.iter().filter_map(|s| KnownPath::new(s)).collect(),
        source: PictureSource::Inline(tag.into()),
        mime: "image/png".into(),
        call: None,
        origin: 0,
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
    assert_eq!(
        local_image_path("file:///A:chart.png").as_deref(),
        Some("/A:chart.png")
    );
    assert_eq!(local_image_path("file://server:123/share/out.png"), None);
    assert_eq!(local_image_path("file:///tmp/a/../out.png"), None);
    assert_eq!(local_image_path("file:///tmp/%2e%2e/out%ZZ.png"), None);
    assert_eq!(local_image_path("file:///tmp/.%2E/out.png"), None);
    assert_eq!(local_image_path("file:///tmp/%2e\t%2e/out.png"), None);
    assert_eq!(local_image_path("file:///tmp/..\n/out.png"), None);
    assert_eq!(
        local_image_path("file:///tmp/chart.png/sub/..\u{0001}"),
        None
    );
    assert_eq!(
        local_image_path("\u{0001}file:///tmp/chart.png/sub/.."),
        None
    );
    assert_eq!(
        local_image_path("fi\tle:///tmp/chart.png").as_deref(),
        Some("/tmp/chart.png")
    );
    assert!(is_file_url("fi\tle:///tmp/chart.png"));
    assert_eq!(local_image_path("fi\tle:///tmp/a/../chart.png"), None);
    assert_eq!(local_image_path("ft\tp:chart.png"), None);
    assert_eq!(
        local_image_path("/tmp/chart.png\u{00A0}").as_deref(),
        Some("/tmp/chart.png\u{00A0}")
    );
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
    // POSIX path stays case-sensitive and preserves literal backslashes.
    assert_eq!(
        match_local_image(&items, "/tmp/only/unique.png", true),
        None
    );
    assert_eq!(
        match_local_image(&items, "only/Unique.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("posix".into()))
    );
    let posix_backslash = vec![
        candidate(&[r"a\b.png", r"/tmp/a\b.png"], "literal-backslash"),
        candidate(&["/tmp/a/b.png"], "nested-slash"),
    ];
    assert_eq!(
        match_local_image(&posix_backslash, "/tmp/a/b.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("nested-slash".into()))
    );
    assert_eq!(
        match_local_image(&posix_backslash, r"/tmp/a\b.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("literal-backslash".into()))
    );
    assert_eq!(
        match_local_image(&posix_backslash, "a/b.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("nested-slash".into()))
    );
    assert_eq!(
        match_local_image(&posix_backslash, "./a%5Cb.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("literal-backslash".into()))
    );
    let only_nested_slash = vec![candidate(&["/tmp/a/b.png"], "nested-slash")];
    assert_eq!(
        match_local_image(&only_nested_slash, "./a%5Cb.png", true),
        None
    );
    // Relative Windows paths with backslashes still match Windows candidates, while parent
    // traversal with backslashes is rejected.
    let win_rel = vec![candidate(&[r"C:\Work\Sub\Spec.PNG"], "win-spec")];
    assert_eq!(
        match_local_image(&win_rel, r".\sub\spec.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("win-spec".into()))
    );
    assert_eq!(match_local_image(&win_rel, r"..\Spec.PNG", true), None);
    assert_eq!(match_local_image(&win_rel, r"\Sub\Spec.PNG", true), None);
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

    // Distinct full paths that also expose the same short attachment name must stay ambiguous
    // for the short name while resolving cleanly for an unambiguous suffix or exact path.
    let shared_short_name = vec![
        candidate(&["chart.png", "/b/chart.png"], "b-newest"),
        candidate(&["chart.png", "/a/chart.png"], "a-older"),
    ];
    assert_eq!(
        match_local_image(&shared_short_name, "chart.png", true),
        None
    );
    assert_eq!(
        match_local_image(&shared_short_name, "./chart.png", true),
        None
    );
    assert_eq!(
        match_local_image(&shared_short_name, "a/chart.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("a-older".into()))
    );
    assert_eq!(
        match_local_image(&shared_short_name, "/b/chart.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("b-newest".into()))
    );

    // Re-reading the same path with its short name resolves to the newest candidate, including
    // redundant `.` segments such as `/tmp/./chart.png` vs `/tmp/chart.png`.
    let reread_same_path = vec![
        candidate(&["chart.png", r"C:\Work\A\Chart.PNG"], "win-new"),
        candidate(&["chart.png", r"C:\Work\.\A\chart.png"], "win-old"),
    ];
    assert_eq!(
        match_local_image(&reread_same_path, "chart.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("win-new".into()))
    );
    let posix_dot_reread = vec![
        candidate(&["chart.png", "/tmp/./chart.png"], "posix-new"),
        candidate(&["chart.png", "/tmp/chart.png"], "posix-old"),
    ];
    assert_eq!(
        match_local_image(&posix_dot_reread, "chart.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline("posix-new".into()))
    );

    // A newer unavailable read (e.g. over media budget) must shadow older pixels of the same file
    // and still participate in ambiguity checks for shared suffixes.
    let shadowed_by_unavailable = vec![
        Candidate {
            paths: vec![KnownPath::new("/tmp/chart.png").unwrap()],
            source: PictureSource::Unavailable,
            mime: "image/png".into(),
            call: Some(2),
            origin: 2,
        },
        candidate(&["/tmp/chart.png"], "stale-old"),
    ];
    assert_eq!(
        match_local_image(&shadowed_by_unavailable, "/tmp/chart.png", true),
        None
    );
    assert_eq!(
        match_local_image(&shadowed_by_unavailable, "chart.png", true),
        None
    );
    let ambiguous_with_unavailable = vec![
        Candidate {
            paths: vec![KnownPath::new("/b/chart.png").unwrap()],
            source: PictureSource::Unavailable,
            mime: "image/png".into(),
            call: Some(2),
            origin: 2,
        },
        candidate(&["/a/chart.png"], "other-file"),
    ];
    assert_eq!(
        match_local_image(&ambiguous_with_unavailable, "chart.png", true),
        None
    );

    // Two distinct tool calls each returning an unqualified short name (`chart.png`, no full path)
    // cannot prove they refer to the same file and must stay ambiguous.
    let unqualified_two_calls = vec![
        Candidate {
            paths: vec![KnownPath::new("chart.png").unwrap()],
            source: PictureSource::Inline("call-2".into()),
            mime: "image/png".into(),
            call: Some(2),
            origin: 2,
        },
        Candidate {
            paths: vec![KnownPath::new("chart.png").unwrap()],
            source: PictureSource::Inline("call-1".into()),
            mime: "image/png".into(),
            call: Some(1),
            origin: 1,
        },
    ];
    assert_eq!(
        match_local_image(&unqualified_two_calls, "chart.png", true),
        None
    );
    assert_eq!(filename_label_for(r"./out\chart.png", true), "chart.png");
    assert_eq!(
        filename_label_for(r"./out\chart.png", false),
        r"out\chart.png"
    );
    assert_eq!(filename_label_for(r"/tmp/a\b.png", true), r"a\b.png");

    // Two distinct images with the same name returned by a single tool call must be ambiguous,
    // even when an older tool call returned a single image with that name.
    let older_single = history::decode_message(&json!({
        "id":"m-single","type":"assistant","time":{"completed":1},
        "content":[{
            "type":"tool","id":"call-single","name":"mcp",
            "state":{
                "status":"completed",
                "content":[{"type":"file","name":"chart.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let same_call_dups = history::decode_message(&json!({
        "id":"m-dups","type":"assistant","time":{"completed":2},
        "content":[{
            "type":"tool","id":"call-dups","name":"mcp",
            "state":{
                "status":"completed",
                "content":[
                    {"type":"file","name":"chart.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")},
                    {"type":"file","name":"chart.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")},
                    {"type":"file","name":"/tmp/same-abs.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")},
                    {"type":"file","name":"/tmp/same-abs.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}
                ]
            }
        }]
    }))
    .unwrap();
    let dup_candidates = session_candidates(&[older_single.into(), same_call_dups.into()]);
    assert_eq!(match_local_image(&dup_candidates, "chart.png", true), None);
    assert_eq!(
        match_local_image(&dup_candidates, "/tmp/same-abs.png", true),
        None
    );

    // A lifted remote image in a task prompt stays visible for hidden-input probing
    // (`bounded_prose_matches_for`) without claiming the active highlight away from subsequent
    // paintable prose (`bounded_prose_highlights_for`).
    let s = init();
    let terms = vec!["Plan".into()];
    let query = rune_theme_codenomad::timeline::search::Query {
        terms: &terms,
        ranked: false,
        active: true,
        claimed: None,
    };
    assert!(super::super::bounded_prose_matches_for(
        &s,
        "task-card",
        "task-card-task-prompt",
        "![Plan](https://example.test/plan.png)",
        4096,
        Conversation::Root,
        query,
    ));
    assert!(!super::super::bounded_prose_highlights_for(
        &s,
        "task-card",
        "task-card-task-prompt",
        "![Plan](https://example.test/plan.png)",
        4096,
        Conversation::Root,
        query,
    ));
    assert!(super::super::bounded_prose_highlights_for(
        &s,
        "task-card",
        "task-card-task-output",
        "Plan",
        4096,
        Conversation::None,
        query,
    ));
    let win_shared_short = vec![
        candidate(&["Chart.PNG", r"C:\Work\B\Chart.PNG"], "win-b"),
        candidate(&["chart.png", r"C:\Work\A\chart.png"], "win-a"),
    ];
    assert_eq!(
        match_local_image(&win_shared_short, "chart.png", true),
        None
    );
    assert_eq!(
        match_local_image(&win_shared_short, "Chart.PNG", true),
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
            !matches!(
                s.transcript_display
                    .pictures
                    .local_slot(
                        "fragment-m3:0-local-image-0",
                        &PictureSource::Inline(PNG_B.into()),
                        "image/png",
                    )
                    .3,
                LocalImageState::Ready(_)
            ),
            "offscreen or non-liftable image should not be decoded"
        );
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn replacing_failed_local_image_while_visible_recovers_in_short_and_memoized_prose() {
    // Valid PNG magic + 1x1 IHDR so `PictureSource::inline` admits it, followed by truncated IDAT
    // so decoding settles to `LocalImageState::Failed`.
    const CORRUPT_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8";
    for long_prose in [false, true] {
        let padding = if long_prose {
            format!("{}\n\n", "padding text ".repeat(900))
        } else {
            String::new()
        };
        let prose_text = format!("{padding}![Corrupt `inner` chart](/tmp/out.png)");
        let bad_tool = history::decode_message(&json!({
            "id":"m1","type":"assistant","time":{"completed":1},
            "content":[{
                "type":"tool","id":"call-bad","name":"read",
                "state":{
                    "status":"completed",
                    "input":{"filePath":"/tmp/out.png"},
                    "content":[{"type":"file","filename":"/tmp/out.png","mime":"image/png","uri":format!("data:image/png;base64,{CORRUPT_PNG}")}]
                }
            }]
        }))
        .unwrap();
        let prose_msg = history::decode_message(&json!({
            "id":"m2","type":"assistant","time":{"completed":2},
            "content":[{"type":"text","text":prose_text}]
        }))
        .unwrap();
        let mut state = init();
        state.phase = Phase::Ready;
        state.messages = vec![bad_tool.into(), prose_msg.into()];
        let mut rt = Runtime::new(
            state,
            |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
            (800.0, 500.0),
            Env::new(false, 1.0),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            rt.update(|s, tx| {
                if crate::chat::events::poll_chat(s, 4) {
                    tx.instant();
                }
            });
            rt.frame(1.0 / 60.0);
            let mut failed = false;
            rt.update(|s, _| {
                failed = matches!(
                    s.transcript_display
                        .pictures
                        .local_slot(
                            "fragment-m2:0-local-image-0",
                            &PictureSource::Inline(CORRUPT_PNG.into()),
                            "image/png",
                        )
                        .3,
                    LocalImageState::Failed
                );
            });
            if failed {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "failed image did not settle (long={long_prose})"
            );
            std::thread::yield_now();
        }
        // Extra frames must keep the failed lease settled without re-queuing.
        for _ in 0..4 {
            rt.update(|s, tx| {
                if crate::chat::events::poll_chat(s, 4) {
                    tx.instant();
                }
            });
            rt.frame(1.0 / 60.0);
        }
        rt.update(|s, _| {
            assert!(
                matches!(
                    s.transcript_display
                        .pictures
                        .local_slot(
                            "fragment-m2:0-local-image-0",
                            &PictureSource::Inline(CORRUPT_PNG.into()),
                            "image/png",
                        )
                        .3,
                    LocalImageState::Failed
                ),
                "retained failure lease must keep entry settled (long={long_prose})"
            );
        });
        // Failed matched image must fall back to searchable plain text, not an image block,
        // and paint `history-search-match` even when alt text contains inline code.
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("Corrupt inner chart"), "{tree}");
        assert_eq!(tree.matches("\"role\":\"image\"").count(), 0, "{tree}");
        rt.update(|s, tx| {
            let terms = vec!["Corrupt inner".into()];
            let query = rune_theme_codenomad::timeline::search::Query {
                terms: &terms,
                ranked: false,
                active: true,
                claimed: None,
            };
            assert!(
                super::super::bounded_prose_matches(
                    s,
                    "fragment-m2:0",
                    &prose_text,
                    super::super::PROSE_LIMIT,
                    Conversation::Root,
                    query,
                ),
                "settled failed fallback text must match prose search (long={long_prose})"
            );
            let hit = codenomad_client::search::Hit {
                session: "s".into(),
                message: "m2".into(),
                role: "assistant".into(),
                part: 0,
                kind: codenomad_client::search::Kind::Text,
                excerpt: String::new(),
            };
            s.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
                &hit,
                "Corrupt inner",
                false,
            ));
            tx.instant();
        });
        rt.frame(1.0 / 60.0);
        assert!(
            rt.find("history-search-match").is_some(),
            "settled failed fallback with inline code must paint history-search-match (long={long_prose})"
        );
        rt.update(|s, tx| {
            s.transcript_display.search_highlight = None;
            tx.instant();
        });

        // Replace the failed image with a valid later completed tool at the same path while visible.
        let good_tool = history::decode_message(&json!({
            "id":"m3","type":"assistant","time":{"completed":3},
            "content":[{
                "type":"tool","id":"call-good","name":"read",
                "state":{
                    "status":"completed",
                    "input":{"filePath":"/tmp/out.png"},
                    "content":[{"type":"file","filename":"/tmp/out.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
                }
            }]
        }))
        .unwrap();
        rt.update(|s, tx| {
            s.messages.push(good_tool.into());
            tx.instant();
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            rt.update(|s, tx| {
                if crate::chat::events::poll_chat(s, 4) {
                    tx.instant();
                }
            });
            rt.frame(1.0 / 60.0);
            let tree = rt.accessibility_json().to_string();
            if tree.matches("\"role\":\"image\"").count() == 1 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "replacement image stayed stuck on alt text (long={long_prose}): {tree}"
            );
            std::thread::yield_now();
        }
    }
}

#[test]
fn nested_child_prose_isolates_from_parent_and_uses_verified_child_tools() {
    let parent_tool = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[{
            "type":"tool","id":"call-p","name":"read",
            "state":{
                "status":"completed",
                "input":{"filePath":"/tmp/parent.png"},
                "content":[{"type":"file","filename":"/tmp/parent.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let child_page = history::decode(json!({
        "status":"window","latest":true,
        "messages": [{
            "id":"cm1","type":"assistant","time":{"completed":2},
            "content":[{
                "type":"tool","id":"call-c","name":"read",
                "state":{
                    "status":"completed",
                    "input":{"filePath":"/tmp/child.png"},
                    "content":[{"type":"file","filename":"/tmp/child.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}]
                }
            }]
        }]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![parent_tool.into()];
    let _lease = state.transcript_display.children.install("c1", child_page);
    assert!(state.transcript_display.children.poll());

    let source = "![Parent](/tmp/parent.png)\n\n![Child](/tmp/child.png)";
    let child_plan = prepare(
        &state,
        "child-doc",
        source,
        false,
        Conversation::Child {
            parent: None,
            id: "c1",
        },
    );
    let child_fb = child_plan.fallback_label();
    assert_eq!(
        child_fb("/tmp/parent.png", true).as_deref(),
        Some("parent.png")
    );
    assert_eq!(child_fb("/tmp/child.png", true), None);

    let none_plan = prepare(&state, "none-doc", source, false, Conversation::None);
    let none_fb = none_plan.fallback_label();
    assert_eq!(
        none_fb("/tmp/parent.png", true).as_deref(),
        Some("parent.png")
    );
    assert_eq!(
        none_fb("/tmp/child.png", true).as_deref(),
        Some("child.png")
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn url_shaped_alt_text_on_fallback_renders_without_link_and_matches_search() {
    let prose_msg = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[{"type":"text","text":"See ![https://example.test/secret.png](missing.png) and ![](empty-name.png)"}]
    }))
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![prose_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (800.0, 400.0),
        Env::new(false, 1.0),
    );
    rt.frame(1.0 / 60.0);
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("https://example.test/secret.png"), "{tree}");
    assert!(tree.contains("empty-name.png"), "{tree}");
    assert_eq!(tree.matches("\"role\":\"link\"").count(), 0, "{tree}");
    assert_eq!(tree.matches("\"role\":\"image\"").count(), 0, "{tree}");
    rt.update(|s, _| {
        let terms = vec!["empty-name.png".into()];
        let query = rune_theme_codenomad::timeline::search::Query {
            terms: &terms,
            ranked: false,
            active: true,
            claimed: None,
        };
        assert!(super::super::bounded_prose_matches(
            s,
            "fragment-m1:0",
            "See ![https://example.test/secret.png](missing.png) and ![](empty-name.png)",
            super::super::PROSE_LIMIT,
            Conversation::Root,
            query,
        ));
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn offscreen_failed_image_is_not_requeued_on_reconnect_while_other_prose_stays_visible() {
    let tool_msg = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[{
            "type":"tool","id":"call-http","name":"read",
            "state":{
                "status":"completed",
                "input":{"filePath":"/tmp/net.png"},
                "content":[{"type":"file","filename":"/tmp/net.png","mime":"image/png","uri":"https://127.0.0.1:1/net.png"}]
            }
        }]
    }))
    .unwrap();
    let short_prose = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[{"type":"text","text":"![Offscreen failed](/tmp/net.png)"}]
    }))
    .unwrap();
    let source = PictureSource::Http("https://127.0.0.1:1/net.png".into());
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages = vec![tool_msg.into(), short_prose.into()];
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (800.0, 320.0),
        Env::new(false, 1.0),
    );
    // Let the visible HTTP image fail and settle first.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
        let mut failed = false;
        let origin = Some(candidate_origin("m1", "call-http", 0));
        rt.update(|s, _| {
            failed = matches!(
                s.transcript_display
                    .pictures
                    .local_slot_for("fragment-m2:0-local-image-0", &source, "image/png", origin)
                    .3,
                LocalImageState::Failed
            );
        });
        if failed {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "http failure did not settle"
        );
        std::thread::yield_now();
    }
    // Grow the message tail so the failed image moves offscreen while the rest of the message
    // remains visible in the stick-bottom viewport.
    let spacer = "visible tail line\n\n".repeat(120);
    let tall_prose = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[{"type":"text","text":format!("![Offscreen failed](/tmp/net.png)\n\n{spacer}")}]
    }))
    .unwrap();
    rt.update(|s, tx| {
        s.messages[1] = tall_prose.into();
        tx.instant();
    });
    for _ in 0..4 {
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
        });
        rt.frame(1.0 / 60.0);
    }
    // Reconnect while the failed image is offscreen and the tail of m2 is visible:
    // the offscreen failed image must NOT be re-queued.
    rt.update(|s, _| {
        let bounds = s.tool_diff_preferences.history_bounds.get();
        let origin = Some(candidate_origin("m1", "call-http", 0));
        s.transcript_display
            .pictures
            .retry_interrupted_in_view(&s.transcript_display.tool_clock, bounds);
        assert!(
            !s.transcript_display.pictures.local_visible_or_queued_for(
                "fragment-m2:0-local-image-0",
                &source,
                "image/png",
                origin,
                &s.transcript_display.tool_clock,
                bounds,
            ),
            "offscreen failed image must stay unqueued across reconnect while tail prose is visible"
        );
    });
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn clipped_tool_pane_keeps_failed_image_unqueued_across_reconnect() {
    fn view_short(s: &State, _: &mut rune::Cx<State>) -> rune::El {
        let filler = "pane line\n\n".repeat(40);
        crate::strings::with_locale("en", || {
            super::super::clipped_tool_pane(s, "skill-pane-clip", false, || {
                super::super::prose_search(
                    s,
                    "m1",
                    "skill-card",
                    "skill-doc".into(),
                    &format!("{filler}![Clipped image](/tmp/pane.png)"),
                    Conversation::Root,
                    None,
                )
            })
        })
    }
    fn view_memoized(s: &State, _: &mut rune::Cx<State>) -> rune::El {
        let filler = format!("{}\n\n", "pane memoized line ".repeat(600));
        crate::strings::with_locale("en", || {
            super::super::clipped_tool_pane(s, "skill-pane-clip", false, || {
                super::super::prose_search(
                    s,
                    "m1",
                    "skill-card",
                    "skill-doc".into(),
                    &format!("{filler}![Clipped image](/tmp/pane.png)"),
                    Conversation::Root,
                    None,
                )
            })
        })
    }
    let source = PictureSource::Http("https://127.0.0.1:1/pane.png".into());
    for (label, view_fn) in [
        (
            "short",
            view_short as fn(&State, &mut rune::Cx<State>) -> rune::El,
        ),
        (
            "memoized",
            view_memoized as fn(&State, &mut rune::Cx<State>) -> rune::El,
        ),
    ] {
        let tool_msg = history::decode_message(&json!({
            "id":"m1","type":"assistant","time":{"completed":1},
            "content":[{
                "type":"tool","id":"call-http","name":"read",
                "state":{
                    "status":"completed",
                    "input":{"filePath":"/tmp/pane.png"},
                    "content":[{"type":"file","filename":"/tmp/pane.png","mime":"image/png","uri":"https://127.0.0.1:1/pane.png"}]
                }
            }]
        }))
        .unwrap();
        let mut state = init();
        state.phase = Phase::Ready;
        state.messages = vec![tool_msg.into()];
        let mut rt = Runtime::new(state, view_fn, (800.0, 900.0), Env::new(false, 1.0));
        for _ in 0..5 {
            rt.update(|s, tx| {
                if crate::chat::events::poll_chat(s, 4) {
                    tx.instant();
                }
            });
            rt.frame(1.0 / 60.0);
        }
        let origin = Some(candidate_origin("m1", "call-http", 0));
        // Initially inside the 900px window but clipped below the 15-line pane -> must not queue.
        rt.update(|s, _| {
            let bounds = s.tool_diff_preferences.history_bounds.get();
            assert!(
                !s.transcript_display.pictures.local_visible_or_queued_for(
                    "skill-doc-local-image-0",
                    &source,
                    "image/png",
                    origin,
                    &s.transcript_display.tool_clock,
                    bounds,
                ),
                "{label}: clipped image below pane must stay unqueued initially"
            );
        });
        // Scroll the pane down so the image enters the pane, loads, and settles to Failed.
        for _ in 0..8 {
            rt.wheel(200.0, 80.0, -4000.0);
            rt.frame(1.0 / 60.0);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            rt.update(|s, tx| {
                if crate::chat::events::poll_chat(s, 4) {
                    tx.instant();
                }
            });
            rt.frame(1.0 / 60.0);
            let mut failed = false;
            rt.update(|s, _| {
                failed = matches!(
                    s.transcript_display
                        .pictures
                        .local_slot_for("skill-doc-local-image-0", &source, "image/png", origin)
                        .3,
                    LocalImageState::Failed
                );
            });
            if failed {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{label}: scrolled-in pane image did not settle to Failed"
            );
            std::thread::yield_now();
        }
        // Verify preserved DrawnRect + glide/clip-only geometry checks:
        // 1. Scroll the pane back to the top (mid-glide, single frame) and reconnect immediately:
        //    live geometry must refuse retry while the failed image is behind the pane clip edge.
        for _ in 0..8 {
            rt.wheel(200.0, 80.0, 4000.0);
        }
        rt.frame(1.0 / 60.0);
        rt.update(|s, _| {
            let bounds = s.tool_diff_preferences.history_bounds.get();
            s.transcript_display
                .pictures
                .retry_interrupted_in_view(&s.transcript_display.tool_clock, bounds);
            assert!(
                !s.transcript_display.pictures.local_visible_or_queued_for(
                    "skill-doc-local-image-0",
                    &source,
                    "image/png",
                    origin,
                    &s.transcript_display.tool_clock,
                    bounds,
                ),
                "{label}: failed image scrolled behind pane clip must stay unqueued across reconnect"
            );
        });
        // 2. Clip-only resize expanding the pane rect to intersect the image (even if cached
        //    on_visible is false) must make the pending entry eligible on poll_in_view without
        //    needing a fresh on_visible(true) callback.
        rt.update(|s, _| {
            let bounds = s.tool_diff_preferences.history_bounds.get();
            let (_, _, drawn, _) = s.transcript_display.pictures.local_slot_for(
                "skill-doc-local-image-0",
                &source,
                "image/png",
                origin,
            );
            let rect = drawn.get();
            assert!(
                rect[2] > 0.0 && rect[3] > 0.0,
                "{label}: preserved local_slot DrawnRect must stay bound to live layout"
            );
            let pane_clip = s.transcript_display.tool_clock.clip_rect("skill-pane-clip");
            pane_clip.set([0.0, 0.0, 800.0, rect[1] + rect[3] + 4.0]);
            assert!(
                s.transcript_display.pictures.local_visible_or_queued_for(
                    "skill-doc-local-image-0",
                    &source,
                    "image/png",
                    origin,
                    &s.transcript_display.tool_clock,
                    bounds,
                ),
                "{label}: clip-only resize intersecting the image must admit it via live geometry"
            );
        });
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn nested_images_flatten_local_and_remote_inner_destinations() {
    let nested_tool = history::decode_message(&json!({
        "id":"m3","type":"assistant","time":{"completed":3},
        "content":[{
            "type":"tool","id":"call-nested","name":"read",
            "state":{
                "status":"completed",
                "input":{"filePath":"/tmp/nested.png"},
                "content":[{"type":"file","filename":"/tmp/nested.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    for text in [
        "![before ![inner](/tmp/nested.png) after](/tmp/nested.png)",
        "![before ![inner](https://example.test/i.png) after](/tmp/nested.png)",
    ] {
        let nested_prose = history::decode_message(&json!({
            "id":"m4","type":"assistant","time":{"completed":4},
            "content":[{"type":"text","text":text}]
        }))
        .unwrap();
        let mut nested_state = init();
        nested_state.phase = Phase::Ready;
        nested_state.messages = vec![nested_tool.clone().into(), nested_prose.into()];
        let mut nested_rt = Runtime::new(
            nested_state,
            |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
            (800.0, 400.0),
            Env::new(false, 1.0),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            nested_rt.update(|s, tx| {
                if crate::chat::events::poll_chat(s, 4) {
                    tx.instant();
                }
            });
            nested_rt.frame(1.0 / 60.0);
            let tree = nested_rt.accessibility_json().to_string();
            if tree.matches("\"role\":\"image\"").count() == 1 {
                assert!(tree.contains("before inner after"), "{text}: {tree}");
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{text}: {tree}");
            std::thread::yield_now();
        }
    }
}

#[test]
fn reverted_root_messages_and_truncated_child_rereads_do_not_expose_stale_pixels() {
    // 1. Root conversation hides tool images from messages at or after the active revert boundary.
    let kept = history::decode_message(&json!({
        "id":"m1","type":"assistant","time":{"completed":1},
        "content":[{"type":"text","text":"![Chart](/tmp/reverted.png)"}]
    }))
    .unwrap();
    let reverted_tool = history::decode_message(&json!({
        "id":"m2","type":"assistant","time":{"completed":2},
        "content":[{
            "type":"tool","id":"call-rev","name":"read",
            "state":{
                "status":"completed",
                "input":{"filePath":"/tmp/reverted.png"},
                "content":[{"type":"file","name":"reverted.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let mut s = init();
    s.messages = vec![kept.into(), reverted_tool.into()];
    s.transcript_display
        .messages
        .fixture_set_boundary(Some("m2"));
    let plan = prepare(
        &s,
        "m1-prose",
        "![Chart](/tmp/reverted.png)",
        false,
        Conversation::Root,
    );
    let fallback = plan.fallback_label();
    assert_eq!(
        fallback("/tmp/reverted.png", true).as_deref(),
        Some("reverted.png"),
        "reverted tool image must not resolve for visible prose"
    );

    // 2. Child task snapshot truncation of a newer reread shadows an older kept read of the same path.
    let older_read = history::decode_message(&json!({
        "id":"c1","type":"assistant","time":{"completed":1},
        "content":[{
            "type":"tool","id":"call-old","name":"read",
            "state":{
                "status":"completed",
                "input":{"filePath":"/tmp/child-chart.png"},
                "content":[{"type":"file","name":"child-chart.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let filler = |id: &str, call: &str, t: u64| {
        history::decode_message(&json!({
            "id":id,"type":"assistant","time":{"completed":t},
            "content":[{
                "type":"tool","id":call,"name":"bash",
                "state":{
                    "status":"completed",
                    "content":[{"type":"text","text":"x".repeat(600_000)}]
                }
            }]
        }))
        .unwrap()
    };
    let newer_truncated = history::decode_message(&json!({
        "id":"c5","type":"assistant","time":{"completed":5},
        "content":[{
            "type":"tool","id":"call-new","name":"read",
            "state":{
                "status":"completed",
                "input":{"filePath":"/tmp/child-chart.png"},
                "content":[
                    {"type":"text","text":"y".repeat(600_000)},
                    {"type":"file","name":"child-chart.png","mime":"image/png","uri":format!("data:image/png;base64,{PNG_B}")}
                ]
            }
        }]
    }))
    .unwrap();

    // Control: without the newer truncated reread, the older read resolves cleanly.
    let mut intact_state = init();
    let _intact_lease = intact_state.transcript_display.children.install(
        "child-intact",
        history::Page {
            rows: vec![older_read.clone().into()],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
    );
    assert!(intact_state.transcript_display.children.poll());
    let intact_plan = prepare(
        &intact_state,
        "task-out-intact",
        "![Chart](/tmp/child-chart.png)",
        false,
        Conversation::Child {
            parent: None,
            id: "child-intact",
        },
    );
    assert_eq!(
        intact_plan.fallback_label()("/tmp/child-chart.png", true),
        None
    );

    // With total tool bytes > STEP_BYTES (2 MiB), water-filling keeps `call-old` intact while
    // truncating `call-new` and recording its path shadow.
    let mut child_state = init();
    let _lease = child_state.transcript_display.children.install(
        "child-trunc",
        history::Page {
            rows: vec![
                older_read.into(),
                filler("c2", "call-f2", 2).into(),
                filler("c3", "call-f3", 3).into(),
                filler("c4", "call-f4", 4).into(),
                newer_truncated.into(),
            ],
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
    );
    assert!(child_state.transcript_display.children.poll());
    let tool_state = child_state
        .transcript_display
        .children
        .verified_tool_state(None, "child-trunc");
    assert_eq!(tool_state.steps.len(), 5);
    assert!(tool_state.dropped_images.is_empty());
    assert!(
        !tool_state.steps[0].1.pictures.is_empty(),
        "older small read must stay intact under water-filling"
    );
    assert!(
        tool_state.steps[4].1.pictures.is_empty(),
        "oversized newer reread must have its pictures truncated"
    );
    assert!(
        tool_state
            .truncated_images
            .iter()
            .any(|(m, t, _)| m.as_ref() == "c5" && t.as_ref() == "call-new"),
        "truncated newer reread must record its image path shadow"
    );
    let child_plan = prepare(
        &child_state,
        "task-out",
        "![Chart](/tmp/child-chart.png)",
        false,
        Conversation::Child {
            parent: None,
            id: "child-trunc",
        },
    );
    let child_fallback = child_plan.fallback_label();
    assert_eq!(
        child_fallback("/tmp/child-chart.png", true).as_deref(),
        Some("child-chart.png"),
        "truncated newer child reread must shadow older kept pixels"
    );
}

#[test]
fn dropped_child_tool_over_step_limit_keeps_short_name_ambiguous() {
    let read_img = |id: &str, call: &str, ts: u64, path: &str, png: &str| {
        history::decode_message(&json!({
            "id": id, "type": "assistant", "time": {"completed": ts},
            "content": [{
                "type": "tool", "id": call, "name": "read",
                "state": {
                    "status": "completed",
                    "input": {"filePath": path},
                    "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": format!("data:image/png;base64,{png}")}]
                }
            }]
        }))
        .unwrap()
    };
    let noop = |idx: usize| {
        history::decode_message(&json!({
            "id": format!("noop-{idx}"), "type": "assistant", "time": {"completed": idx + 2},
            "content": [{
                "type": "tool", "id": format!("call-noop-{idx}"), "name": "bash",
                "state": {"status": "completed", "content": [{"type": "text", "text": "ok"}]}
            }]
        }))
        .unwrap()
    };

    // 201 tools: tool #1 (dropped past STEP_LIMIT=200) read `/a/chart.png`, tool #201 (kept) read
    // `/b/chart.png`. Short name `chart.png` must remain ambiguous; explicit `/b/chart.png` resolves.
    let mut rows = Vec::with_capacity(201);
    rows.push(read_img("m0", "call-0", 1, "/a/chart.png", PNG_A).into());
    for i in 0..199 {
        rows.push(noop(i).into());
    }
    rows.push(read_img("m200", "call-200", 201, "/b/chart.png", PNG_B).into());

    let mut state = init();
    let _lease = state.transcript_display.children.install(
        "child-201-ambig",
        history::Page {
            rows,
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
    );
    assert!(state.transcript_display.children.poll());
    let tool_state = state
        .transcript_display
        .children
        .verified_tool_state(None, "child-201-ambig");
    assert_eq!(tool_state.steps.len(), 200);
    assert_eq!(tool_state.dropped_images.len(), 1);
    assert!(!tool_state.older_pages);
    let plan = prepare(
        &state,
        "task-201",
        "![Short](chart.png)\n\n![Exact](/b/chart.png)",
        false,
        Conversation::Child {
            parent: None,
            id: "child-201-ambig",
        },
    );
    let fallback = plan.fallback_label();
    assert_eq!(
        fallback("chart.png", true).as_deref(),
        Some("chart.png"),
        "dropped older tool image must keep shared short name ambiguous"
    );
    assert_eq!(
        fallback("/b/chart.png", true),
        None,
        "kept newer exact path must still resolve"
    );

    // Same file reread in tool #201 after tool #1 was dropped still resolves uniquely.
    let mut reread_rows = Vec::with_capacity(201);
    reread_rows.push(read_img("r0", "call-r0", 1, "/a/chart.png", PNG_A).into());
    for i in 0..199 {
        reread_rows.push(noop(i).into());
    }
    reread_rows.push(read_img("r200", "call-r200", 201, "/a/chart.png", PNG_B).into());
    let _reread_lease = state.transcript_display.children.install(
        "child-201-reread",
        history::Page {
            rows: reread_rows,
            older: None,
            newer: None,
            running: false,
            user_file_references: false,
        },
    );
    assert!(state.transcript_display.children.poll());
    let reread_plan = prepare(
        &state,
        "task-201-reread",
        "![Short](chart.png)",
        false,
        Conversation::Child {
            parent: None,
            id: "child-201-reread",
        },
    );
    assert_eq!(reread_plan.fallback_label()("chart.png", true), None);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn rendered_local_image_in_task_prompt_stays_visible_with_hidden_inputs() {
    use rune::{Env, Runtime};

    let read_msg = history::decode_message(&json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1},
        "content": [{
            "type": "tool", "id": "call-read", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/chart.png"},
                "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.messages = vec![read_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            crate::strings::with_locale("en", || {
                super::super::prose_pane_search(
                    s,
                    "m2",
                    "task-card",
                    "task-card-task-prompt".into(),
                    "![Plan](chart.png)",
                    false,
                    4096,
                    Conversation::Root,
                    None,
                )
            })
        },
        (800.0, 400.0),
        Env::new(false, 1.0),
    );
    rt.frame(1.0 / 60.0);
    // Decode the inline PNG so `slot.image` becomes `Some(image)` (`ImageSearch::Hidden`).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut ready = false;
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
            let plan = prepare(
                s,
                "task-card-task-prompt",
                "![Plan](chart.png)",
                false,
                Conversation::Root,
            );
            ready = plan
                .stamp
                .iter()
                .any(|(_, _, stamp)| matches!(stamp, SlotStamp::Ready(_)));
        });
        rt.frame(1.0 / 60.0);
        if ready {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "local image did not decode"
        );
        std::thread::yield_now();
    }
    rt.update(|s, _| {
        let plan = prepare(
            s,
            "task-card-task-prompt",
            "![Plan](chart.png)",
            false,
            Conversation::Root,
        );
        assert!(
            plan.stamp
                .iter()
                .any(|(_, _, stamp)| matches!(stamp, SlotStamp::Ready(_))),
            "local image must be decoded and rendered as pixels"
        );
        let terms = vec!["Plan".into()];
        let query = rune_theme_codenomad::timeline::search::Query {
            terms: &terms,
            ranked: false,
            active: true,
            claimed: None,
        };
        assert!(
            super::super::bounded_prose_matches_for(
                s,
                "task-card",
                "task-card-task-prompt",
                "![Plan](chart.png)",
                4096,
                Conversation::Root,
                query,
            ),
            "decoded local image alt must stay visible for hidden-input probing"
        );
        assert!(
            !super::super::bounded_prose_highlights_for(
                s,
                "task-card",
                "task-card-task-prompt",
                "![Plan](chart.png)",
                4096,
                Conversation::Root,
                query,
            ),
            "decoded local image alt must not steal active highlight from paintable output"
        );
    });
}

#[test]
fn incomplete_child_page_refuses_relative_match_while_resolving_exact_path() {
    let read_b = history::decode_message(&json!({
        "id": "m2", "type": "assistant", "time": {"completed": 2},
        "content": [{
            "type": "tool", "id": "call-b", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/b/chart.png"},
                "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_B}")}]
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    let _lease = state.transcript_display.children.install(
        "child-paged",
        history::Page {
            rows: vec![read_b.into()],
            older: Some("cursor-older".into()),
            newer: None,
            running: false,
            user_file_references: false,
        },
    );
    assert!(state.transcript_display.children.poll());
    let plan = prepare(
        &state,
        "task-paged",
        "![Short](chart.png)\n\n![Exact](/b/chart.png)",
        false,
        Conversation::Child {
            parent: None,
            id: "child-paged",
        },
    );
    let fallback = plan.fallback_label();
    assert_eq!(
        fallback("chart.png", true).as_deref(),
        Some("chart.png"),
        "incomplete child history with older pages must refuse short relative name"
    );
    assert_eq!(
        fallback("/b/chart.png", true),
        None,
        "exact absolute path on latest child page still resolves"
    );
}

#[test]
fn reread_same_http_url_in_new_tool_call_uses_distinct_cache_key() {
    let url = "https://example.test/chart.png";
    let call_1 = history::decode_message(&json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1},
        "content": [{
            "type": "tool", "id": "call-1", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/chart.png"},
                "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": url}]
            }
        }]
    }))
    .unwrap();
    let call_2 = history::decode_message(&json!({
        "id": "m2", "type": "assistant", "time": {"completed": 2},
        "content": [{
            "type": "tool", "id": "call-2", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/chart.png"},
                "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": url}]
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.messages = vec![call_1.clone().into()];
    let plan_1 = prepare(
        &state,
        "frag",
        "![Chart](/tmp/chart.png)",
        false,
        Conversation::Root,
    );
    let key_1 = plan_1.stamp[0].1.clone();
    state.messages = vec![call_1.into(), call_2.into()];
    let plan_2 = prepare(
        &state,
        "frag",
        "![Chart](/tmp/chart.png)",
        false,
        Conversation::Root,
    );
    let key_2 = plan_2.stamp[0].1.clone();
    assert_ne!(
        key_1, key_2,
        "rereading the same HTTP URL in a newer tool call must bust the previous call's cache slot"
    );
}

#[test]
fn incomplete_root_history_refuses_relative_match_while_resolving_exact_path() {
    let read_b = history::decode_message(&json!({
        "id": "m2", "type": "assistant", "time": {"completed": 2},
        "content": [{
            "type": "tool", "id": "call-b", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/b/chart.png"},
                "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_B}")}]
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.messages = vec![read_b.into()];
    state.can_older = true;
    let plan = prepare(
        &state,
        "root-paged",
        "![Short](chart.png)\n\n![Exact](/b/chart.png)",
        false,
        Conversation::Root,
    );
    let fallback = plan.fallback_label();
    assert_eq!(
        fallback("chart.png", true).as_deref(),
        Some("chart.png"),
        "root conversation with unloaded older pages must refuse short relative name"
    );
    assert_eq!(
        fallback("/b/chart.png", true),
        None,
        "exact absolute path on loaded root page still resolves"
    );
    state.can_older = false;
    state.history_detached = true;
    let detached_plan = prepare(
        &state,
        "root-detached",
        "![Short](chart.png)\n\n![Exact](/b/chart.png)",
        false,
        Conversation::Root,
    );
    assert_eq!(
        detached_plan.fallback_label()("chart.png", true).as_deref(),
        Some("chart.png"),
        "detached root window with unloaded newer pages must refuse short relative name"
    );
}

#[test]
fn converting_tool_output_with_different_name_does_not_shadow_input_file_and_refused_file_url_keeps_fallback()
 {
    let read_source = history::decode_message(&json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1},
        "content": [{
            "type": "tool", "id": "call-read", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/source.png"},
                "content": [{"type": "file", "name": "source.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let convert_tool = history::decode_message(&json!({
        "id": "m2", "type": "assistant", "time": {"completed": 2},
        "content": [{
            "type": "tool", "id": "call-convert", "name": "convert",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/source.png"},
                "content": [{"type": "file", "name": "/tmp/resultat.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_B}")}]
            }
        }]
    }))
    .unwrap();
    let convert_short = history::decode_message(&json!({
        "id": "m3", "type": "assistant", "time": {"completed": 3},
        "content": [{
            "type": "tool", "id": "call-convert-short", "name": "convert",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/source.png"},
                "content": [{"type": "file", "name": "other.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_B}")}]
            }
        }]
    }))
    .unwrap();
    let convert_unnamed = history::decode_message(&json!({
        "id": "m4", "type": "assistant", "time": {"completed": 4},
        "content": [{
            "type": "tool", "id": "call-convert-unnamed", "name": "convert",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/source.png"},
                "content": [{"type": "file", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_B}")}]
            }
        }]
    }))
    .unwrap();
    let convert_same_basename = history::decode_message(&json!({
        "id": "m5", "type": "assistant", "time": {"completed": 5},
        "content": [{
            "type": "tool", "id": "call-convert-basename", "name": "convert",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/source.png"},
                "content": [{"type": "file", "name": "source.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_B}")}]
            }
        }]
    }))
    .unwrap();
    if let Part::Tool(tool) = &convert_same_basename.parts[0] {
        let shadow_paths = tool_image_paths(tool);
        assert_eq!(shadow_paths.len(), 1);
        assert_eq!(
            shadow_paths[0].iter().map(Box::as_ref).collect::<Vec<_>>(),
            vec!["source.png"],
            "a non-read tool returning a short basename must not record its input filePath as a shadow"
        );
    } else {
        panic!("expected tool part");
    }
    let candidates = session_candidates(&[
        read_source.into(),
        convert_tool.into(),
        convert_short.into(),
        convert_unnamed.into(),
        convert_same_basename.into(),
    ]);
    assert_eq!(
        match_local_image(&candidates, "/tmp/source.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline(PNG_A.into())),
        "a non-read tool outputting an unnamed, differently named, or same-basename image must not index it under its input filePath"
    );
    assert_eq!(
        match_local_image(&candidates, "/tmp/resultat.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline(PNG_B.into()))
    );
    assert_eq!(
        match_local_image(&candidates, "other.png", true).map(|c| &c.source),
        Some(&PictureSource::Inline(PNG_B.into()))
    );

    // Refused `file:` URLs (e.g. parent traversal) still keep a readable filename fallback label.
    let state = init();
    let plan = Plan::empty(state.transcript_display.tool_clock.current_clip());
    assert_eq!(
        plan.fallback_label()("file:///tmp/projet/../chart.png", true).as_deref(),
        Some("chart.png")
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn decoded_empty_alt_local_image_keeps_filename_accessible_label() {
    let read_msg = history::decode_message(&json!({
        "id": "m1", "type": "assistant", "time": {"completed": 1},
        "content": [{
            "type": "tool", "id": "call-read", "name": "read",
            "state": {
                "status": "completed",
                "input": {"filePath": "/tmp/chart.png"},
                "content": [{"type": "file", "name": "chart.png", "mime": "image/png", "uri": format!("data:image/png;base64,{PNG_A}")}]
            }
        }]
    }))
    .unwrap();
    let mut state = init();
    state.messages = vec![read_msg.into()];
    let mut rt = Runtime::new(
        state,
        |s, _| {
            crate::strings::with_locale("en", || {
                super::super::prose(
                    s,
                    "m2",
                    "frag-empty-alt".into(),
                    "![](/tmp/chart.png)",
                    false,
                )
            })
        },
        (800.0, 400.0),
        Env::new(false, 1.0),
    );
    rt.frame(1.0 / 60.0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut ready = false;
        rt.update(|s, tx| {
            if crate::chat::events::poll_chat(s, 4) {
                tx.instant();
            }
            let plan = prepare(
                s,
                "frag-empty-alt",
                "![](/tmp/chart.png)",
                false,
                Conversation::Root,
            );
            ready = plan
                .stamp
                .iter()
                .any(|(_, _, stamp)| matches!(stamp, SlotStamp::Ready(_)));
        });
        rt.frame(1.0 / 60.0);
        if ready {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "empty-alt local image did not decode"
        );
        std::thread::yield_now();
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("\"role\":\"image\"") && tree.contains("chart.png"),
        "decoded empty-alt local image must keep filename as accessible label: {tree}"
    );
    assert!(
        !tree.contains("Image preview"),
        "decoded empty-alt local image must not fall back to generic English label: {tree}"
    );
    rt.update(|s, _| {
        let terms = vec!["chart.png".into()];
        let query = rune_theme_codenomad::timeline::search::Query {
            terms: &terms,
            ranked: false,
            active: true,
            claimed: None,
        };
        assert!(
            super::super::bounded_prose_matches_for(
                s,
                "task-card",
                "frag-empty-alt",
                "![](/tmp/chart.png)",
                4096,
                Conversation::Root,
                query,
            ),
            "decoded empty-alt local image must remain findable by its accessible filename label"
        );
        assert!(
            !super::super::bounded_prose_highlights_for(
                s,
                "task-card",
                "frag-empty-alt",
                "![](/tmp/chart.png)",
                4096,
                Conversation::Root,
                query,
            ),
            "decoded empty-alt local image must not claim active search highlight"
        );
    });
}
