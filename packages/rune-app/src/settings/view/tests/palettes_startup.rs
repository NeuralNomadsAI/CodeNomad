use super::*;
use crate::workspace::Ui;
use std::time::Duration;

fn click_key(runtime: &mut Runtime<Window>, key: &str) {
    let (x, y) = runtime
        .find(key)
        .unwrap_or_else(|| panic!("missing element key {key}"));
    runtime.pointer_down(x, y);
    runtime.pointer_up(x, y);
    runtime.frame(0.02);
}

fn press(runtime: &mut Runtime<Window>, key: rune::Key) {
    runtime.key(rune::KeyEvent {
        key,
        mods: rune::Mods::default(),
    });
    runtime.frame(0.02);
}

#[test]
fn custom_palette_swatches_editor_new_preset_and_dirty_guards() {
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend = Some(
            crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
                .unwrap(),
        );
    }
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(true, 1.0));
    runtime.frame(0.0);

    // All 13 swatches render with accessible "<palette> · <field> · <#HEX>" labels.
    let tree = runtime.accessibility_json();
    let accent_swatch = node(&tree, "palette-swatch-accentPrimary").unwrap();
    let name = accent_swatch["name"].as_str().unwrap();
    assert!(name.contains("Classic") && name.contains("Accent") && name.contains("#4D7AFE"));
    assert!(node(&tree, "palette-new").is_some());
    assert!(node(&tree, "palette-save").is_none());

    // Opening a swatch shows the color editor dialog; editing hex marks dirty & previews live.
    click_key(&mut runtime, "palette-swatch-accentPrimary");
    let tree = runtime.accessibility_json();
    assert!(node(&tree, "palette-color-editor").is_some());
    assert!(node(&tree, "palette-color-hex").is_some());

    // Click New -> opens name editor pre-filled with "Classic 2", marks dirty, shows Save.
    press(&mut runtime, rune::Key::Escape);
    click_key(&mut runtime, "palette-new");
    let tree = runtime.accessibility_json();
    assert!(node(&tree, "palette-name-input").is_some());
    assert!(node(&tree, "palette-save").is_some());
    assert!(runtime.state.general.dirty());

    // Switching section while dirty opens discard confirmation; Cancel keeps General + draft.
    click_key(&mut runtime, "settings-conversation");
    let tree = runtime.accessibility_json();
    let expected = crate::strings::with_locale(
        runtime
            .state
            .shared
            .borrow()
            .locale()
            .unwrap_or_else(crate::strings::locale),
        || t("settings.configFiles.confirmDiscard.message"),
    );
    assert!(tree.to_string().contains(expected), "{tree}");
    assert_eq!(runtime.state.section, Section::General);

    // Confirming discard switches section and clears dirty draft.
    click_key(&mut runtime, "file-decision-confirm");
    assert_eq!(runtime.state.section, Section::Conversation);
    assert!(!runtime.state.general.dirty());
}

#[test]
fn palette_workbench_stacks_cleanly_at_narrow_width() {
    let state = Window::default();
    state.shared.borrow_mut().fixture();
    let mut runtime = Runtime::new(state, view, (760.0, 560.0), Env::new(false, 1.0));
    runtime.frame(0.0);
    runtime.frame(0.02);
    let swatches: Vec<_> = runtime
        .elements()
        .into_iter()
        .filter(|el| {
            el.key
                .as_deref()
                .is_some_and(|k| k.starts_with("palette-swatch-"))
        })
        .collect();
    assert_eq!(swatches.len(), 13);
    for swatch in &swatches {
        assert!(
            swatch.rect[0] + swatch.rect[2] <= 760.5,
            "swatch overflowed narrow window: {swatch:?}"
        );
    }
}

