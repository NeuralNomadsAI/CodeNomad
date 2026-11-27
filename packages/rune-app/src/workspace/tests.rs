use super::*;

fn workspace() -> Workspace {
    Workspace {
        backend_id: None,
        server_id: None,
        folder: "/".into(),
        project_name: None,
        temporary: false,
        occurrence: 0,
        workspace_id: None,
        active_session_id: None,
        drafts: BTreeMap::new(),
        attachment_drafts: Default::default(),
        attachment_parts: Default::default(),
        view: Default::default(),
    }
}

#[test]
fn saving_preserves_valid_siblings_of_an_invalid_tab() {
    let mut broken = workspace();
    broken
        .drafts
        .insert("ses_bad".into(), "X".repeat(MAX_DRAFT + 1));
    broken
        .drafts
        .insert("ses_sibling".into(), "same tab survives".into());
    let mut good = workspace();
    good.occurrence = 1;
    good.drafts
        .insert("ses_ok".into(), "saved independently".into());
    let snapshot = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(broken), Tab::Workspace(good.clone())],
        active: Some(1),
    };
    assert!(encode(&snapshot).is_err());
    let (bytes, partial) = encode_for_save(&snapshot).unwrap();
    assert!(partial);
    let saved = decode(&bytes).unwrap();
    assert!(matches!(&saved.tabs[0], Tab::Workspace(tab)
        if tab.drafts.len() == 1 && tab.drafts["ses_sibling"] == "same tab survives"));
    assert_eq!(saved.tabs[1], Tab::Workspace(good));
    assert!(
        matches!(&snapshot.tabs[0], Tab::Workspace(tab) if tab.drafts["ses_bad"].len() > MAX_DRAFT)
    );
}

