use super::*;
use crate::settings::{providers::Target, view};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

pub(super) fn make_window(
    prefs: Preferences,
) -> (Rc<RefCell<Preferences>>, rune::Runtime<view::Window>) {
    let root = crate::init();
    let shared = root.settings.shared.clone();
    *shared.borrow_mut() = prefs;
    shared.borrow_mut().window_wake = Some(Arc::new(|| {}));
    let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
    let rt = rune::Runtime::new(
        window,
        view::view,
        (1100.0, 760.0),
        rune::Env::new(false, 1.0),
    );
    (shared, rt)
}

pub(super) fn click(rt: &mut rune::Runtime<view::Window>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
}

pub(super) fn tick(rt: &mut rune::Runtime<view::Window>) {
    rt.update(|s, tx| {
        view::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
}

pub(super) async fn settle_meta(listener: &TcpListener, rt: &mut rune::Runtime<view::Window>) {
    tick(rt);
    let meta = request(listener).await;
    assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
    meta.reply(200, json!({"capabilities":[]})).await;
    tick(rt);
}

pub(super) async fn next_request(
    listener: &TcpListener,
    rt: &mut rune::Runtime<view::Window>,
) -> Request {
    timeout(Duration::from_secs(5), async {
        loop {
            tick(rt);
            if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                let (socket, _) = accepted.unwrap();
                return read_request(socket, Duration::from_secs(3)).await;
            }
        }
    })
    .await
    .expect("timed out waiting for expected missions HTTP request")
}

pub(super) fn click_option(rt: &mut rune::Runtime<view::Window>, prefix: &str, text: &str) {
    let key = rt.elements().into_iter().find_map(|el| {
        let key = el.key?;
        (key.starts_with(prefix) && key != format!("{prefix}-trigger")).then_some(key)
    });
    let _ = key;
    let a11y = rt.accessibility_json();
    fn find_by_name(node: &serde_json::Value, name: &str) -> Option<String> {
        if node["role"] == "list-box-option" && node["name"] == name {
            return node["key"].as_str().map(str::to_owned);
        }
        node["children"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|child| find_by_name(child, name))
    }
    let key = find_by_name(&a11y, text)
        .unwrap_or_else(|| panic!("missing option {text:?} for {prefix} in {a11y}"));
    click(rt, &key);
}

#[test]
fn missions_without_project_context_makes_no_project_reads_and_persists_global_defaults() {
    platform::block_on(async {
        let (listener, prefs) = fixture().await;
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;

        // Staying on General issues no project/catalog/depth requests.
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );

        // Switching to Missions without a captured project makes no catalog or depth requests.
        click(&mut rt, "settings-missions");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );

        // Toggling missionDeleteSessions sends a conditional missions-v1 PATCH.
        click(&mut rt, "mission-delete-sessions");
        tick(&mut rt);
        let patch = request(&listener).await;
        assert_eq!(
            patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        assert_eq!(
            patch.body,
            json!({
                "patch": { "settings": { "missionDeleteSessions": true } },
                "expected": [{ "key": "missionDeleteSessions", "present": false }]
            })
        );
        patch
            .reply(
                200,
                json!({"settings": {"locale": "en", "missionDeleteSessions": true}}),
            )
            .await;
        let confirm_read = next_request(&listener, &mut rt).await;
        assert_eq!(
            confirm_read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        confirm_read
            .reply(
                200,
                json!({"settings": {"locale": "en", "missionDeleteSessions": true}}),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            shared
                .borrow()
                .saved(Owner::Config)
                .is_some_and(|doc| doc["settings"]["missionDeleteSessions"] == true)
        })
        .await;

        // Changing Task sessions to Independent sends conditional PATCH and handles 409 conflict
        // by reloading read-only without replaying the write.
        click(&mut rt, "mission-task-mode-trigger");
        click_option(&mut rt, "mission-task-mode", "Independent sessions");
        tick(&mut rt);
        let mode_patch = request(&listener).await;
        assert_eq!(
            mode_patch.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        assert_eq!(
            mode_patch.body["patch"]["settings"]["missionProfileDefaults"][0]["taskMode"],
            "independent"
        );
        mode_patch.reply(409, json!({"error": "conflict"})).await;

        let reload = next_request(&listener, &mut rt).await;
        assert!(reload.first.starts_with("GET /api/storage/config/ui?"));
        reload
            .reply(
                200,
                json!({
                    "settings": {
                        "locale": "en",
                        "missionDeleteSessions": true,
                        "missionProfileDefaults": []
                    }
                }),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json()
                .to_string()
                .contains("Your choice was not saved")
        })
        .await;
        // Never replays the conflicted PATCH.
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn missions_loads_catalog_and_depth_lazily_and_handles_save_unsupported_and_disconnect() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        backend.session = "session".into();
        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);
        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;

        // No requests before entering the Missions tab.
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );

        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Location resolves once and is shared by both catalog (agent/model/provider) and depth.
        let mut got_location = 0usize;
        let mut got_agent = false;
        let mut got_model = false;
        let mut got_provider = false;
        let mut got_depth = false;
        let expectation = "a".repeat(64);
        while !(got_agent && got_model && got_provider && got_depth) {
            let req = request(&listener).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/workspaces/captured/instance/api/session/session" {
                got_location += 1;
                req.reply(
                    200,
                    json!({"data":{"id":"session","location":{"directory":"C:/fixture-linked"}}}),
                )
                .await;
                wait_until(|| {
                    tick(&mut rt);
                    shared.borrow().missions.pinned_directory().is_some()
                })
                .await;
            } else if url.starts_with("/workspaces/captured/instance/api/agent?") {
                got_agent = true;
                req.reply(
                    200,
                    json!({
                        "location":{"directory":"C:/fixture-linked"},
                        "data":[
                            {"id":"planner","mode":"primary"},
                            {"id":"worker","mode":"subagent"}
                        ]
                    }),
                )
                .await;
            } else if url.starts_with("/workspaces/captured/instance/api/model?") {
                got_model = true;
                req.reply(
                    200,
                    json!({
                        "location":{"directory":"C:/fixture-linked"},
                        "data":[{
                            "providerID":"acme","id":"pro","name":"Acme Pro",
                            "enabled":true,"status":"active",
                            "capabilities":{"tools":true},
                            "variants":[{"id":"high"}]
                        }]
                    }),
                )
                .await;
            } else if url.starts_with("/workspaces/captured/instance/api/provider?") {
                got_provider = true;
                req.reply(
                    200,
                    json!({
                        "location":{"directory":"C:/fixture-linked"},
                        "data":[{"id":"acme","name":"Acme"}]
                    }),
                )
                .await;
            } else if url
                == "/api/workspaces/captured/subagent-depth?directory=C%3A%2Ffixture-linked"
            {
                got_depth = true;
                req.reply(
                    200,
                    json!({
                        "location":{"directory":"C:/fixture-linked"},
                        "capability":{"minimum":0,"maximum":5,"default":2},
                        "effectiveDepth":2,
                        "nesting":{"effect":"allow","hidden":false},
                        "origin":"C:/fixture-linked/opencode.jsonc",
                        "project":{
                            "path":"C:/fixture-linked/opencode.jsonc",
                            "depth":null,
                            "expectation":expectation,
                            "nestingSkipped":false,
                            "emptyExperimental":false
                        }
                    }),
                )
                .await;
            } else {
                panic!("unexpected request {url}");
            }
        }
        assert_eq!(
            got_location, 1,
            "location must resolve once and be shared across catalog and depth"
        );

        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json().to_string().contains("Inherit (2)")
        })
        .await;

        // Choosing depth 3 sends PUT /api/workspaces/captured/subagent-depth with expectation.
        click(&mut rt, "mission-subagent-depth-trigger");
        click_option(&mut rt, "mission-subagent-depth", "3");
        tick(&mut rt);
        let put = request(&listener).await;
        assert_eq!(
            put.first,
            "PUT /api/workspaces/captured/subagent-depth HTTP/1.1"
        );
        assert_eq!(
            put.body,
            json!({
                "location": { "directory": "C:/fixture-linked" },
                "depth": 3,
                "expectation": expectation
            })
        );
        // Simulate transport drop while write is in flight -> enters Uncertain, never replays.
        crate::settings::connection_event(&root, &crate::transport::Event::ConnectionLost, true);
        tick(&mut rt);
        drop(put);
        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("Refresh project depth to check whether the change was saved."));

        // Reconnect without explicit Refresh keeps Uncertain (no automatic write replay).
        crate::settings::connection_event(&root, &crate::transport::Event::AgentHint(true), true);
        shared.borrow_mut().revalidate_transport();
        tick(&mut rt);
        // Handle config revalidation and catalog re-read triggered by reconnect, verify no PUT or depth GET is sent.
        while let Ok(accepted) = timeout(Duration::from_millis(120), listener.accept()).await {
            let (socket, _) = accepted.unwrap();
            let req = read_request(socket, Duration::from_secs(2)).await;
            assert!(
                !req.first.starts_with("PUT ") && !req.first.contains("/subagent-depth"),
                "must not replay PUT or auto-read depth while Uncertain: {}",
                req.first
            );
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url.starts_with("/api/storage/config/ui") {
                req.reply(200, json!({"settings":{"locale":"en"}})).await;
            } else if url.starts_with("/api/storage/state") {
                req.reply(200, json!({})).await;
            } else {
                req.reply(404, json!({"error":"not found"})).await;
            }
            tick(&mut rt);
        }
        wait_until(|| {
            tick(&mut rt);
            !shared.borrow().is_transport_lost()
        })
        .await;
        // Refreshing an uncertain depth requires confirmation first.
        click(&mut rt, "mission-depth-refresh");
        tick(&mut rt);
        assert!(rt.accessibility_json().to_string().contains("Discard"));
    });
}

