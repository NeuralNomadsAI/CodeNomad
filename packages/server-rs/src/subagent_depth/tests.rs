use super::*;
use crate::subagent_depth::document::DocError;
use crate::subagent_depth::jsonc::{string, utf16};
use axum::http::header;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../tests/fixtures/depth-golden.json")).unwrap()
}
fn document(spec: &Value, target: &str) -> Document {
    Document {
        requested: target.into(),
        write: target.into(),
        exists: spec["exists"].as_bool().unwrap(),
        mode: spec["mode"].as_u64().unwrap() as u32,
        text: utf16(spec["text"].as_str().unwrap()),
        bom: spec["bom"].as_bool().unwrap(),
    }
}
fn outcome(r: Result<String, DocError>) -> Value {
    match r {
        Ok(t) => json!({"text": t}),
        Err(DocError::Plain) => json!({"error": {"plain": true}}),
        Err(DocError::Invalid(m)) => json!({"error": {"kind": "invalid", "message": m}}),
        Err(DocError::Conflict(m)) => json!({"error": {"kind": "conflict", "message": m}}),
        Err(DocError::Filesystem(m)) => json!({"error": {"kind": "filesystem", "message": m}}),
    }
}
fn exposed(v: &Value) -> Option<bool> {
    v.as_bool()
}

#[test]
fn edits_equal_the_reference_byte_for_byte() {
    let g = golden();
    let (target, directory) = (g["target"].as_str().unwrap(), g["directory"].as_str().unwrap());
    let mut checked = 0;
    for case in g["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let d = document(&case["document"], target);
        assert_eq!(doc::expectation(&d), case["expectation"], "{name} expectation");
        let read = doc::read(&d, &["experimental", "subagent_depth"])
            .map(|v| string(&jsonc::stringify(&v.unwrap_or(J::Null), None)));
        assert_eq!(outcome(read), case["read"], "{name} read");
        assert_eq!(rules::nesting_rule_skipped(&d), case["skipped"], "{name} skipped");
        for (i, e) in [None, Some(true), Some(false)].into_iter().enumerate() {
            let r =
                rules::without_redundant(&d, e, None).map(|t| if t.is_some() { "yes".into() } else { String::new() });
            assert_eq!(outcome(r), case["empty"][i], "{name} emptyExperimental {e:?}");
        }
        for r in case["results"].as_array().unwrap() {
            let entries = g["entrySets"][r["entries"].as_str().unwrap()].as_array().unwrap().clone();
            let value = r["value"].as_f64();
            let path = r["path"].as_str().unwrap();
            let label = format!("{name} {path} {} {value:?} {:?}", r["entries"], r["exposed"]);
            let out = edit_text(&d, &entries, path, directory, value, exposed(&r["exposed"])).map(|t| string(&t));
            assert_eq!(outcome(out.clone()), r["out"], "{label}");
            if let (Some(back), Ok(text)) = (r.get("back"), out) {
                let edited = doc::with_text(&d, &utf16(&text));
                let again =
                    edit_text(&edited, &entries, path, directory, None, exposed(&r["exposed"])).map(|t| string(&t));
                assert_eq!(outcome(again), *back, "{label} back to Inherit");
            }
            checked += 1;
        }
    }
    assert!(checked > 500);
}

