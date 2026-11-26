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
fn per_tab_draft_cap_preserves_long_active_and_priority_drafts_beyond_24() {
    let mut tab = workspace();
    let active_id = "ses_active_long".to_string();
    let active_text = "A".repeat(12_000);
    let no_session_text = "N".repeat(10_000);
    let recovered_id = format!("{RECOVERED_DRAFT_PREFIX}11111111-2222-4333-8444-555555555555");
    let recovered_text = "R".repeat(8_000);

    tab.active_session_id = Some(active_id.clone());
    tab.drafts.insert(active_id.clone(), active_text.clone());
    tab.drafts
        .insert(NO_SESSION_DRAFT_ID.into(), no_session_text.clone());
    tab.drafts
        .insert(recovered_id.clone(), recovered_text.clone());
    tab.attachment_drafts.insert(active_id.clone());
    tab.attachment_drafts.insert(NO_SESSION_DRAFT_ID.into());
    tab.attachment_drafts.insert(recovered_id.clone());

    for index in 0..MAX_DRAFTS {
        let id = format!("ses_inactive_{index:02}");
        // Make one inactive draft slightly longer than the other inactive drafts so we also verify tie-breaking.
        let text = if index == 5 {
            "x".repeat(400)
        } else {
            format!("short {index}")
        };
        tab.drafts.insert(id.clone(), text);
        tab.attachment_drafts.insert(id);
    }

    assert_eq!(tab.drafts.len(), MAX_DRAFTS + 3);
    assert_eq!(tab.attachment_drafts.len(), MAX_DRAFTS + 3);
    let full = snapshot(tab);
    assert_eq!(encode(&full).unwrap_err(), Error::Limit);

    let (bytes, partial) = encode_for_save(&full).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let [Tab::Workspace(saved)] = decoded.tabs.as_slice() else {
        panic!("expected workspace tab");
    };
    assert_eq!(saved.drafts.len(), MAX_DRAFTS);
    assert_eq!(saved.attachment_drafts.len(), MAX_DRAFTS);
    assert_eq!(saved.drafts.get(&active_id), Some(&active_text));
    assert_eq!(
        saved.drafts.get(NO_SESSION_DRAFT_ID),
        Some(&no_session_text)
    );
    assert_eq!(saved.drafts.get(&recovered_id), Some(&recovered_text));
    assert!(saved.attachment_drafts.contains(&active_id));
    assert!(saved.attachment_drafts.contains(NO_SESSION_DRAFT_ID));
    assert!(saved.attachment_drafts.contains(&recovered_id));
    // Longest non-priority draft was evicted first.
    assert!(!saved.drafts.contains_key("ses_inactive_05"));

    // Even when 24+ recovered drafts exist, active_session_id and __no_session_draft__ stay protected.
    let mut flooded = workspace();
    flooded.active_session_id = Some(active_id.clone());
    flooded
        .drafts
        .insert(active_id.clone(), active_text.clone());
    flooded
        .drafts
        .insert(NO_SESSION_DRAFT_ID.into(), no_session_text.clone());
    for index in 0..MAX_DRAFTS {
        let id = format!("{RECOVERED_DRAFT_PREFIX}00000000-0000-4000-8000-{index:012x}");
        flooded.drafts.insert(id, format!("recovered {index}"));
    }
    let (flood_bytes, flood_partial) = encode_for_save(&snapshot(flooded)).unwrap();
    assert!(flood_partial);
    let flood_decoded = decode(&flood_bytes).unwrap();
    let [Tab::Workspace(flood_saved)] = flood_decoded.tabs.as_slice() else {
        panic!("expected workspace tab");
    };
    assert_eq!(flood_saved.drafts.len(), MAX_DRAFTS);
    assert_eq!(flood_saved.drafts.get(&active_id), Some(&active_text));
    assert_eq!(
        flood_saved.drafts.get(NO_SESSION_DRAFT_ID),
        Some(&no_session_text)
    );
}