#[test]
fn missions_saved_configurations_remove_and_invalid_repair_require_confirmation() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let model_id = "004633fb-53c4-477c-8b01-4cc5c177724b";
        prefs.apply_mission_config(json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": "corrupt",
                "missionModels": [{
                    "version": 1,
                    "id": model_id,
                    "name": "Nightly Audit",
                    "objective": "Check build",
                    "notes": "",
                    "template": "custom"
                }]
            }
        }));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        let tree = rt.accessibility_json().to_string();
        assert!(tree.contains("Reload or reset saved defaults."));
        assert!(rt.find("mission-defaults-repair").is_some());

        // Repair defaults requires confirmation before sending conditional PATCH [].
        click(&mut rt, "mission-defaults-repair");
        tick(&mut rt);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Reset the unreadable mission defaults?")
        );
        // Confirm button in confirmation dialog has key "file-decision-confirm".
        click(&mut rt, "file-decision-confirm");
        tick(&mut rt);
        let repair = request(&listener).await;
        assert_eq!(
            repair.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        assert_eq!(
            repair.body,
            json!({
                "patch": { "settings": { "missionProfileDefaults": [] } },
                "expected": [{ "key": "missionProfileDefaults", "present": true, "value": "corrupt" }]
            })
        );
        let repaired_doc = json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": [],
                "missionModels": [{
                    "version": 1,
                    "id": model_id,
                    "name": "Nightly Audit",
                    "objective": "Check build",
                    "notes": "",
                    "template": "custom"
                }]
            }
        });
        repair.reply(200, repaired_doc.clone()).await;
        let repair_read = next_request(&listener, &mut rt).await;
        assert_eq!(
            repair_read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        repair_read.reply(200, repaired_doc).await;
        wait_until(|| {
            tick(&mut rt);
            rt.find("mission-defaults-repair").is_none()
                && !shared.borrow().missions.defaults_writing()
        })
        .await;

        // Select saved configuration and remove with confirmation.
        click(&mut rt, "mission-model-library-trigger");
        click_option(&mut rt, "mission-model-library", "Nightly Audit");
        click(&mut rt, "mission-models-remove");
        tick(&mut rt);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Nightly Audit")
        );
        click(&mut rt, "file-decision-confirm");
        tick(&mut rt);
        let remove = request(&listener).await;
        assert_eq!(
            remove.first,
            "PATCH /api/storage/config/ui?conditional=missions-v1 HTTP/1.1"
        );
        assert_eq!(remove.body["patch"]["settings"]["missionModels"], json!([]));
        let removed_doc = json!({
            "settings": {
                "locale": "en",
                "missionProfileDefaults": [],
                "missionModels": []
            }
        });
        remove.reply(200, removed_doc.clone()).await;
        let remove_read = next_request(&listener, &mut rt).await;
        assert_eq!(
            remove_read.first,
            "GET /api/storage/config/ui?authoritative=1 HTTP/1.1"
        );
        remove_read.reply(200, removed_doc).await;
        wait_until(|| {
            tick(&mut rt);
            shared
                .borrow()
                .saved(Owner::Config)
                .is_some_and(|doc| doc["settings"]["missionModels"] == json!([]))
        })
        .await;
    });
}