#[test]
fn startup_state_card_renders_and_controls_native_persistence() {
    let parent = std::env::temp_dir().join(codenomad_client::http::client_id().unwrap());
    std::fs::create_dir(&parent).unwrap();
    let root = parent.join("rune");
    let store =
        crate::platform::block_on(crate::platform::storage::Store::open(root.clone())).unwrap();
    crate::platform::block_on(store.save(b"{\"revision\":1,\"savedAt\":1,\"tabs\":[]}".to_vec()))
        .unwrap();
    store.save_file_drafts(b"[]").unwrap();
    crate::platform::block_on(store.save_outlines(b"{}".to_vec())).unwrap();
    assert!(root.join("state.json").exists());
    assert!(root.join("workspace-file-drafts.json").exists());
    assert!(root.join("outlines-v1.json").exists());

    // Wire a main window State with primary store & poll StartupState commands.
    let mut app = crate::init();
    let mut ui = Ui::new();
    ui.fixture_primary_store(store.clone());
    app.workspace = Some(ui);
    let mut rt = Runtime::new(app, |_, _| rune::el(), (100.0, 100.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    assert!(rt.state.settings.shared.borrow().startup.is_primary());
    assert!(rt.state.settings.shared.borrow().startup.restore_enabled());

    // Render Preferences General view and verify Startup State card controls are enabled.
    let prefs_win = Window::new(rt.state.settings.shared.clone(), Rc::new(Cell::new(false)));
    prefs_win.shared.borrow_mut().fixture();
    let mut pref_rt = Runtime::new(prefs_win, view, chrome::WINDOW_SIZE, Env::new(false, 1.0));
    pref_rt.poll = super::lifecycle::spec().poll;
    pref_rt.frame(0.0);
    let tree = pref_rt.accessibility_json();
    assert!(node(&tree, "startup-state-settings").is_some());
    assert!(node(&tree, "startup-restore-switch").is_some());
    assert!(node(&tree, "startup-clear-button").is_some());

    // Clear saved startup state via Preferences button -> deletes disk files and emits toast.
    click_key(&mut pref_rt, "startup-clear-button");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while root.join("state.json").exists() || rt.state.settings.shared.borrow().startup.busy() {
        rt.frame(0.02);
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!root.join("state.json").exists());
    assert!(!root.join("workspace-file-drafts.json").exists());
    assert!(!root.join("outlines-v1.json").exists());
    pref_rt.frame(0.02);
    assert!(
        node(&pref_rt.accessibility_json(), "startup-state-feedback").is_some(),
        "Clear feedback must render directly inside the Preferences window"
    );

    // Disable restore via switch -> writes restore-enabled.json = false and suppresses future saves.
    pref_rt.frame(0.02);
    click_key(&mut pref_rt, "startup-restore-switch");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while rt.state.settings.shared.borrow().startup.restore_enabled()
        || rt.state.settings.shared.borrow().startup.busy()
    {
        rt.frame(0.02);
        assert!(
            std::time::Instant::now() < deadline,
            "restore={} busy={} primary={} switch={:?} clear={:?}",
            rt.state.settings.shared.borrow().startup.restore_enabled(),
            rt.state.settings.shared.borrow().startup.busy(),
            rt.state.settings.shared.borrow().startup.is_primary(),
            pref_rt.find("startup-restore-switch"),
            pref_rt.find("startup-clear-button"),
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!rt.state.workspace.as_ref().unwrap().restore_enabled());
    assert!(!crate::platform::block_on(store.restore_enabled()).unwrap());

    // Normal quit after Clear (even if Restore is re-enabled then cleared) never rewrites state.json.
    pref_rt.frame(0.02);
    click_key(&mut pref_rt, "startup-restore-switch");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !rt.state.settings.shared.borrow().startup.restore_enabled()
        || rt.state.settings.shared.borrow().startup.busy()
    {
        rt.frame(0.02);
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    // Insert a live file draft before Clear, clear, then exit without further edits:
    // state.json stays absent while the live unsaved file draft is flushed on exit instead of lost.
    rt.state.documents.insert_test_file_draft("a.rs", "draft");
    pref_rt.frame(0.02);
    click_key(&mut pref_rt, "startup-clear-button");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while rt.state.settings.shared.borrow().startup.busy() {
        rt.frame(0.02);
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!root.join("state.json").exists());
    assert!(
        !root.join("workspace-file-drafts.json").exists(),
        "Clear must leave workspace-file-drafts.json absent while idle"
    );
    rt.update(|s, tx| crate::workspace::finish(s, tx));
    assert!(
        !root.join("state.json").exists(),
        "normal quit after Clear must not rewrite cleared snapshot"
    );
    let flushed_drafts = std::fs::read_to_string(root.join("workspace-file-drafts.json"))
        .expect("active unsaved file draft must flush on exit after Clear");
    assert!(
        flushed_drafts.contains("a.rs") && flushed_drafts.contains("draft"),
        "expected flushed active draft in {flushed_drafts}"
    );

    // Pre-Clear save future admitted BEFORE Clear and polled AFTER Clear cannot recreate files.
    let stale_state_write =
        store.start_save(b"{\"revision\":9,\"savedAt\":9,\"tabs\":[]}".to_vec());
    let stale_outlines_write = store.start_save_outlines(b"{}".to_vec());
    let outcome = crate::platform::block_on(store.clear_startup_state()).unwrap();
    assert!(outcome.all_ok());
    crate::platform::block_on(stale_state_write).unwrap();
    crate::platform::block_on(stale_outlines_write).unwrap();
    assert!(!root.join("state.json").exists());
    assert!(!root.join("outlines-v1.json").exists());

    // Re-enabling Restore purges leftover files left on disk while disabled before publishing true.
    assert!(crate::platform::block_on(store.set_restore_enabled(false)).unwrap());
    std::fs::write(root.join("workspace-file-drafts.json"), b"[[\"stale\"]]").unwrap();
    assert!(crate::platform::block_on(store.set_restore_enabled(true)).unwrap());
    assert!(
        !root.join("workspace-file-drafts.json").exists(),
        "re-enabling Restore must purge leftover files before publishing true"
    );

    // Malformed restore-enabled.json is treated as Unknown (read error): enabling Restore
    // through the Preferences UI repairs the marker AND reloads existing state.json instead of
    // overwriting it with an empty window.
    let saved_json = crate::workspace::encode(&crate::workspace::Snapshot {
        revision: 7,
        saved_at: 42,
        panel_widths: [None, None],
        file_wrap: None,
        tabs: vec![crate::workspace::Tab::Blank],
        active: Some(0),
    })
    .unwrap();
    std::fs::write(root.join("state.json"), &saved_json).unwrap();
    std::fs::write(root.join("restore-enabled.json"), b"{bad json").unwrap();
    assert!(crate::platform::block_on(store.restore_enabled()).is_err());
    rt.state
        .workspace
        .as_mut()
        .unwrap()
        .fixture_unreadable_restore();
    rt.frame(0.02);
    pref_rt.frame(0.02);
    click_key(&mut pref_rt, "startup-restore-switch");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !rt.state.settings.shared.borrow().startup.restore_enabled()
        || rt.state.settings.shared.borrow().startup.busy()
        || rt.state.workspace.as_ref().unwrap().persistence_loading()
    {
        rt.frame(0.02);
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().workspace_revision(),
        7,
        "re-enabling Restore from unreadable marker must reload existing state instead of overwriting it"
    );
    assert!(
        std::fs::read(root.join("state.json"))
            .unwrap()
            .windows(12)
            .any(|w| w == br#""revision":7"#)
    );

    // Unopened restored file drafts are dropped on Clear without altering active editors.
    let docs = crate::files::document::store::Store::default();
    let hydrated = serde_json::json!([[
        "installation",
        "/project",
        "/project",
        "unopened.rs",
        null,
        "stale restored text",
        null
    ]])
    .to_string();
    assert!(docs.hydrate_file_drafts(hydrated.as_bytes()));
    assert!(docs.file_draft_snapshot(0).is_none());
    docs.discard_unopened_saved_drafts();
    docs.insert_test_file_draft("active.rs", "live edit");
    let (_, bytes) = docs.file_draft_snapshot(0).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("active.rs"));
    assert!(
        !text.contains("unopened.rs"),
        "cleared unopened restored draft must not be re-encoded: {text}"
    );

    drop(pref_rt);
    drop(rt);
    drop(store);
    std::fs::remove_dir_all(parent).unwrap();
}

#[test]
fn delete_confirmation_dialog_labels_question_and_buttons_correctly() {
    let state = Window::default();
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        let colors = rune_theme_codenomad::palettes::ColorSchemeColors::default_custom().to_json();
        prefs.fixture_state(serde_json::json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": { "id": "custom", "appearance": "dark", "colors": colors },
                    "presetId": "p1"
                }
            },
            "activeColorSchemePresetId": "p1",
            "colorSchemePresets": {
                "p1": { "name": "Midnight", "appearance": "dark", "colors": colors }
            }
        }));
    }
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(true, 1.0));
    runtime.frame(0.0);
    click_key(&mut runtime, "palette-delete");
    let tree = runtime.accessibility_json();
    let confirm = node(&tree, "file-decision-confirm").expect("confirm button");
    let cancel = node(&tree, "file-decision-cancel").expect("cancel button");
    assert_eq!(confirm["name"].as_str(), Some("Delete"));
    assert_eq!(cancel["name"].as_str(), Some("Cancel"));
    assert!(
        tree.to_string().contains("Midnight"),
        "dialog message must contain preset name: {tree}"
    );
}

