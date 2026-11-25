use super::*;
use serde_json::{Value, json};

#[test]
fn skips_over_64_mib_unselected_field_in_constant_memory() {
    let mut parser = FilterParser::new(
        &["admitted", "code"],
        &[
            "id",
            "projectID",
            "projectCanonical",
            "coordinatorSessionId",
            "revision",
            "actors",
        ],
        4 * 1024 * 1024,
    );
    parser
        .feed(
            br#"{"admitted":true,"mission":{"id":"msn-1","projectID":"proj","projectCanonical":"/repo","coordinatorSessionId":"ses_c","revision":7,"actors":[],"tasks":[{"brief":""#,
        )
        .unwrap();
    let chunk = vec![b'a'; 64 * 1024];
    for _ in 0..1056 {
        parser.feed(&chunk).unwrap();
    }
    parser
        .feed(br#"","escaped":"quote\"and\\brace}"}],"history":[1,2,3]}}"#)
        .unwrap();
    let bytes = parser.finish().unwrap();
    assert!(bytes.len() < 512, "kept bytes must remain tiny");
    let parsed: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        parsed,
        json!({
            "admitted": true,
            "mission": {
                "id": "msn-1",
                "projectID": "proj",
                "projectCanonical": "/repo",
                "coordinatorSessionId": "ses_c",
                "revision": 7,
                "actors": []
            }
        })
    );
}

