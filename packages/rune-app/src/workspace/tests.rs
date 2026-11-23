use super::*;

fn workspace() -> Workspace {
    Workspace {
        backend_id: None,
        server_id: None,
        folder: "/".into(),
        occurrence: 0,
        workspace_id: None,
        active_session_id: None,
        drafts: BTreeMap::new(),
        view: Default::default(),
    }
}
fn snapshot(workspace: Workspace) -> Snapshot {
    Snapshot {
        revision: 7,
        saved_at: 1234,
        panel_widths: [None; 2],
        tabs: vec![Tab::Workspace(workspace)],
        active: Some(0),
    }
}
fn value(snapshot: &Snapshot) -> Value {
    serde_json::from_slice(&encode(snapshot).unwrap()).unwrap()
}
fn from_value(value: &Value) -> Result<Snapshot, Error> {
    decode(&serde_json::to_vec(value).unwrap())
}

#[test]
fn canonical_round_trip_keeps_occurrences_and_text_separate() {
    let mut first = workspace();
    first.folder = "C:\\trial\\project".into();
    first.backend_id = Some("remote-one".into());
    first.server_id = Some("server-one".into());
    first.workspace_id = Some("workspace-one".into());
    first.active_session_id = Some("ses_same".into());
    first.view = ViewState {
        files_tab: true,
        files_mode: Some("changes"),
    };
    first.drafts.insert("ses_same".into(), "first\n🦀".into());
    let mut second = first.clone();
    second.occurrence = 1;
    second.view = ViewState {
        files_tab: false,
        files_mode: Some("history"),
    };
    second.drafts.insert("ses_same".into(), "second".into());
    second
        .drafts
        .insert("__no_session_draft__".into(), String::new());
    second.drafts.insert(
        "__recovered_draft__01234567-89ab-cdef-0123-456789abcdef".into(),
        "recovered".into(),
    );
    let input = Snapshot {
        revision: MAX_SAFE,
        saved_at: MAX_SAFE,
        panel_widths: [None; 2],
        tabs: vec![Tab::Blank, Tab::Workspace(first), Tab::Workspace(second)],
        active: Some(2),
    };
    let bytes = encode(&input).unwrap();
    assert_eq!(decode(&bytes).unwrap(), input);
    assert_eq!(encode(&decode(&bytes).unwrap()).unwrap(), bytes);
    let json: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["layout"], json!({}));
    assert_eq!(
        json["session"]["tabs"][1]["viewState"],
        json!({
            "version": 1, "rightPanelTab": "files", "filesMode": "changes"
        })
    );
    for key in [
        "attachments",
        "scrollSnapshots",
        "unseenIdleSince",
        "generationRecovery",
    ] {
        assert_eq!(json["session"]["tabs"][1][key], json!({}));
    }
}

#[test]
fn rejects_malformed_future_and_unsupported_state() {
    assert_eq!(decode(b"{"), Err(Error::Malformed));
    let base = value(&snapshot(workspace()));
    for (key, entry, expected) in [
        ("version", json!(2), Error::Unsupported),
        ("version", Value::Null, Error::Malformed),
        ("revision", json!(-1), Error::Malformed),
        ("savedAt", json!(1.5), Error::Malformed),
        ("revision", json!(MAX_SAFE + 1), Error::Limit),
        ("layout", json!({"panel":"open"}), Error::Unsupported),
    ] {
        let mut input = base.clone();
        input[key] = entry;
        assert_eq!(from_value(&input), Err(expected), "{key}");
    }
    let mut input = base.clone();
    input.as_object_mut().unwrap().remove("version");
    assert_eq!(from_value(&input), Err(Error::Malformed));
    for (key, entry) in [
        ("attachments", json!({"ses_a":[]})),
        ("viewState", json!({"files":true})),
        ("projectName", json!("unloaded")),
        ("auth", json!("secret")),
    ] {
        let mut input = base.clone();
        input["session"]["tabs"][0][key] = entry;
        assert_eq!(from_value(&input), Err(Error::Unsupported));
    }
    let mut input = base;
    input["session"]["activeTabIndex"] = json!(1);
    assert_eq!(from_value(&input), Err(Error::Malformed));
}