#[test]
fn byte_budget_keeps_the_active_draft_and_sheds_the_smallest_sufficient_payload() {
    use crate::composer::draft_storage::SavedParts;
    let mut tab = workspace();
    tab.active_session_id = Some("ses_3".into());
    for (index, size) in [255, 255, 255, 255, 8].into_iter().enumerate() {
        let id = format!("ses_{index}");
        tab.drafts.insert(id.clone(), "[pasted #1]".into());
        tab.attachment_drafts.insert(id.clone());
        tab.attachment_parts.insert(
            id,
            SavedParts::decode(&json!({
                "complete": true,
                "parts": [
                    {"type":"pasted","id":"1","text":"p".repeat(size * 1024)},
                    {"type":"agent","name":"reviewer"}
                ]
            }))
            .unwrap(),
        );
    }
    tab.drafts
        .insert("ses_unrelated".into(), "untouched".into());
    let full = snapshot(tab.clone());
    assert_eq!(encode(&full).unwrap_err(), Error::Limit);
    let (bytes, partial) = encode_for_save(&full).unwrap();
    assert!(partial);
    let saved = decode(&bytes).unwrap();
    let [Tab::Workspace(saved_tab)] = saved.tabs.as_slice() else {
        panic!("one live tab")
    };
    assert_eq!(saved.active, full.active);
    assert_eq!(saved_tab.active_session_id, tab.active_session_id);
    assert_eq!(saved_tab.drafts, tab.drafts);
    assert_eq!(saved_tab.attachment_drafts, tab.attachment_drafts);
    let degraded = saved_tab
        .attachment_parts
        .iter()
        .filter(|(id, parts)| **parts != tab.attachment_parts[*id])
        .collect::<Vec<_>>();
    let [(id, degraded)] = degraded.as_slice() else {
        panic!("one degraded draft")
    };
    assert_eq!(id.as_str(), "ses_4");
    let (parts, incomplete) = degraded.restore();
    assert!(incomplete);
    assert_eq!(
        parts.attachments,
        [crate::composer::draft::Attachment::Agent("reviewer".into())]
    );
    assert_eq!(encode(&saved).unwrap(), bytes);

    let mut prefers_small = tab.clone();
    prefers_small.active_session_id = Some("ses_4".into());
    let (reserved, partial) = encode_for_save(&snapshot(prefers_small)).unwrap();
    assert!(partial);
    let reopened = decode(&reserved).unwrap();
    let [Tab::Workspace(reopened)] = reopened.tabs.as_slice() else {
        panic!("one live tab")
    };
    assert_eq!(
        reopened.attachment_parts["ses_4"],
        tab.attachment_parts["ses_4"]
    );

    #[cfg(not(target_arch = "wasm32"))]
    {
        let root = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
        let store =
            crate::platform::block_on(crate::platform::storage::Store::open(root.clone())).unwrap();
        let mut persistence = super::persistence::Persistence::new();
        persistence.store = Some(store.clone());
        assert!(
            !persistence.flush(&full),
            "partial writes are not a complete close"
        );
        assert_eq!(
            crate::platform::block_on(store.load()).unwrap().unwrap(),
            bytes
        );
        drop((persistence, store));
        std::fs::remove_dir_all(root).unwrap();
    }
}
fn snapshot(workspace: Workspace) -> Snapshot {
    Snapshot {
        revision: 7,
        saved_at: 1234,
        panel_widths: [None; 2],
        file_wrap: None,
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
        right_panel: RightPanelTab::Files,
        files_mode: Some("changes"),
        selected_mission: None,
    };
    first.drafts.insert("ses_same".into(), "first\n🦀".into());
    let mut second = first.clone();
    second.occurrence = 1;
    second.view = ViewState {
        right_panel: RightPanelTab::Missions,
        files_mode: Some("history"),
        selected_mission: Some("mission-second".into()),
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
        file_wrap: None,
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
    assert_eq!(
        json["session"]["tabs"][2]["viewState"]["missions"]["selected"],
        "mission-second"
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
        file_wrap: None,
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
        file_wrap: None,
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
        file_wrap: None,
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
            file_wrap: None,
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

#[test]
fn source_wrap_round_trips_the_solid_layout_key_without_affecting_window_state() {
    let mut input = snapshot(workspace());
    for (value_on_disk, wrap) in [("on", Some(true)), ("off", Some(false)), ("unknown", None)] {
        let mut raw = value(&input);
        raw["layout"][FILE_WRAP_KEY] = json!(value_on_disk);
        input.file_wrap = wrap;
        assert_eq!(from_value(&raw), Ok(input.clone()));
        assert_eq!(
            value(&input)["layout"][FILE_WRAP_KEY].as_str(),
            wrap.map(|_| value_on_disk)
        );
    }
}

#[test]
fn project_names_drop_before_drafts_and_never_block_restore_or_save() {
    // 1. Solid-valid 300-unit name survives decode, while malformed or >4096-unit names
    // drop only the optional projectName without rejecting tabs or drafts.
    let mut base_tab = workspace();
    base_tab.drafts.insert("ses_keep".into(), "keep me".into());
    let mut raw = value(&snapshot(base_tab));
    let long_solid = "n".repeat(300);
    raw["session"]["tabs"][0]["projectName"] = json!(long_solid);
    let restored = from_value(&raw).expect("300-unit Solid projectName restores");
    match &restored.tabs[0] {
        Tab::Workspace(w) => {
            assert_eq!(w.project_name.as_deref(), Some(long_solid.as_str()));
            assert_eq!(
                w.drafts.get("ses_keep").map(String::as_str),
                Some("keep me")
            );
        }
        other => panic!("expected workspace tab, got {other:?}"),
    }
    for bad in [
        json!("bad\nname"),
        json!("a".repeat(MAX_PROJECT_NAME + 1)),
        json!(42),
    ] {
        let mut mutated = raw.clone();
        mutated["session"]["tabs"][0]["projectName"] = bad;
        let decoded = from_value(&mutated).expect("bad optional projectName does not fail restore");
        match &decoded.tabs[0] {
            Tab::Workspace(w) => {
                assert_eq!(w.project_name, None);
                assert_eq!(
                    w.drafts.get("ses_keep").map(String::as_str),
                    Some("keep me")
                );
            }
            other => panic!("expected workspace tab, got {other:?}"),
        }
    }

    // 2. Near MAX_STRINGS, encode_for_save drops optional project names before evicting drafts.
    let mut tab_a = workspace();
    tab_a.project_name = Some("x".repeat(4000));
    tab_a.drafts.insert("s1".into(), "d".repeat(MAX_DRAFT));
    tab_a.drafts.insert("s2".into(), "d".repeat(MAX_DRAFT));
    let mut tab_b = workspace();
    tab_b.occurrence = 1;
    tab_b.project_name = Some("y".repeat(4000));
    tab_b
        .drafts
        .insert("s3".into(), "d".repeat(MAX_DRAFT - 1024));
    let near_limit = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(tab_a), Tab::Workspace(tab_b)],
        active: Some(0),
    };
    let (bytes, degraded) =
        save_snapshot::encode_for_save(&near_limit).expect("save succeeds by dropping names first");
    assert!(degraded);
    let saved = decode(&bytes).expect("saved snapshot decodes");
    let total_drafts: usize = saved
        .tabs
        .iter()
        .map(|tab| match tab {
            Tab::Workspace(w) => w.drafts.len(),
            Tab::Blank => 0,
        })
        .sum();
    assert_eq!(
        total_drafts, 3,
        "optional project names must never evict drafts"
    );

    // 3. Many tabs with max-size project names and zero drafts never fail encode_for_save or decode.
    let tabs: Vec<Tab> = (0..26)
        .map(|i| {
            let mut w = workspace();
            w.occurrence = i;
            w.project_name = Some("z".repeat(MAX_PROJECT_NAME));
            Tab::Workspace(w)
        })
        .collect();
    let many_names = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs,
        active: Some(0),
    };
    let (saved_bytes, _) =
        save_snapshot::encode_for_save(&many_names).expect("project names alone never fail save");
    let decoded = decode(&saved_bytes).expect("saved snapshot decodes");
    assert_eq!(decoded.tabs.len(), 26);
    assert!(
        decoded
            .tabs
            .iter()
            .all(|tab| matches!(tab, Tab::Workspace(_))),
        "no workspace tab should be degraded to Tab::Blank"
    );

    // 4. Untrimmed padded projectName (>4096 raw units) normalizes instead of turning tab into Blank.
    let mut padded = workspace();
    padded.project_name = Some(format!("{}x", " ".repeat(MAX_PROJECT_NAME)));
    padded.drafts.insert("ses_pad".into(), "keep draft".into());
    let (padded_bytes, _) =
        save_snapshot::encode_for_save(&snapshot(padded)).expect("padded name normalizes");
    let padded_decoded = decode(&padded_bytes).expect("padded snapshot decodes");
    match &padded_decoded.tabs[0] {
        Tab::Workspace(w) => {
            assert_eq!(w.project_name.as_deref(), Some("x"));
            assert_eq!(
                w.drafts.get("ses_pad").map(String::as_str),
                Some("keep draft")
            );
        }
        other => panic!("padded projectName must never blank tab, got {other:?}"),
    }

    // 5. Over MAX_BYTES (1 MiB JSON cap), fit_parts drops optional project names before trimming
    // pasted text from draft attachments.
    use crate::composer::draft_storage::SavedParts;
    let mut heavy_tab = workspace();
    heavy_tab.project_name = Some("p".repeat(MAX_PROJECT_NAME));
    for (index, size) in [255, 255, 255, 255].into_iter().enumerate() {
        let id = format!("ses_heavy_{index}");
        heavy_tab.drafts.insert(id.clone(), "[pasted #1]".into());
        heavy_tab.attachment_drafts.insert(id.clone());
        heavy_tab.attachment_parts.insert(
            id,
            SavedParts::decode(&json!({
                "complete": true,
                "parts": [
                    {"type":"pasted","id":"1","text":"x".repeat(size * 1024)}
                ]
            }))
            .unwrap(),
        );
    }
    let heavy_snap = snapshot(heavy_tab.clone());
    // With 4 × 255 KiB pastes (~1020 KiB) + 4 KiB projectName (> 1024 KiB), encode hits Limit.
    assert_eq!(encode(&heavy_snap).unwrap_err(), Error::Limit);
    let (heavy_bytes, degraded) =
        save_snapshot::encode_for_save(&heavy_snap).expect("drops name before paste");
    assert!(degraded);
    let heavy_saved = decode(&heavy_bytes).expect("heavy snapshot decodes");
    match &heavy_saved.tabs[0] {
        Tab::Workspace(w) => {
            assert_eq!(
                w.project_name, None,
                "optional projectName dropped for byte cap"
            );
            assert_eq!(
                w.attachment_parts, heavy_tab.attachment_parts,
                "draft pasted text must survive when dropping projectName suffices"
            );
        }
        other => panic!("expected workspace tab, got {other:?}"),
    }
}