#[test]
fn enforces_kept_limit_and_handles_byte_by_byte_chunking() {
    let input = br#"{"available":true,"version":1,"projectID":"p","mission":{"id":"m","projectID":"p","revision":9,"tasks":[{"x":"ignored"}]},"cleanups":[]}"#;
    let mut parser = FilterParser::new(
        &["available", "version", "projectID", "cleanups"],
        &["id", "projectID", "revision"],
        4096,
    );
    for b in input {
        parser.feed(&[*b]).unwrap();
    }
    let parsed: Value = serde_json::from_slice(&parser.finish().unwrap()).unwrap();
    assert_eq!(parsed["mission"]["revision"], json!(9));
    assert_eq!(parsed["cleanups"], json!([]));

    let mut tight = FilterParser::new(&["big"], &[], 8);
    assert!(tight.feed(br#"{"big":"1234567890"}"#).is_err());
}

#[test]
fn rejects_trailing_commas_and_preserves_duplicate_or_non_object_mission() {
    // Trailing comma in root object, mission object, or skipped array must be rejected.
    for bad in [
        br#"{"admitted":true,}"#.as_slice(),
        br#"{"admitted":true,"mission":{"id":"m",}}"#.as_slice(),
        br#"{"admitted":true,"mission":{"id":"m","tasks":[1,]}}"#.as_slice(),
        br#"{"admitted":true,"mission":{"id":"m","extra":{"a":1,}}}"#.as_slice(),
        br#"{"admitted":true,"extra":truex}"#.as_slice(),
    ] {
        let mut p = FilterParser::new(&["admitted"], &["id"], 4096);
        assert!(
            p.feed(bad).and_then(|()| p.finish()).is_err(),
            "expected invalid JSON to fail: {}",
            String::from_utf8_lossy(bad)
        );
    }

    // Duplicate `"mission": null` after `"mission": {...}` must overwrite the object.
    let mut dup = FilterParser::new(&["admitted"], &["id"], 4096);
    dup.feed(br#"{"admitted":true,"mission":{"id":"m"},"mission":null}"#)
        .unwrap();
    let dup_val: Value = serde_json::from_slice(&dup.finish().unwrap()).unwrap();
    assert_eq!(dup_val["mission"], Value::Null);

    // Non-object `"mission": []` must be preserved so callers reject it instead of treating it as absent.
    let mut arr = FilterParser::new(&["available", "cleanups"], &["id"], 4096);
    arr.feed(br#"{"available":true,"mission":[],"cleanups":[]}"#)
        .unwrap();
    let arr_val: Value = serde_json::from_slice(&arr.finish().unwrap()).unwrap();
    assert_eq!(arr_val["mission"], json!([]));
}

#[test]
fn rejects_invalid_escapes_surrogates_and_utf8_in_skipped_strings_and_long_keys() {
    let long_bad_key = format!(
        r#"{{"{}":"\u0041","admitted":true}}"#,
        "k".repeat(140) + r"\q"
    );
    let bad_utf8: &[u8] = b"{\"admitted\":true,\"ignored\":\"\xFF\"}";
    let overlong_utf8: &[u8] = b"{\"admitted\":true,\"ignored\":\"\xC0\xAF\"}";
    for bad in [
        br#"{"admitted":true,"ignored":"\x"}"#.as_slice(),
        br#"{"admitted":true,"ignored":"\u123"}"#.as_slice(),
        br#"{"admitted":true,"ignored":"\u123G"}"#.as_slice(),
        br#"{"admitted":true,"ignored":"\uD800"}"#.as_slice(),
        br#"{"admitted":true,"ignored":"\uD800a"}"#.as_slice(),
        br#"{"admitted":true,"ignored":"\uDC00"}"#.as_slice(),
        br#"{"admitted":true,"tasks":[{"note":"\q"}]}"#.as_slice(),
        long_bad_key.as_bytes(),
        bad_utf8,
        overlong_utf8,
    ] {
        let mut p = FilterParser::new(&["admitted"], &["id"], 4096);
        assert!(
            p.feed(bad).and_then(|()| p.finish()).is_err(),
            "expected malformed string/key to fail: {:?}",
            bad
        );
    }

    // Valid surrogate pair and multibyte UTF-8 in skipped fields must succeed.
    let mut good = FilterParser::new(&["admitted"], &[], 4096);
    good.feed(
        "{\"admitted\":true,\"tasks\":[{\"note\":\"\\uD83E\\uDD80 🦀 \\\"ok\\\"\"}]}".as_bytes(),
    )
    .unwrap();
    let val: Value = serde_json::from_slice(&good.finish().unwrap()).unwrap();
    assert_eq!(val, json!({"admitted": true}));
}

#[test]
fn enforces_total_transfer_limit_across_skipped_fields_and_whitespace() {
    let mut skipped = FilterParser::new(&["admitted"], &[], 4096).with_total_limit(64);
    skipped.feed(br#"{"admitted":true,"ignored":""#).unwrap();
    assert!(skipped.feed(&vec![b'a'; 64]).is_err());

    let mut ws = FilterParser::new(&["admitted"], &[], 4096).with_total_limit(32);
    ws.feed(br#"{"admitted":true}"#).unwrap();
    assert!(ws.feed(&vec![b' '; 32]).is_err());
}

#[test]
fn coordinator_actor_filter_streams_past_oversized_actors_in_constant_kept_memory() {
    let mut p = FilterParser::new(&["admitted"], &["id", "actors"], 4096)
        .with_actor_filter(Some("ses_coord"));
    p.feed(br#"{"admitted":true,"mission":{"id":"msn_1","actors":["#)
        .unwrap();
    let worker_blob = format!(
        r#"{{"kind":"specialist","sessionId":"ses_w","location":{{"directory":"/repo"}},"title":"{}"}},"#,
        "w".repeat(4096)
    );
    // Feed > 8 MiB of non-coordinator actors under a 4 KiB kept-byte ceiling.
    for _ in 0..2100 {
        p.feed(worker_blob.as_bytes()).unwrap();
    }
    let coord = format!(
        r#"{{"kind":"coordinator","sessionId":"ses_coord","location":{{"directory":"/repo"}},"title":"{}"}}"#,
        "c".repeat(16_384)
    );
    p.feed(coord.as_bytes()).unwrap();
    p.feed(br#"]}}"#).unwrap();
    let val: Value = serde_json::from_slice(&p.finish().unwrap()).unwrap();
    assert_eq!(val["admitted"], json!(true));
    assert_eq!(
        val["mission"]["actors"],
        json!([{"kind": "coordinator", "sessionId": "ses_coord", "location": {"directory": "/repo"}}])
    );
}