#[test]
fn formatter_matches_the_reference_layouts() {
    let g = golden();
    for e in g["edits"].as_array().unwrap() {
        let d = Document {
            requested: String::new(),
            write: String::new(),
            exists: true,
            mode: 0o666,
            text: utf16(e["text"].as_str().unwrap()),
            bom: false,
        };
        let keys: Vec<&str> = e["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        let value = if e["remove"] == true { None } else { Some(J::from_json(&e["value"])) };
        let out = doc::edit_setting(&d, &keys, value).map(|t| string(&t));
        assert_eq!(outcome(out), e["out"], "{} {:?}", e["text"], keys);
    }
}

#[test]
fn nesting_effects_match_the_reference() {
    for e in golden()["effects"].as_array().unwrap() {
        let r = e["rules"].as_array().unwrap();
        let ic = e["ignoreCase"].as_bool().unwrap();
        assert_eq!(rules::nesting_effect(r, ic).map_or(Value::Null, |x| json!(x)), e["effect"], "{e}");
        assert_eq!(rules::tool_hidden(r, ic), e["hidden"], "{e}");
    }
}

#[test]
fn requests_are_validated_like_zod() {
    assert_eq!(query_directory(Some("directory=%20C%3A%5Cx%20")), Some("C:\\x".into()));
    assert_eq!(query_directory(Some("directory=a+b")), Some("a b".into()));
    for bad in [
        None,
        Some(""),
        Some("directory="),
        Some("directory=%20"),
        Some("directory=a&directory=b"),
        Some("directory=a&x=1"),
    ] {
        assert_eq!(query_directory(bad), None, "{bad:?}");
    }
    assert_eq!(query_directory(Some(&format!("directory={}", "a".repeat(32_769)))), None);
    let e = "a".repeat(64);
    let ok = |b: Value| mutation(b.to_string().as_bytes());
    assert_eq!(
        ok(json!({"location":{"directory":" d "},"depth":3,"expectation":e})),
        Some(("d".into(), Some(3.0), e.clone()))
    );
    assert_eq!(
        ok(json!({"location":{"directory":"d"},"depth":null,"expectation":e})),
        Some(("d".into(), None, e.clone()))
    );
    assert_eq!(ok(json!({"location":{"directory":"d"},"depth":2.0,"expectation":e})).unwrap().1, Some(2.0));
    for bad in [
        json!({"location":{"directory":"d"},"depth":-1,"expectation":e}),
        json!({"location":{"directory":"d"},"depth":1.5,"expectation":e}),
        json!({"location":{"directory":"d"},"depth":9007199254740992.0,"expectation":e}),
        json!({"location":{"directory":"d"},"depth":"3","expectation":e}),
        json!({"location":{"directory":"d"},"expectation":e}),
        json!({"location":{"directory":"d","workspaceID":"w"},"depth":1,"expectation":e}),
        json!({"location":{"directory":"d"},"depth":1,"expectation":"A".repeat(64)}),
        json!({"location":{"directory":"d"},"depth":1,"expectation":e,"extra":1}),
        json!({"location":{"directory":""},"depth":1,"expectation":e}),
    ] {
        assert_eq!(ok(bad.clone()), None, "{bad}");
    }
    assert_eq!(mutation(b"not json"), None);
}

#[test]
fn bodies_are_parsed_like_fastify() {
    let with = |t: Option<&str>| {
        let mut h = HeaderMap::new();
        if let Some(t) = t {
            h.insert(header::CONTENT_TYPE, t.parse().unwrap());
        }
        h
    };
    let code = |r: Result<(), Error>| {
        r.err().map(|(s, Json(b))| (s.as_u16(), b["code"].as_str().or(b["error"].as_str()).unwrap().to_string()))
    };
    assert_eq!(code(content(&with(Some("application/json; charset=utf-8")), b"{}")), None);
    assert_eq!(
        code(content(&with(Some("application/json")), b"")).unwrap(),
        (400, "FST_ERR_CTP_EMPTY_JSON_BODY".into())
    );
    assert_eq!(
        code(content(&with(Some("application/json")), b"{")).unwrap(),
        (400, "FST_ERR_CTP_INVALID_JSON_BODY".into())
    );
    assert_eq!(
        code(content(&with(Some("application/json")), br#"{"a":{"__proto__":1}}"#)).unwrap().1,
        "FST_ERR_CTP_INVALID_JSON_BODY"
    );
    assert_eq!(code(content(&with(Some("application/json")), br#"{"a":"\"__proto__\":"}"#)), None);
    assert_eq!(
        code(content(&with(Some("text/plain")), b"{}")).unwrap(),
        (400, "Invalid subagent depth request".into())
    );
    assert_eq!(
        code(content(&with(Some("application/xml")), b"<a/>")).unwrap(),
        (415, "FST_ERR_CTP_INVALID_MEDIA_TYPE".into())
    );
    assert_eq!(code(content(&with(None), b"{}")).unwrap().0, 415);
    assert_eq!(code(content(&with(None), b"")).unwrap().0, 400);
}

#[test]
fn capability_follows_the_openapi_contract() {
    let schema = |v: Value| json!({"components":{"schemas":{"Config.InfoEncoded":{"properties":{"experimental":{"properties":{"subagent_depth":v}}}}}}});
    assert_eq!(
        capability(&schema(json!({"type":"integer","minimum":0,"maximum":9007199254740991u64}))),
        Some((Some(MAX_SAFE), None))
    );
    assert_eq!(capability(&schema(json!({"type":"integer","minimum":0,"default":2}))), Some((None, Some(2.0))));
    for bad in [
        json!({"type":"number","minimum":0}),
        json!({"type":"integer","minimum":1}),
        json!({"type":"integer","minimum":0,"maximum":-1}),
        json!({"type":"integer","minimum":0,"maximum":2,"default":3}),
        json!({"type":"integer","minimum":0,"maximum":null}),
        json!(null),
    ] {
        assert_eq!(capability(&schema(bad.clone())), None, "{bad}");
    }
    assert_eq!(capability(&json!({})), None);
}

#[test]
fn paths_follow_node() {
    let w = Style::Win32;
    assert_eq!(w.join("C:\\a\\", ".opencode\\opencode.json"), "C:\\a\\.opencode\\opencode.json");
    assert_eq!(w.dirname("C:\\a\\b"), "C:\\a");
    assert_eq!(w.dirname("C:\\a"), "C:\\");
    assert_eq!(w.basename("C:\\a\\.opencode\\"), ".opencode");
    assert_eq!(w.relative("C:\\A\\b", "c:\\a\\B\\c"), "c");
    assert_eq!(w.relative("C:\\a\\b", "C:\\a"), "..");
    assert_eq!(w.relative("C:\\a", "D:\\a"), "D:\\a");
    assert!(w.contains("C:\\a", "C:\\a\\b") && !w.contains("C:\\a\\b", "C:\\a"));
    assert!(w.same("C:\\A\\", "c:\\a") && !w.valid_absolute("a\\b"));
    let p = Style::Posix;
    assert_eq!(p.join("/a/", ".opencode/opencode.json"), "/a/.opencode/opencode.json");
    assert_eq!(p.relative("/a/b", "/a/c"), "../c");
    assert!(!p.same("/A", "/a"));
}

#[test]
fn host_replacement_is_atomic_and_fenced() {
    let dir = crate::shared::test_dir("depth-fs").to_string_lossy().into_owned();
    let file = Style::host().join(&dir, &Style::host().join(".opencode", "opencode.jsonc"));
    let (write, exists) = fs::inspect(&file).unwrap();
    assert_eq!((write.as_str(), exists), (file.as_str(), false));
    let absent = fs::load(&file).unwrap();
    assert_eq!((absent.exists, absent.mode, string(&absent.text)), (false, 0o600, "{}\n".into()));
    let unconfirmed = fs::prepare(&absent, &utf16("{\"only\":\"staged\"}\n")).unwrap();
    assert!(!std::path::Path::new(&file).exists());
    drop(unconfirmed);
    assert!(!std::path::Path::new(&file).exists());
    fs::replace(&absent, &utf16("{\n  \"a\": 1\n}\n")).unwrap();
    let present = fs::load(&file).unwrap();
    assert!(present.exists && string(&present.text) == "{\n  \"a\": 1\n}\n");
    // A stale document (changed on disk after reading) is refused without writing.
    let staged = fs::prepare(&present, &utf16("{}\n")).unwrap();
    std::fs::write(&file, "{ \"b\": 2 }\n").unwrap();
    assert!(staged.commit().is_err());
    assert_eq!(
        fs::replace(&present, &utf16("{}\n")),
        Err(DocError::Conflict("OpenCode configuration changed during the update"))
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ \"b\": 2 }\n");
    // A held lock (another writer) is a conflict after the bounded wait; the source stays.
    let fresh = fs::load(&file).unwrap();
    std::fs::create_dir(format!("{file}.codenomad-plugin-controls.lock")).unwrap();
    assert_eq!(
        fs::replace(&fresh, &utf16("{}\n")),
        Err(DocError::Conflict("OpenCode configuration is being updated by another process"))
    );
    std::fs::remove_dir_all(format!("{file}.codenomad-plugin-controls.lock")).unwrap();
    // BOM and the original bytes survive a parse; malformed and duplicate plugins are refused.
    std::fs::write(&file, b"\xef\xbb\xbf{ \"m\": 1 }").unwrap();
    let bom = fs::load(&file).unwrap();
    assert!(bom.bom && string(&bom.text) == "{ \"m\": 1 }");
    fs::replace(&bom, &doc::full(&bom)).unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"\xef\xbb\xbf{ \"m\": 1 }");
    std::fs::write(&file, "{ \"m\": ").unwrap();
    assert_eq!(fs::load(&file).err(), Some(DocError::Invalid("OpenCode configuration is malformed")));
    std::fs::write(&file, "{ \"plugins\": [], \"plugins\": [] }").unwrap();
    assert_eq!(fs::load(&file).err(), Some(DocError::Invalid("OpenCode configuration has duplicate plugins keys")));
    let leftovers: Vec<_> = std::fs::read_dir(Style::host().dirname(&file))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");
    // Both JSON and JSONC in one layer are refused in strict mode.
    std::fs::write(Style::host().join(&dir, "opencode.json"), "{}").unwrap();
    std::fs::write(Style::host().join(&dir, "opencode.jsonc"), "{}").unwrap();
    let entries = vec![json!({"type":"directory","path": dir})];
    let refused = resolve_targets(Style::host(), &Style::host().join(&dir, "g"), &dir, &entries, true).unwrap_err();
    assert_eq!(refused, fail(Status::CONFLICT, "OpenCode configuration changed: JSON and JSONC coexist in one layer"));
    let targets = resolve_targets(Style::host(), &Style::host().join(&dir, "g"), &dir, &entries, false).unwrap();
    assert!(targets.len() == 2 && targets[1].io.ends_with("opencode.jsonc") && targets[1].exists);
    let _ = std::fs::remove_dir_all(&dir);
}
