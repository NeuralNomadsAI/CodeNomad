use super::*;
use std::collections::BTreeMap;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
use tauri::{Webview, WebviewUrl, WebviewWindowBuilder};

const OWNER: &str = "local-11111111-1111-4111-8111-111111111111";
const OTHER: &str = "local-22222222-2222-4222-8222-222222222222";

#[test]
fn tauri_authority_does_not_grant_parent_capabilities_to_preview_children() {
    let manifests: BTreeMap<String, Manifest> =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: BTreeMap<String, Capability> =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let source: Capability =
        serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
    assert!(
        source.windows.is_empty(),
        "window matching would authorize every child"
    );
    assert_eq!(source.webviews, ["local-*"]);
    assert_eq!(
        serde_json::to_value(&source).unwrap(),
        serde_json::to_value(&capabilities[&source.identifier]).unwrap(),
        "checked-in capabilities must match the source configuration",
    );

    let resolved = Resolved::resolve(
        &manifests,
        capabilities,
        tauri::utils::platform::Target::current(),
    )
    .unwrap();
    let commands = resolved
        .allowed_commands
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let authority = tauri::runtime_authority!(manifests, resolved);
    for url in [
        "http://127.0.0.1:32123/",
        "http://localhost:1420/",
        "https://example.com/",
    ] {
        let origin = tauri::ipc::Origin::Remote {
            url: url.parse().unwrap(),
        };
        for command in &commands {
            assert!(
                authority
                    .resolve_access(command, OWNER, "browser-preview", &origin)
                    .is_none(),
                "preview inherited {command} at {url}"
            );
        }
    }
    let origin = tauri::ipc::Origin::Remote {
        url: "http://127.0.0.1:32123/".parse().unwrap(),
    };
    for command in [
        "plugin:event|emit",
        "plugin:dialog|open",
        "browser_target_register",
        "client_state_load",
    ] {
        assert!(
            authority
                .resolve_access(command, OWNER, OWNER, &origin)
                .is_some(),
            "primary renderer lost {command}"
        );
    }
}

fn app_with_preview() -> (
    tauri::App<MockRuntime>,
    Webview<MockRuntime>,
    Webview<MockRuntime>,
) {
    let app = mock_builder()
        .manage(crate::local_windows::LocalWindows::default())
        .build(mock_context(noop_assets()))
        .unwrap();
    WebviewWindowBuilder::new(&app, OWNER, WebviewUrl::default())
        .build()
        .unwrap();
    WebviewWindowBuilder::new(&app, OTHER, WebviewUrl::default())
        .build()
        .unwrap();
    let owner = app.get_webview(OWNER).unwrap();
    let child = owner
        .window()
        .add_child(
            tauri::webview::WebviewBuilder::new(
                "browser-preview",
                WebviewUrl::External("http://127.0.0.1:32123/".parse().unwrap()),
            ),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(300, 200),
        )
        .unwrap();
    (app, owner, child)
}

#[test]
fn browser_hosting_native_window_prevents_final_window_shutdown() {
    let (app, _, _) = app_with_preview();
    // Tauri's single-webview API omits OWNER, reproducing the original bug.
    assert!(!app.webview_windows().contains_key(OWNER));
    let windows = app.windows();
    assert!(windows.contains_key(OWNER));
    assert!(!crate::is_final_application_window(
        OTHER,
        windows.keys().map(String::as_str)
    ));
    // A surviving browser-hosting native window also prevents Destroyed cleanup.
    assert!(!windows
        .values()
        .filter(|window| window.label() != OTHER)
        .collect::<Vec<_>>()
        .is_empty());

    let source = include_str!("main.rs");
    assert!(source.contains("let windows = app_handle.windows();"));
    assert!(source.contains("if !app_handle.windows().is_empty()"));
}

fn registration() -> Registration {
    Registration {
        session_id: "session".to_string(),
        registration_id: "preview".to_string(),
        window_label: OWNER.to_string(),
        webview_label: "browser-preview".to_string(),
        generation: 1,
        visible: true,
    }
}

fn controller_with_registration() -> (BrowserController, Registration) {
    let controller = BrowserController::new(std::path::PathBuf::new());
    let registration = registration();
    {
        let mut inner = controller.inner.0.lock().unwrap();
        inner
            .registrations
            .insert(registration.registration_id.clone(), registration.clone());
        inner
            .navigation_versions
            .insert(registration.registration_id.clone(), 0);
    }
    (controller, registration)
}