#[test]
fn missions_depth_handles_404_501_as_unsupported_without_error_loop() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);
        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        let mut got_depth = false;
        let mut got_catalog = 0usize;
        while !(got_depth && got_catalog == 3) {
            let req = request(&listener).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/workspaces" {
                req.reply(
                    200,
                    json!([{"id":"captured","path":"/repo","location":{"directory":"/repo"}}]),
                )
                .await;
                wait_until(|| {
                    tick(&mut rt);
                    shared.borrow().missions.pinned_directory().is_some()
                })
                .await;
            } else if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo" {
                got_depth = true;
                req.reply(501, json!({"error":"not implemented"})).await;
            } else if url.starts_with("/workspaces/captured/instance/api/") {
                got_catalog += 1;
                req.reply(200, json!({"location":{"directory":"/repo"},"data":[]}))
                    .await;
            } else {
                panic!("unexpected request {url}");
            }
        }
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json()
                .to_string()
                .contains("Depth cannot be changed here.")
        })
        .await;
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn missions_depth_404_is_unsupported_and_confirm_refuses_stale_models() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let model_id = "004633fb-53c4-477c-8b01-4cc5c177724b";
        prefs.apply_mission_config(json!({
            "settings": {
                "locale": "en",
                "missionModels": [{
                    "version": 1,
                    "id": model_id,
                    "name": "Nightly Audit",
                    "objective": "Check build",
                    "notes": "",
                    "template": "custom"
                }]
            }
        }));
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);
        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        let mut got_depth = false;
        let mut got_catalog = 0usize;
        while !(got_depth && got_catalog == 3) {
            let req = request(&listener).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/workspaces" {
                req.reply(
                    200,
                    json!([{"id":"captured","path":"/repo","location":{"directory":"/repo"}}]),
                )
                .await;
                wait_until(|| {
                    tick(&mut rt);
                    shared.borrow().missions.pinned_directory().is_some()
                })
                .await;
            } else if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo" {
                got_depth = true;
                req.reply(404, json!({"error":"not found"})).await;
            } else if url.starts_with("/workspaces/captured/instance/api/") {
                got_catalog += 1;
                req.reply(200, json!({"location":{"directory":"/repo"},"data":[]}))
                    .await;
            } else {
                panic!("unexpected request {url}");
            }
        }
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json()
                .to_string()
                .contains("Depth cannot be changed here.")
        })
        .await;

        // Open Remove confirmation, then mutate missionModels before confirming: must refuse PATCH.
        click(&mut rt, "mission-model-library-trigger");
        click_option(&mut rt, "mission-model-library", "Nightly Audit");
        click(&mut rt, "mission-models-remove");
        tick(&mut rt);
        shared.borrow_mut().apply_mission_config(json!({
            "settings": {
                "locale": "en",
                "missionModels": [{
                    "version": 1,
                    "id": model_id,
                    "name": "Nightly Audit",
                    "objective": "Replaced externally",
                    "notes": "",
                    "template": "custom"
                }]
            }
        }));
        tick(&mut rt);
        click(&mut rt, "file-decision-confirm");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "stale confirmation must not send PATCH"
        );
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Reload saved configurations, then try again.")
        );
        // Reload restores library controls.
        click(&mut rt, "mission-models-reload");
        tick(&mut rt);
        let reload = request(&listener).await;
        assert!(reload.first.starts_with("GET /api/storage/config/ui"));
        reload
            .reply(
                200,
                json!({
                    "settings": {
                        "locale": "en",
                        "missionModels": [{
                            "version": 1,
                            "id": model_id,
                            "name": "Nightly Audit",
                            "objective": "Replaced externally",
                            "notes": "",
                            "template": "custom"
                        }]
                    }
                }),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            !rt.accessibility_json()
                .to_string()
                .contains("Reload saved configurations, then try again.")
        })
        .await;
    });
}