#[test]
fn measures_utf16_and_shared_string_budget_without_truncation() {
    let mut input = workspace();
    input
        .drafts
        .insert("ses".into(), "🦀".repeat(MAX_DRAFT / 2));
    assert_eq!(
        decode(&encode(&snapshot(input.clone())).unwrap()).unwrap(),
        snapshot(input.clone())
    );
    input.drafts.get_mut("ses").unwrap().push('a');
    assert_eq!(encode(&snapshot(input)), Err(Error::Limit));
    let mut input = workspace();
    for (key, len) in [("s1", MAX_DRAFT), ("s2", MAX_DRAFT), ("s3", MAX_DRAFT - 7)] {
        input.drafts.insert(key.into(), "a".repeat(len));
    }
    let exact = snapshot(input.clone());
    assert!(encode(&exact).is_ok());
    input.drafts.get_mut("s3").unwrap().push('a');
    assert_eq!(encode(&snapshot(input)), Err(Error::Limit));
    let mut raw = value(&exact);
    raw["session"]["tabs"][0]["drafts"]["s3"] = json!("a".repeat(MAX_DRAFT - 6));
    assert_eq!(from_value(&raw), Err(Error::Limit));
}

#[test]
fn enforces_count_byte_path_identity_and_selection_bounds() {
    let mut input = Snapshot {
        revision: 0,
        saved_at: 0,
        panel_widths: [None; 2],
        tabs: vec![Tab::Blank; MAX_TABS],
        active: Some(31),
    };
    assert!(encode(&input).is_ok());
    input.tabs.push(Tab::Blank);
    assert_eq!(encode(&input), Err(Error::Limit));
    let mut tab = workspace();
    for i in 0..MAX_DRAFTS {
        tab.drafts.insert(format!("s{i}"), String::new());
    }
    assert!(encode(&snapshot(tab.clone())).is_ok());
    tab.drafts.insert("extra".into(), String::new());
    assert_eq!(encode(&snapshot(tab)), Err(Error::Limit));
    for folder in [
        "relative/path",
        "C:relative",
        "\\\\?\\C:\\trial",
        "/bad\0path",
    ] {
        let mut tab = workspace();
        tab.folder = folder.into();
        assert_eq!(encode(&snapshot(tab)), Err(Error::Malformed));
    }
    for id in [
        "__proto__",
        "constructor",
        "prototype",
        "__recovered_draft__bad",
        "ses/bad",
    ] {
        let mut tab = workspace();
        tab.drafts.insert(id.into(), "draft".into());
        assert_eq!(encode(&snapshot(tab)), Err(Error::Malformed));
    }
    for backend in ["local", "bad/id", "constructor"] {
        let mut tab = workspace();
        tab.backend_id = Some(backend.into());
        assert_eq!(encode(&snapshot(tab)), Err(Error::Malformed));
    }
    let mut tab = workspace();
    tab.server_id = Some("server".into());
    assert_eq!(encode(&snapshot(tab)), Err(Error::Malformed));
    let empty = Snapshot {
        revision: 0,
        saved_at: 0,
        panel_widths: [None; 2],
        tabs: vec![],
        active: None,
    };
    let mut bytes = encode(&empty).unwrap();
    bytes.resize(MAX_BYTES, b' ');
    assert_eq!(decode(&bytes).unwrap(), empty);
    bytes.push(b' ');
    assert_eq!(decode(&bytes), Err(Error::Limit));
}

#[test]
fn accepts_v1_null_session_and_safe_integer_json_numbers() {
    let mut raw = value(&Snapshot {
        revision: 0,
        saved_at: 0,
        panel_widths: [None; 2],
        tabs: vec![],
        active: None,
    });
    raw["session"] = Value::Null;
    raw["revision"] = json!(1.0);
    assert_eq!(
        from_value(&raw).unwrap(),
        Snapshot {
            revision: 1,
            saved_at: 0,
            panel_widths: [None; 2],
            tabs: vec![],
            active: None
        }
    );
}

#[test]
fn native_store_preserves_panel_widths_under_the_solid_layout_keys() {
    let mut input = snapshot(workspace());
    input.panel_widths = [Some(440), Some(295)];
    let mut raw = value(&input);
    assert_eq!(raw["layout"][PANEL_WIDTH_KEYS[0]], "440");
    assert_eq!(raw["layout"][PANEL_WIDTH_KEYS[1]], "295");
    assert_eq!(from_value(&raw), Ok(input.clone()));
    raw["layout"][PANEL_WIDTH_KEYS[1]] = json!("295.35");
    assert_eq!(from_value(&raw), Ok(input.clone()));
    input.panel_widths[0] = Some(0);
    assert_eq!(encode(&input), Err(Error::Limit));
}