#[test]
fn only_primary_renderer_reload_disposes_its_native_browser_children() {
    let (app, owner, child) = app_with_preview();
    let (controller, registration) = controller_with_registration();
    let renderer_version = controller.renderer_version(OWNER).unwrap();
    let lease = controller
        .reserve_page(registration.clone(), &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let sequence = controller
        .prepare_page_load(&registration.registration_id, "https://example.com/")
        .unwrap();
    {
        let mut inner = controller.inner.0.lock().unwrap();
        let mut unrelated = registration.clone();
        unrelated.window_label = OTHER.into();
        unrelated.registration_id = "other-preview".into();
        unrelated.webview_label = "browser-other".into();
        inner
            .registrations
            .insert(unrelated.registration_id.clone(), unrelated);
    }
    controller.renderer_page_started(&child);
    assert!(app.get_webview(child.label()).is_some());
    assert!(controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .contains_key("preview"));

    controller.renderer_page_started(&owner);
    assert!(controller
        .check_page_state(&lease, Instant::now() + Duration::from_secs(1))
        .is_err());
    assert!(app.get_webview(child.label()).is_none());
    assert!(app.get_webview(OWNER).is_some());
    let inner = controller.inner.0.lock().unwrap();
    assert!(!inner.registrations.contains_key("preview"));
    assert!(inner.page_leases.is_empty());
    assert!(!inner.navigation_versions.contains_key("preview"));
    assert!(!inner.page_load_expectations.contains_key("preview"));
    assert!(inner.registrations.contains_key("other-preview"));
    drop(inner);
    assert!(controller
        .wait_for_page_load("preview", sequence, Instant::now() + Duration::from_secs(1))
        .is_err());
    // A register command that was still creating its native child when reload
    // began must not republish the old renderer's target after cleanup.
    assert!(controller
        .publish_registration(
            registration.clone(),
            renderer_version,
            "https://example.com/"
        )
        .is_err());
    assert!(controller
        .publish_registration(
            registration,
            controller.renderer_version(OWNER).unwrap(),
            "https://example.com/"
        )
        .is_ok());
}

#[test]
fn fragment_navigation_completes_without_webview2_document_events() {
    let (controller, registration) = controller_with_registration();
    let url = "https://example.com/page#section";
    let sequence = controller.prepare_page_load("preview", url).unwrap();
    controller
        .complete_same_document_navigation(&registration, sequence, url)
        .unwrap();
    controller
        .wait_for_page_load("preview", sequence, Instant::now())
        .unwrap();
}

#[test]
fn fragment_completion_rejects_stale_sequence_url_and_registration_generation() {
    let (controller, registration) = controller_with_registration();
    let url = "https://example.com/page#section";
    let old = controller.prepare_page_load("preview", url).unwrap();
    let current = controller.prepare_page_load("preview", url).unwrap();
    assert!(controller
        .complete_same_document_navigation(&registration, old, url)
        .is_err());
    assert!(controller
        .complete_same_document_navigation(&registration, current, "https://example.com/page#other")
        .is_err());
    {
        let mut inner = controller.inner.0.lock().unwrap();
        inner.registrations.get_mut("preview").unwrap().generation += 1;
    }
    assert!(controller
        .complete_same_document_navigation(&registration, current, url)
        .is_err());
    assert!(
        controller.inner.0.lock().unwrap().page_load_expectations["preview"]
            .result
            .is_none()
    );
}

#[test]
fn fragment_completion_cannot_override_document_navigation_failure() {
    let (controller, registration) = controller_with_registration();
    let url = "https://example.com/page#section";
    let sequence = controller.prepare_page_load("preview", url).unwrap();
    controller.mark_page_started("preview", registration.generation, 17, url.into());
    controller.mark_page_finished(
        "preview",
        registration.generation,
        17,
        Some("connection refused".into()),
    );
    controller
        .complete_same_document_navigation(&registration, sequence, url)
        .unwrap();
    assert_eq!(
        controller
            .wait_for_page_load("preview", sequence, Instant::now())
            .unwrap_err(),
        "connection refused"
    );
}

#[test]
fn saved_history_contains_only_bounded_credential_free_urls_and_native_ids() {
    let value = bounded_history(json!({ "currentIndex": 1, "entries": [
        { "id": 1, "url": "about:blank", "pageState": "secret" },
        { "id": 2, "url": "https://example.com/", "pageState": "secret" },
        { "id": 3, "url": "https://user:secret@example.com/" },
    ] }))
    .unwrap();
    assert_eq!(
        value,
        json!({ "entries": [{ "id": 2, "url": "https://example.com/" }], "index": 0 })
    );
    let entries = (0..100)
        .map(|id| json!({ "id": id, "url": format!("https://example.com/{id}") }))
        .collect::<Vec<_>>();
    let result = bounded_history(json!({ "currentIndex": 50, "entries": entries })).unwrap();
    assert_eq!(result["entries"].as_array().unwrap().len(), 32);
    assert_eq!(result["index"], 16);
}

#[test]
fn browser_tabs_use_one_persistent_profile_separate_from_the_application() {
    let root = tempfile::tempdir().unwrap();
    let browser_root = root.path().join("browser");
    let controller = BrowserController::new(browser_root.clone());
    assert_eq!(
        controller.storage_directory(),
        browser_root.join("shared-v1")
    );
    assert_eq!(
        controller.clone().storage_directory(),
        controller.storage_directory()
    );
    assert_ne!(controller.storage_directory(), root.path());
}

#[test]
fn page_url_read_allows_navigation_callback_and_refuses_stale_result() {
    let (controller, registration) = controller_with_registration();
    let lease = controller
        .reserve_page(registration, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let callback_controller = controller.clone();
    let (read_started, callback_ready) = std::sync::mpsc::channel();
    let (url_ready, read_url) = std::sync::mpsc::channel();
    // Model the UI thread processing a navigation callback before answering
    // the synchronous URL getter. It must be able to acquire the controller lock.
    let callback = std::thread::spawn(move || {
        callback_ready.recv().unwrap();
        callback_controller.invalidate_page_for_generation("preview", 1);
        let _ = url_ready.send("https://example.com/new".parse().unwrap());
    });
    let result = controller.finish_page(&lease, Instant::now() + Duration::from_secs(2), || {
        read_started.send(()).unwrap();
        read_url
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "URL getter blocked navigation callback".to_string())
    });
    callback.join().unwrap();
    assert_eq!(
        result.unwrap_err(),
        "Browser page lease is no longer current"
    );
    assert!(controller.inner.0.lock().unwrap().page_leases.is_empty());
}

#[test]
fn page_generation_survives_end_but_not_navigation_registration_or_host_replacement() {
    let (controller, registration) = controller_with_registration();
    let operation = uuid::Uuid::new_v4().to_string();
    let first = controller
        .reserve_page(registration.clone(), &operation)
        .unwrap();
    controller.end_page("session", &operation);
    let second = controller
        .reserve_page(registration.clone(), &operation)
        .unwrap();
    assert_eq!(first.generation, second.generation);
    controller.invalidate_page_for_generation("preview", 1);
    assert!(controller
        .check_page_state(&second, Instant::now() + Duration::from_secs(1))
        .is_err());
    let third = controller
        .reserve_page(registration.clone(), &operation)
        .unwrap();
    assert_ne!(second.generation, third.generation);
    assert!(controller
        .finish_page(&third, Instant::now() + Duration::from_secs(1), || {
            let mut inner = controller.inner.0.lock().unwrap();
            inner.registrations.get_mut("preview").unwrap().generation += 1;
            inner.navigation_versions.insert("preview".into(), 0);
            Ok("https://example.com/replacement".parse().unwrap())
        })
        .is_err());
    controller.end_page("session", &operation);
    let replacement = controller.inner.0.lock().unwrap().registrations["preview"].clone();
    let fourth = controller.reserve_page(replacement, &operation).unwrap();
    assert_ne!(fourth.generation, first.generation);
    let (other_host, other_registration) = controller_with_registration();
    let other = other_host
        .reserve_page(other_registration, &operation)
        .unwrap();
    assert_ne!(other.generation, first.generation);
}

#[test]
fn page_lease_identity_limits_expiry_and_cleanup_are_exact() {
    let (controller, registration) = controller_with_registration();
    let operation = uuid::Uuid::new_v4().to_string();
    let lease = controller
        .reserve_page(registration.clone(), &operation)
        .unwrap();
    assert!(controller
        .reserve_page(registration.clone(), &operation)
        .is_err());
    assert!(controller
        .reserve_page(registration.clone(), &uuid::Uuid::new_v4().to_string())
        .is_err());
    let identity =
        json!({ "sessionID": "session", "operationID": operation, "generation": lease.generation });
    assert!(controller.page_lease(&identity).is_ok());
    for (key, value) in [
        ("sessionID", "foreign"),
        ("generation", "stale"),
        ("operationID", "missing"),
    ] {
        let mut invalid = identity.clone();
        invalid[key] = json!(value);
        assert!(controller.page_lease(&invalid).is_err());
    }
    controller.end_page("foreign", &operation);
    assert!(controller
        .check_page_state(&lease, Instant::now() + Duration::from_secs(1))
        .is_ok());
    assert!(controller.check_page_state(&lease, Instant::now()).is_err());
    for index in 1..32 {
        let mut next = registration.clone();
        next.registration_id = format!("preview-{index}");
        next.webview_label = next.registration_id.clone();
        {
            let mut inner = controller.inner.0.lock().unwrap();
            inner
                .registrations
                .insert(next.registration_id.clone(), next.clone());
            inner
                .navigation_versions
                .insert(next.registration_id.clone(), 0);
        }
        controller
            .reserve_page(next, &uuid::Uuid::new_v4().to_string())
            .unwrap();
    }
    let mut overflow = registration.clone();
    overflow.registration_id = "overflow".into();
    overflow.webview_label = "browser-overflow".into();
    {
        let mut inner = controller.inner.0.lock().unwrap();
        inner
            .registrations
            .insert("overflow".into(), overflow.clone());
        inner.navigation_versions.insert("overflow".into(), 0);
    }
    assert!(controller
        .reserve_page(overflow.clone(), &uuid::Uuid::new_v4().to_string())
        .is_err());
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .page_leases
        .get_mut(&operation)
        .unwrap()
        .expires = Instant::now();
    assert!(controller
        .check_page_state(&lease, Instant::now() + Duration::from_secs(1))
        .is_err());
    controller
        .reserve_page(overflow, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    assert!(!controller
        .inner
        .0
        .lock()
        .unwrap()
        .page_leases
        .contains_key(&operation));
    controller.end_page("session", &operation);
    controller.end_page("session", "unknown");
}

#[test]
fn page_lease_refuses_hidden_targets_and_renderer_disposal() {
    let (controller, registration) = controller_with_registration();
    let operation = uuid::Uuid::new_v4().to_string();
    let lease = controller
        .reserve_page(registration.clone(), &operation)
        .unwrap();
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut("preview")
        .unwrap()
        .visible = false;
    assert!(controller
        .check_page_state(&lease, Instant::now() + Duration::from_secs(1))
        .is_err());
    controller.end_page("session", &operation);
    assert!(controller.reserve_page(registration, &operation).is_err());
}

#[test]
fn page_channel_is_private_native_routing_not_a_renderer_command() {
    let main = include_str!("main.rs");
    let native = main
        .split("pub(crate) fn handle_native_request")
        .nth(1)
        .unwrap()
        .split("#[tauri::command]")
        .next()
        .unwrap();
    for method in [
        "browser.page.begin",
        "browser.page.send",
        "browser.page.check",
        "browser.page.end",
    ] {
        assert!(native.contains(method));
        assert_eq!(main.matches(method).count(), 1);
    }
    let capabilities = include_str!("../capabilities/main-window.json");
    assert!(!capabilities.contains("browser.page"));
}

#[cfg(windows)]
#[test]
fn expired_queued_protocol_command_does_not_execute() {
    use std::sync::atomic::AtomicBool;
    use std::sync::mpsc;

    let executed = Arc::new(AtomicBool::new(false));
    let side_effect = executed.clone();
    let (queue, queued) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_millis(50);
    // The first fence permits dispatch while the request is live. The queued
    // closure uses the same execution fence as the WebView2 protocol call.
    run_before_deadline(deadline, || {
        queue
            .send(move || {
                run_before_deadline(deadline, || {
                    side_effect.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
            .unwrap();
        Ok(())
    })
    .unwrap();
    let worker = std::thread::spawn(move || {
        let command = queued.recv().unwrap();
        resume.recv().unwrap();
        command()
    });
    std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
    release.send(()).unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err(),
        "Native request expired before execution"
    );
    assert!(!executed.load(Ordering::SeqCst));

    // Already-expired requests must not even enqueue work.
    let mut dispatched = false;
    assert!(run_before_deadline(deadline, || {
        dispatched = true;
        Ok(())
    })
    .is_err());
    assert!(!dispatched);
    assert_eq!(
        run_before_deadline(Instant::now() + Duration::from_secs(1), || Ok(7)),
        Ok(7)
    );
}