#[test]
fn missions_french_scope_switch_same_model_keeps_variant_and_tab_switch_cancels_reads() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.apply_mission_config(json!({
            "settings": {
                "locale": "fr",
                "missionProfileDefaults": [{
                    "template": "all",
                    "profiles": {
                        "coordinator": {
                            "model": { "providerID": "anthropic", "id": "claude", "variant": "high" }
                        }
                    }
                }]
            }
        }));
        let backend = prefs.backend.as_mut().unwrap();
        backend.workspace = "captured".into();
        let root = crate::init();
        let shared = root.settings.shared.clone();
        prefs.window_wake = Some(Arc::new(|| {}));
        *shared.borrow_mut() = prefs;
        let target = Target::capture(&root).unwrap();
        shared.borrow_mut().provider_target = Some(target);
        let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let mut rt = rune::Runtime::new(
            window,
            view::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;
        click(&mut rt, "settings-missions");
        tick(&mut rt);

        // Drain initial reads with one catalog model supporting variant "high".
        let mut got_depth = false;
        let mut got_catalog = 0usize;
        while !(got_depth && got_catalog == 3) {
            let req = request(&listener).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/workspaces" {
                req.reply(
                    200,
                    json!([{"id":"captured","path":"/repo","location":{"directory":"/repo"}}]),
                )
                .await;
                wait_until(|| {
                    tick(&mut rt);
                    shared.borrow().missions.pinned_directory().is_some()
                })
                .await;
            } else if url == "/api/workspaces/captured/subagent-depth?directory=%2Frepo" {
                got_depth = true;
                req.reply(404, json!({"error":"not found"})).await;
            } else if url.contains("/instance/api/provider") {
                got_catalog += 1;
                req.reply(
                    200,
                    json!({
                        "location": { "directory": "/repo" },
                        "data": [{ "id": "anthropic", "name": "Anthropic" }]
                    }),
                )
                .await;
            } else if url.contains("/instance/api/model") {
                got_catalog += 1;
                req.reply(
                    200,
                    json!({
                        "location": { "directory": "/repo" },
                        "data": [{
                            "providerID": "anthropic",
                            "id": "claude",
                            "name": "Claude",
                            "enabled": true,
                            "capabilities": { "tools": true },
                            "variants": [{ "id": "high" }]
                        }]
                    }),
                )
                .await;
            } else if url.starts_with("/workspaces/captured/instance/api/") {
                got_catalog += 1;
                req.reply(200, json!({"location":{"directory":"/repo"},"data":[]}))
                    .await;
            } else {
                panic!("unexpected request {url}");
            }
        }
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json()
                .to_string()
                .contains("Claude / high")
        })
        .await;

        // Switch scope to "Débogage" while locale is French.
        click(&mut rt, "mission-scope-trigger");
        click_option(&mut rt, "mission-scope", "Débogage");
        tick(&mut rt);
        assert!(rt.accessibility_json().to_string().contains("Global : "));

        // Switch back to "Toutes les missions", verify summary includes variant "high".
        click(&mut rt, "mission-scope-trigger");
        click_option(&mut rt, "mission-scope", "Toutes les missions");
        tick(&mut rt);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("Claude / high")
        );

        // Expand folded profiles disclosure and re-select the active model: variant stays and no PATCH is sent.
        click(&mut rt, "trigger");
        tick(&mut rt);
        click(&mut rt, "mission-model-coordinator-trigger");
        click_option(&mut rt, "mission-model-coordinator", "Anthropic · Claude");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(120), listener.accept())
                .await
                .is_err(),
            "re-selecting the already selected model must not send a PATCH or clear its variant"
        );
        assert_eq!(
            shared.borrow().saved(Owner::Config).unwrap()["settings"]["missionProfileDefaults"][0]
                ["profiles"]["coordinator"]["model"]["variant"],
            json!("high")
        );

        // Trigger a catalog refresh, switch away to General while the batch is in flight,
        // reply with a stale name, then return to Missions and verify the stale name is never shown.
        crate::settings::provider_changed(&root, "captured");
        tick(&mut rt);
        let mut late_reqs = Vec::new();
        let mut catalog_reqs = 0;
        while catalog_reqs < 3 {
            let req = request(&listener).await;
            let url = req.first.split_whitespace().nth(1).unwrap_or("");
            assert!(
                !url.starts_with("/workspaces/captured/instance/api/session/")
                    && url != "/api/workspaces/captured",
                "refresh must reuse pinned opener Location instead of re-resolving: {}",
                req.first
            );
            if url.starts_with("/workspaces/captured/instance/api/") {
                catalog_reqs += 1;
            }
            late_reqs.push(req);
        }
        click(&mut rt, "settings-general");
        tick(&mut rt);
        for req in late_reqs {
            let url = req.first.split_whitespace().nth(1).unwrap_or("");
            if url.contains("/instance/api/model") {
                req.reply(
                    200,
                    json!({
                        "location": { "directory": "/repo" },
                        "data": [{
                            "providerID": "anthropic",
                            "id": "claude",
                            "name": "StaleLateName",
                            "enabled": true,
                            "capabilities": { "tools": true },
                            "variants": [{ "id": "high" }]
                        }]
                    }),
                )
                .await;
            } else if url.contains("/subagent-depth") {
                req.reply(
                    200,
                    json!({
                        "location": { "directory": "/repo" },
                        "capability": null,
                        "effectiveDepth": null,
                        "nesting": null,
                        "origin": null,
                        "project": null
                    }),
                )
                .await;
            } else {
                req.reply(200, json!({"location":{"directory":"/repo"},"data":[]}))
                    .await;
            }
        }
        tick(&mut rt);
        click(&mut rt, "settings-missions");
        tick(&mut rt);
        assert!(
            !rt.accessibility_json()
                .to_string()
                .contains("StaleLateName"),
            "late reply after leaving Missions must never publish when returning to Missions"
        );

        // Opening Preferences with no active project/launcher must not panic on RefCell re-borrow
        // and must not trust an unverified cached session_directory.
        let empty = crate::init();
        let mut empty_backend = shared.borrow().backend.clone().unwrap();
        empty_backend.session_directory = Some("/empty-tab-checkout".into());
        empty.settings.shared.borrow_mut().backend = Some(empty_backend);
        let opener = crate::settings::missions::opener_directory(&empty);
        assert_eq!(opener, None);
        {
            let mut prefs = empty.settings.shared.borrow_mut();
            prefs.missions.capture_opener(opener, None);
            assert_eq!(prefs.missions.pinned_directory(), None);
        }
    });
}