#[test]
fn dirty_legacy_custom_draft_stays_custom_when_remote_window_switches_away() {
    let request = Rc::new(CloseRequest::default());
    let state = Window::new(
        Rc::new(RefCell::new(Preferences::default())),
        Rc::new(Cell::new(false)),
    )
    .with_close_request(request.clone(), None);
    {
        let mut prefs = state.shared.borrow_mut();
        prefs.fixture();
        prefs.backend = Some(
            crate::platform::block_on(crate::backend::Backend::connect("http://127.0.0.1:9/", ""))
                .unwrap(),
        );
        let default_custom =
            rune_theme_codenomad::palettes::ColorSchemeColors::default_custom().to_json();
        prefs.fixture_state(serde_json::json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": {
                    "scheme": { "id": "custom", "appearance": "dark", "colors": default_custom },
                    "presetId": null
                }
            }
        }));
    }
    let mut runtime = Runtime::new(state, view, chrome::WINDOW_SIZE, Env::new(true, 1.0));
    runtime.frame(0.0);
    assert!(!request.guard_close.get());

    // Edit Accent on default dark custom -> marks dirty and arms main-window close guard.
    click_key(&mut runtime, "palette-swatch-accentPrimary");
    click_key(&mut runtime, "palette-color-hex");
    press(&mut runtime, rune::Key::End);
    for _ in 0..10 {
        press(&mut runtime, rune::Key::Backspace);
    }
    runtime.paste("#FF00AA");
    runtime.frame(0.02);
    assert!(runtime.state.general.dirty());
    assert!(request.guard_close.get());
    press(&mut runtime, rune::Key::Escape);

    // Another window switches dark slot to Slate -> "builtin:custom" drops out of palette_options.
    runtime
        .state
        .shared
        .borrow_mut()
        .fixture_state(serde_json::json!({
            "appearancePreferences": {
                "mode": "dark",
                "dark": { "scheme": { "id": "slate", "appearance": "dark", "colors": null }, "presetId": null }
            }
        }));
    runtime.frame(0.02);

    // Editing another swatch must NOT rebind the dirty draft to Mist (first built-in).
    click_key(&mut runtime, "palette-swatch-surfaceBase");
    click_key(&mut runtime, "palette-color-hex");
    press(&mut runtime, rune::Key::End);
    for _ in 0..10 {
        press(&mut runtime, rune::Key::Backspace);
    }
    runtime.paste("#111319");
    runtime.frame(0.02);
    press(&mut runtime, rune::Key::Escape);
    let tree = runtime.accessibility_json();
    let accent = node(&tree, "palette-swatch-accentPrimary").unwrap();
    let label = accent["name"].as_str().unwrap();
    assert!(
        !label.contains("Mist"),
        "legacy custom draft must not fall back to Mist: {label}"
    );
    click_key(&mut runtime, "palette-save");
    assert!(
        runtime.state.shared.borrow().palette_saving(),
        "Save must dispatch SaveCustom even after legacy custom left options"
    );
}
