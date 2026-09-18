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
        inner.refs.insert(
            registration.registration_id.clone(),
            HashMap::from([("e1".into(), 42)]),
        );
    }
    (controller, registration)
}

#[test]
fn only_primary_renderer_reload_disposes_its_native_browser_children() {
    let (app, owner, child) = app_with_preview();
    let (controller, registration) = controller_with_registration();
    let renderer_version = controller.renderer_version(OWNER).unwrap();
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
    assert!(app.get_webview(child.label()).is_none());
    assert!(app.get_webview(OWNER).is_some());
    let inner = controller.inner.0.lock().unwrap();
    assert!(!inner.registrations.contains_key("preview"));
    assert!(!inner.refs.contains_key("preview"));
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
fn snapshot_url_read_allows_navigation_callback_and_does_not_republish_stale_refs() {
    let (controller, registration) = controller_with_registration();
    let version = controller.page_navigation_version("preview");
    let callback_controller = controller.clone();
    let (read_started, callback_ready) = std::sync::mpsc::channel();
    let (url_ready, read_url) = std::sync::mpsc::channel();
    // Model the UI thread processing a navigation callback before answering
    // the synchronous URL getter. It must be able to acquire the controller lock.
    let callback = std::thread::spawn(move || {
        callback_ready.recv().unwrap();
        callback_controller.clear_refs_for_generation("preview", 1);
        let _ = url_ready.send("https://example.com/new".parse().unwrap());
    });
    let result = controller.finish_snapshot(
        &registration,
        version,
        HashMap::from([("e2".into(), 43)]),
        || {
            read_started.send(()).unwrap();
            read_url
                .recv_timeout(Duration::from_secs(2))
                .map_err(|_| "URL getter blocked navigation callback".to_string())
        },
    );
    callback.join().unwrap();
    assert_eq!(result.unwrap().as_str(), "https://example.com/new");
    assert!(!controller
        .inner
        .0
        .lock()
        .unwrap()
        .refs
        .contains_key("preview"));
}

#[test]
fn snapshot_publication_requires_current_navigation_and_registration() {
    let (controller, registration) = controller_with_registration();
    let refs = HashMap::from([("e2".into(), 43)]);
    let version = controller.page_navigation_version("preview");
    controller
        .finish_snapshot(&registration, version, refs.clone(), || {
            Ok("https://example.com/".parse().unwrap())
        })
        .unwrap();
    assert_eq!(controller.inner.0.lock().unwrap().refs["preview"], refs);

    // A replacement may reset the navigation version to the same value. The
    // registration generation must still prevent old snapshot publication.
    controller
        .finish_snapshot(&registration, version, refs, || {
            let mut inner = controller.inner.0.lock().unwrap();
            inner.registrations.get_mut("preview").unwrap().generation += 1;
            inner.refs.remove("preview");
            Ok("https://example.com/replacement".parse().unwrap())
        })
        .unwrap();
    assert!(!controller
        .inner
        .0
        .lock()
        .unwrap()
        .refs
        .contains_key("preview"));
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