#[test]
fn draft_cap_sheds_mixed_bundles_atomically_without_stripping_attachment_markers() {
    use crate::composer::draft_storage::SavedParts;

    let parts = |label: &str| {
        SavedParts::decode(&json!({
            "complete": true,
            "parts": [{"type":"agent","name":label}]
        }))
        .unwrap()
    };

    // 24 priority attachment-only drafts + 1 ordinary mixed draft: the ordinary bundle is shed
    // completely (both text and attachments) so no text ever reopens without its attachment marker.
    let mut mixed = workspace();
    mixed.active_session_id = Some("ses_active_att".into());
    mixed.attachment_drafts.insert("ses_active_att".into());
    mixed
        .attachment_parts
        .insert("ses_active_att".into(), parts("active-agent"));
    mixed.attachment_drafts.insert(NO_SESSION_DRAFT_ID.into());
    mixed
        .attachment_parts
        .insert(NO_SESSION_DRAFT_ID.into(), parts("no-session-agent"));
    for index in 0..(MAX_DRAFTS - 2) {
        let id = format!("{RECOVERED_DRAFT_PREFIX}00000000-0000-4000-8000-{index:012x}");
        mixed.attachment_drafts.insert(id.clone());
        mixed
            .attachment_parts
            .insert(id, parts(&format!("rec-{index}")));
    }
    mixed
        .drafts
        .insert("ses_ordinary_mixed".into(), "has attachment".into());
    mixed.attachment_drafts.insert("ses_ordinary_mixed".into());
    mixed
        .attachment_parts
        .insert("ses_ordinary_mixed".into(), parts("ordinary-agent"));

    let (bytes, partial) = encode_for_save(&snapshot(mixed)).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let [Tab::Workspace(saved)] = decoded.tabs.as_slice() else {
        panic!("expected workspace tab");
    };
    assert_eq!(saved.attachment_drafts.len(), MAX_DRAFTS);
    assert!(!saved.drafts.contains_key("ses_ordinary_mixed"));
    assert!(!saved.attachment_drafts.contains("ses_ordinary_mixed"));
    assert!(!saved.attachment_parts.contains_key("ses_ordinary_mixed"));
    assert_eq!(
        saved.attachment_parts.get("ses_active_att"),
        Some(&parts("active-agent"))
    );
    assert_eq!(
        saved.attachment_parts.get(NO_SESSION_DRAFT_ID),
        Some(&parts("no-session-agent"))
    );

    // Symmetric text-cap direction: 24 priority text drafts + 1 ordinary mixed draft.
    // Evicting the ordinary mixed draft removes text, attachment marker, and parts together.
    let mut text_cap = workspace();
    text_cap.active_session_id = Some("ses_active_txt".into());
    text_cap
        .drafts
        .insert("ses_active_txt".into(), "active".into());
    text_cap
        .drafts
        .insert(NO_SESSION_DRAFT_ID.into(), "no-session".into());
    for index in 0..(MAX_DRAFTS - 2) {
        let id = format!("{RECOVERED_DRAFT_PREFIX}00000000-0000-4000-8000-{index:012x}");
        text_cap.drafts.insert(id, format!("rec {index}"));
    }
    text_cap
        .drafts
        .insert("ses_ordinary_mixed".into(), "text + attachment".into());
    text_cap
        .attachment_drafts
        .insert("ses_ordinary_mixed".into());
    text_cap
        .attachment_parts
        .insert("ses_ordinary_mixed".into(), parts("ordinary-agent"));
    let (bytes, partial) = encode_for_save(&snapshot(text_cap)).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let [Tab::Workspace(saved)] = decoded.tabs.as_slice() else {
        panic!("expected workspace tab");
    };
    assert_eq!(saved.drafts.len(), MAX_DRAFTS);
    assert!(!saved.drafts.contains_key("ses_ordinary_mixed"));
    assert!(!saved.attachment_drafts.contains("ses_ordinary_mixed"));
    assert!(!saved.attachment_parts.contains_key("ses_ordinary_mixed"));
}

#[test]
fn global_text_and_byte_budgets_preserve_distinct_priority_ranks_in_active_tab() {
    use crate::composer::draft_storage::SavedParts;

    // Under global UTF-16 pressure (MAX_STRINGS = 96 KiB), every draft is valid (<= MAX_DRAFT = 32 KiB)
    // and the excess (~300 units) is smaller than active_id (4,500) so a flat tier would sacrifice
    // active_id instead of the larger 32,000-unit __recovered_draft__.
    let mut text_tab = workspace();
    let active_id = "ses_active_small".to_string();
    let recovered_1 = format!("{RECOVERED_DRAFT_PREFIX}12345678-1234-4234-8234-123456789abc");
    let recovered_2 = format!("{RECOVERED_DRAFT_PREFIX}22345678-1234-4234-8234-123456789abc");
    text_tab.active_session_id = Some(active_id.clone());
    text_tab.drafts.insert(active_id.clone(), "a".repeat(4_500));
    text_tab
        .drafts
        .insert(NO_SESSION_DRAFT_ID.into(), "n".repeat(30_000));
    text_tab
        .drafts
        .insert(recovered_1.clone(), "r".repeat(32_000));
    text_tab
        .drafts
        .insert(recovered_2.clone(), "r".repeat(32_000));
    let snap = snapshot(text_tab);
    assert_eq!(encode(&snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let Tab::Workspace(saved) = &decoded.tabs[0] else {
        panic!("expected active workspace tab");
    };
    assert_eq!(saved.drafts.get(&active_id).map(String::len), Some(4_500));
    assert_eq!(
        saved.drafts.get(NO_SESSION_DRAFT_ID).map(String::len),
        Some(30_000)
    );
    assert!(
        !saved.drafts.contains_key(&recovered_1) || !saved.drafts.contains_key(&recovered_2),
        "a recovered draft must be shed before active_session_id or __no_session_draft__"
    );
    // Verify original snapshot was not mutated.
    assert!(
        matches!(&snap.tabs[0], Tab::Workspace(orig) if orig.drafts.contains_key(&recovered_1) && orig.drafts.contains_key(&recovered_2))
    );

    // Under global JSON byte pressure (MAX_BYTES = 1 MiB), active_id (120 KiB) is SMALLER than
    // every recovered payload (200/255 KiB) while total exceeds 1 MiB by ~37 KiB, so a flat tier
    // would sacrifice active_id; distinct ranks must keep active_id and __no_session_draft__ intact.
    let pasted = |kb: usize| {
        SavedParts::decode(&json!({
            "complete": true,
            "parts": [
                {"type":"pasted","id":"1","text":"p".repeat(kb * 1024)},
                {"type":"agent","name":"reviewer"}
            ]
        }))
        .unwrap()
    };
    let recovered_3 = format!("{RECOVERED_DRAFT_PREFIX}32345678-1234-4234-8234-123456789abc");
    let mut byte_tab = workspace();
    byte_tab.active_session_id = Some(active_id.clone());
    for (id, kb) in [
        (active_id.clone(), 120),
        (NO_SESSION_DRAFT_ID.to_string(), 255),
        (recovered_1.clone(), 255),
        (recovered_2.clone(), 255),
        (recovered_3.clone(), 200),
    ] {
        byte_tab.drafts.insert(id.clone(), "[pasted #1]".into());
        byte_tab.attachment_drafts.insert(id.clone());
        byte_tab.attachment_parts.insert(id, pasted(kb));
    }
    let byte_snap = snapshot(byte_tab);
    assert_eq!(encode(&byte_snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&byte_snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let [Tab::Workspace(saved)] = decoded.tabs.as_slice() else {
        panic!("expected workspace tab");
    };
    assert_eq!(saved.attachment_parts.get(&active_id), Some(&pasted(120)));
    assert_eq!(
        saved.attachment_parts.get(NO_SESSION_DRAFT_ID),
        Some(&pasted(255))
    );
    assert_ne!(
        saved.attachment_parts.get(&recovered_3),
        Some(&pasted(200)),
        "recovered payload must be trimmed before smaller active_session_id payload"
    );
    assert!(saved.attachment_drafts.contains(&recovered_3));

    // When shedding recovered drafts alone cannot satisfy UTF-16 budget, __no_session_draft__
    // (tier 5, larger) MUST yield before active_session_id (tier 6, smaller).
    let mut tier_tabs = Vec::new();
    let mut active_tab = workspace();
    active_tab.active_session_id = Some(active_id.clone());
    active_tab
        .drafts
        .insert(active_id.clone(), "a".repeat(20_000));
    active_tab
        .drafts
        .insert(NO_SESSION_DRAFT_ID.into(), "n".repeat(32_000));
    active_tab
        .drafts
        .insert(recovered_1.clone(), "r".repeat(10_000));
    tier_tabs.push(Tab::Workspace(active_tab));
    for i in 0..14 {
        let mut filler = workspace();
        filler.folder = format!("/f{i}/{}", "x".repeat(3_990));
        tier_tabs.push(Tab::Workspace(filler));
    }
    let tier_snap = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: tier_tabs,
        active: Some(0),
    };
    assert_eq!(encode(&tier_snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&tier_snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let Tab::Workspace(saved) = &decoded.tabs[0] else {
        panic!("expected active workspace tab");
    };
    assert_eq!(
        saved.drafts.get(&active_id).map(String::len),
        Some(20_000),
        "active_session_id must survive when __no_session_draft__ can yield"
    );
    assert!(
        !saved.drafts.contains_key(NO_SESSION_DRAFT_ID),
        "__no_session_draft__ must yield before smaller active_session_id under UTF-16 pressure"
    );

    // Same distinction under global JSON byte pressure: escaped text fills ~576 KB of
    // non-sheddable bytes while recovered_1 (40 KiB) cannot cover ~55 KiB excess, so
    // __no_session_draft__ (255 KiB) must yield before smaller active_session_id (220 KiB).
    let mut byte_tier_tabs = Vec::new();
    let mut active_byte_tab = workspace();
    active_byte_tab.active_session_id = Some(active_id.clone());
    for (id, kb) in [
        (active_id.clone(), 220),
        (NO_SESSION_DRAFT_ID.to_string(), 255),
        (recovered_1.clone(), 40),
    ] {
        active_byte_tab
            .drafts
            .insert(id.clone(), "[pasted #1]".into());
        active_byte_tab.attachment_drafts.insert(id.clone());
        active_byte_tab.attachment_parts.insert(id, pasted(kb));
    }
    byte_tier_tabs.push(Tab::Workspace(active_byte_tab));
    for i in 0..3 {
        let mut filler = workspace();
        filler.folder = format!("/byte-filler-{i}");
        filler
            .drafts
            .insert(format!("pad_{i}"), "\u{0001}".repeat(31_500));
        byte_tier_tabs.push(Tab::Workspace(filler));
    }
    let byte_tier_snap = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: byte_tier_tabs,
        active: Some(0),
    };
    assert_eq!(encode(&byte_tier_snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&byte_tier_snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let Tab::Workspace(saved) = &decoded.tabs[0] else {
        panic!("expected active workspace tab");
    };
    assert_eq!(
        saved.attachment_parts.get(&active_id),
        Some(&pasted(220)),
        "active_session_id payload must survive when __no_session_draft__ can yield"
    );
    assert_ne!(
        saved.attachment_parts.get(NO_SESSION_DRAFT_ID),
        Some(&pasted(255)),
        "__no_session_draft__ payload must yield before smaller active_session_id payload"
    );
}

#[test]
fn utf16_budget_sheds_attachment_only_markers_before_priority_text_and_without_limit_error() {
    // 1. Ordinary attachment-only markers absorb a small UTF-16 overflow so priority active text survives.
    let mut tabs = Vec::new();
    let mut tab = workspace();
    tab.active_session_id = Some("ses_active".into());
    tab.drafts.insert("ses_active".into(), "a".repeat(26_000));
    tab.attachment_drafts
        .insert("ses_ordinary_attachment_only_marker_with_long_id_01".into());
    tab.attachment_drafts
        .insert("ses_ordinary_attachment_only_marker_with_long_id_02".into());
    tabs.push(Tab::Workspace(tab));
    // Fill remaining UTF-16 budget with non-sheddable folder paths so total exceeds MAX_STRINGS (98_304) by ~57 units
    // (smaller than the two 51-unit ordinary attachment-only markers).
    for i in 0..18 {
        let mut filler = workspace();
        filler.folder = format!("/m{i:02}/{}", "p".repeat(4_008));
        tabs.push(Tab::Workspace(filler));
    }
    let snap = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs,
        active: Some(0),
    };
    assert_eq!(encode(&snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let Tab::Workspace(saved) = &decoded.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        saved.drafts.get("ses_active").map(String::len),
        Some(26_000),
        "priority active text must survive when ordinary attachment-only markers cover UTF-16 excess"
    );
    assert!(saved.attachment_drafts.len() < 2);

    // 2. Attachment-only UTF-16 overflow (zero text drafts) sheds attachment markers instead of returning Limit.
    let mut marker_only_tabs = Vec::new();
    let mut marker_tab = workspace();
    marker_tab.active_session_id = Some("ses_keep".into());
    marker_tab.attachment_drafts.insert("ses_keep".into());
    for i in 0..10 {
        marker_tab
            .attachment_drafts
            .insert(format!("ses_drop_marker_{i:02}_{}", "k".repeat(120)));
    }
    marker_only_tabs.push(Tab::Workspace(marker_tab));
    for i in 0..24 {
        let mut filler = workspace();
        filler.folder = format!("/n{i:02}/{}", "q".repeat(4_080));
        marker_only_tabs.push(Tab::Workspace(filler));
    }
    let marker_snap = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: marker_only_tabs,
        active: Some(0),
    };
    assert_eq!(encode(&marker_snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&marker_snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let Tab::Workspace(saved) = &decoded.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert!(saved.attachment_drafts.contains("ses_keep"));
    assert!(saved.attachment_drafts.len() < 11);

    // 3. Ordinary mixed bundle (100-unit key + 1-unit text + 100-unit attachment key = 201 units)
    // must be shed as a whole bundle at tier 0 before escalating to sacrifice active_session_id text.
    let mut mixed_tabs = Vec::new();
    let mut mixed_tab = workspace();
    mixed_tab.active_session_id = Some("ses_active_mixed_keep".into());
    mixed_tab
        .drafts
        .insert("ses_active_mixed_keep".into(), "a".repeat(26_000));
    let long_ord = format!("ses_ord_{}", "x".repeat(92));
    assert_eq!(long_ord.len(), 100);
    mixed_tab.drafts.insert(long_ord.clone(), "z".into());
    mixed_tab.attachment_drafts.insert(long_ord.clone());
    mixed_tabs.push(Tab::Workspace(mixed_tab));
    // Fill non-sheddable folders so total exceeds MAX_STRINGS (98_304) by ~150 units:
    // tab0 = "/repo"(5) + active_id(21) + active_key(21) + 26_000 + 100 + 1 + 100 = 26_248.
    // 18 * (5 + 4_006) = 72_198 -> total = 98_446 -> excess = 142 (101 < 142 <= 201).
    for i in 0..18 {
        let mut filler = workspace();
        filler.folder = format!("/x{i:02}/{}", "m".repeat(4_006));
        mixed_tabs.push(Tab::Workspace(filler));
    }
    let mixed_snap = Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: mixed_tabs,
        active: Some(0),
    };
    assert_eq!(encode(&mixed_snap), Err(Error::Limit));
    let (bytes, partial) = encode_for_save(&mixed_snap).unwrap();
    assert!(partial);
    let decoded = decode(&bytes).unwrap();
    let Tab::Workspace(saved) = &decoded.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        saved.drafts.get("ses_active_mixed_keep").map(String::len),
        Some(26_000),
        "active text must survive when tier-0 whole mixed bundle covers the UTF-16 overflow"
    );
    assert!(!saved.drafts.contains_key(&long_ord));
    assert!(!saved.attachment_drafts.contains(&long_ord));
}
