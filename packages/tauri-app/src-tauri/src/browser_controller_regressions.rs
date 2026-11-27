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
            for (window, child) in [
                (OWNER, "browser-preview"),
                (OWNER, "embedded-remote-preview"),
                ("browser-popup-preview", "browser-popup-preview"),
            ] {
                assert!(
                    authority
                        .resolve_access(command, window, child, &origin)
                        .is_none(),
                    "{child} inherited {command} at {url}"
                );
            }
        }
    }
    let origin = tauri::ipc::Origin::Remote {
        url: "http://127.0.0.1:32123/".parse().unwrap(),
    };
    for command in [
        "plugin:event|emit",
        "plugin:dialog|open",
        "browser_target_register",
        "browser_target_ownership",
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
        windows.keys().map(String::as_str),
        &[]
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
        instance_id: None,
        registration_id: "preview".to_string(),
        window_label: OWNER.to_string(),
        webview_label: "browser-preview".to_string(),
        generation: 1,
        visibility_version: 0,
        visible: true,
    }
}

fn controller_with_registration() -> (BrowserController, Registration) {
    let mut controller = BrowserController::new(std::path::PathBuf::new());
    let registration = registration();
    controller.embedded_views = EmbeddedViews::for_test(OWNER, &registration.webview_label);
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
fn a_probe_serves_only_previews_in_the_verified_project_tabs() {
    let (controller, registration) = controller_with_registration();
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut(&registration.registration_id)
        .unwrap()
        .instance_id = Some("ws-a".into());
    let resolve = |workspaces: Option<&[String]>| {
        controller.resolve_with_visibility_in("session", workspaces, |_| Ok(true))
    };
    assert_eq!(resolve(Some(&["ws-b".to_string()])).err(), Some(no_browser_target_error()));
    assert!(resolve(Some(&["ws-a".to_string()])).is_ok());
    assert!(workspace_filter(Some(&json!(["ok", ""]))).is_err());
}
#[test]
fn a_window_visibility_read_failure_makes_the_preview_inventory_incomplete() {
    let (controller, mut registration) = controller_with_registration();
    let resolve = || {
        controller.resolve_with_visibility("session", |label| match label {
            OWNER => Err(std::io::Error::other("visibility read failed").into()),
            OTHER => Ok(true),
            _ => unreachable!(),
        })
    };
    let assert_incomplete = || {
        let error = resolve().err().expect("must not choose an unverified target");
        assert!(error.contains("inventory is incomplete"), "{error}");
        assert_ne!(error, no_browser_target_error());
    };
    assert_eq!(
        controller
            .resolve_with_visibility("session", |_| Ok(false))
            .err(),
        Some(no_browser_target_error())
    );
    assert_incomplete();

    registration.registration_id = "other".into();
    registration.window_label = OTHER.into();
    controller
        .publish_registration(registration, 0, "https://example.com/", None)
        .unwrap();
    assert_incomplete();
}

#[test]
fn probe_issues_a_bounded_witness_for_the_current_registration_and_document() {
    let (app, _, _) = app_with_preview();
    let (controller, mut registration) = controller_with_registration();
    let deadline = Instant::now() + Duration::from_secs(10);
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 10_000;
    let fence = crate::native_request::RequestFence::new(expires, || true);
    let probe = || {
        controller
            .probe(app.handle(), "session", None, deadline, &fence, |_, _| {
                Ok(if cfg!(windows) {
                    ""
                } else {
                    "isolated-document"
                }
                .into())
            })
            .unwrap()
    };
    let resolve = |target| controller.resolve_witness(app.handle(), "session", target);
    let first = probe();
    assert_eq!(first["available"], true);
    assert!(first["target"]
        .as_str()
        .is_some_and(|target| !target.is_empty() && target.len() <= 128));
    assert_eq!(probe(), first);
    let target = first["target"].as_str().unwrap();
    let (_, document, token) = resolve(target).unwrap();
    if !cfg!(windows) {
        assert_eq!(token, "isolated-document");
        assert!(compare_webkit_document(&json!({"document": token}), token).is_ok());
        assert_eq!(
            compare_webkit_document(&json!({"document": "recreated"}), token).unwrap_err(),
            STALE_TARGET
        );
    }
    {
        let mut inner = controller.inner.0.lock().unwrap();
        inner.registrations.insert(
            "other".into(),
            Registration {
                registration_id: "other".into(),
                window_label: OTHER.into(),
                generation: 2,
                ..registration.clone()
            },
        );
    }
    assert_eq!(
        resolve(target).err().unwrap(),
        "Multiple visible browser targets exist for this session"
    );
    {
        let mut inner = controller.inner.0.lock().unwrap();
        inner.registrations.remove("other");
        inner.registrations.get_mut("preview").unwrap().visible = false;
    }
    assert_eq!(resolve(target).err().unwrap(), STALE_TARGET);
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut("preview")
        .unwrap()
        .visible = true;

    controller.invalidate_page(&registration.registration_id);
    assert_eq!(resolve(target).err().unwrap(), STALE_TARGET);
    let operation = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        controller
            .reserve_page_for(registration.clone(), &operation, Some(document))
            .err()
            .unwrap(),
        STALE_TARGET
    );
    let url = "https://example.com/next";
    assert_eq!(
        controller
            .prepare_navigation(&registration, url, Some(document), None, || Ok(()))
            .unwrap_err(),
        STALE_TARGET
    );
    assert_eq!(
        controller.page_load_expectation("preview", url).unwrap(),
        None
    );
    assert!(controller.inner.0.lock().unwrap().page_leases.is_empty());

    let second = probe();
    assert_ne!(first["target"], second["target"]);
    let (_, document, _) = resolve(second["target"].as_str().unwrap()).unwrap();
    controller
        .reserve_page_for(registration.clone(), &operation, Some(document))
        .unwrap();
    controller
        .prepare_navigation(&registration, url, Some(document), None, || Ok(()))
        .unwrap();
    let dispatch_document = Some(document.wrapping_add(1));
    controller
        .check_dispatch_document(&registration, dispatch_document)
        .unwrap();
    controller.invalidate_page("preview");
    assert_eq!(
        controller
            .check_dispatch_document(&registration, dispatch_document)
            .unwrap_err(),
        STALE_TARGET
    );

    registration.generation += 1;
    controller
        .publish_registration(registration, 0, "https://example.com/", None)
        .unwrap();
    assert_ne!(probe()["target"], second["target"]);
    assert_eq!(
        resolve(second["target"].as_str().unwrap()).err().unwrap(),
        STALE_TARGET
    );
}

#[cfg(windows)]
#[test]
fn webview2_same_url_reopen_revokes_only_the_exact_guest_document() {
    let (app, _, _) = app_with_preview();
    let (controller, registration) = controller_with_registration();
    let other = Registration {
        registration_id: "other".into(),
        webview_label: "browser-other".into(),
        session_id: "other-session".into(),
        generation: 2,
        ..registration.clone()
    };
    let url = "http://127.0.0.1:32123/";
    controller
        .publish_registration(other.clone(), 0, url, None)
        .unwrap();
    let sequence = controller
        .prepare_page_load(&registration.registration_id, url)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let fence = crate::native_request::RequestFence::new(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 10_000,
        || true,
    );
    let probe = || {
        controller
            .probe(app.handle(), "session", None, deadline, &fence, |_, _| Ok(String::new()))
            .unwrap()
    };
    let first = probe();
    let witness = first["target"].as_str().unwrap();
    let resolve = |witness| controller.resolve_witness(app.handle(), "session", witness);
    let (_, document, _) = resolve(witness).unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let lease = controller
        .reserve_page_for(registration.clone(), &operation, Some(document))
        .unwrap();
    let other_lease = controller
        .reserve_page(other.clone(), &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let top = json!({"frame": {"id": "main", "url": url}}).to_string();
    let child = json!({"frame": {"id": "child", "parentId": "main", "url": url}}).to_string();
    for (generation, session, parameters) in [
        (registration.generation - 1, "", top.as_str()),
        (registration.generation, "attached-child-session", top.as_str()),
        (registration.generation, "", child.as_str()),
        (registration.generation, "", r#"{"frame":{"id":""}}"#),
        (registration.generation, "", "invalid JSON"),
    ] {
        controller.webview2_document_opened("preview", generation, session, parameters);
        assert_eq!(probe(), first);
        controller.check_page_state(&lease, deadline).unwrap();
    }
    // A response already in flight must also be dropped if its document reopens.
    let response = controller.finish_page(&lease, deadline, || {
        controller.webview2_document_opened("preview", registration.generation, "", &top);
        Ok(url.parse().unwrap())
    });
    assert_eq!(resolve(witness).err().as_deref(), Some(STALE_TARGET));
    assert!(response.is_err());
    assert_eq!(
        controller.check_capture(app.handle(), &registration, document, deadline, &fence),
        Err(STALE_TARGET.into())
    );
    assert_eq!(
        controller.prepare_navigation(&registration, url, Some(document), None, || Ok(())),
        Err(STALE_TARGET.into())
    );
    assert!(controller.check_page_state(&lease, deadline).is_err());
    assert_eq!(
        controller
            .reserve_page_for(registration.clone(), &operation, Some(document))
            .err()
            .as_deref(),
        Some(STALE_TARGET)
    );
    controller.check_page_state(&other_lease, deadline).unwrap();
    assert_eq!(controller.document_version(&other), Ok(0));
    assert_eq!(
        controller.page_load_expectation("preview", url),
        Ok(Some(sequence))
    );

    let second = probe();
    let second_witness = second["target"].as_str().unwrap();
    let (_, second_document, _) = resolve(second_witness).unwrap();
    let next = controller
        .reserve_page_for(registration.clone(), &operation, Some(second_document))
        .unwrap();
    controller.check_page_state(&next, deadline).unwrap();
    controller.end_page("session", &operation);
    // Reopening between leases also retires the last witness.
    controller.webview2_document_opened("preview", registration.generation, "", &top);
    assert_eq!(resolve(second_witness).err().as_deref(), Some(STALE_TARGET));
    assert_ne!(probe(), second);
}

#[test]
fn hiding_a_preview_or_renderer_retires_the_witness_even_after_reshow() {
    let (app, _, _) = app_with_preview();
    let (controller, initial) = controller_with_registration();
    let witness = |registration: &Registration| {
        let mut target = controller.page_generation(registration, 0);
        if !cfg!(windows) {
            target.push_str(":isolated-document");
        }
        target
    };
    let target = witness(&initial);
    let _ = controller.update(
        app.handle(),
        OWNER,
        BrowserTargetUpdate {
            instance_id: None,
            registration_id: "preview".into(),
            bounds: None,
            visible: Some(false),
            presentation: None,
        },
    );
    let reshown = {
        let mut inner = controller.inner.0.lock().unwrap();
        let registration = inner.registrations.get_mut("preview").unwrap();
        assert!(!registration.visible);
        registration.visible = true;
        registration.clone()
    };
    let resolve = |target: &str| {
        controller
            .resolve_witness(app.handle(), "session", target)
            .map(|_| ())
    };
    assert_eq!(resolve(&target).unwrap_err(), STALE_TARGET);
    let target = witness(&reshown);
    assert!(resolve(&target).is_ok());
    controller.revoke_window_visibility(OWNER);
    assert_eq!(resolve(&target).unwrap_err(), STALE_TARGET);
    let current = controller.owned_registration(OWNER, "preview").unwrap();
    assert_eq!(current.generation, initial.generation);
    assert_eq!(controller.document_version(&current).unwrap(), 0);
    assert!(resolve(&witness(&current)).is_ok());
    assert_eq!(
        read_witness(None).unwrap_err(),
        "A current browser target is required"
    );
}

#[test]
fn windows_and_webkit_navigation_recover_from_blank_without_relaxing_reads() {
    let (app, _, child) = app_with_preview();
    let (controller, registration) = controller_with_registration();
    let deadline = Instant::now() + Duration::from_secs(10);
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 10_000;
    let fence = crate::native_request::RequestFence::new(expires, || true);
    controller
        .check_target(app.handle(), &registration, deadline, &fence)
        .unwrap();
    child.navigate("about:blank".parse().unwrap()).unwrap();
    controller
        .check_target_identity(app.handle(), &registration, deadline, &fence)
        .unwrap();
    assert!(controller
        .check_target(app.handle(), &registration, deadline, &fence)
        .is_err());
    assert!(allowed_url("file:///private").is_err());
    let target = allowed_url("https://example.com/recovered").unwrap();
    child.navigate(target).unwrap();
    controller
        .check_target(app.handle(), &registration, deadline, &fence)
        .unwrap();
    assert_eq!(
        child.url().unwrap().as_str(),
        "https://example.com/recovered"
    );

    // Results and visibility retain their stricter checks after recovery.
    child.navigate("about:blank".parse().unwrap()).unwrap();
    assert!(controller
        .check_target(app.handle(), &registration, deadline, &fence)
        .is_err());
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut(&registration.registration_id)
        .unwrap()
        .visible = false;
    assert!(controller
        .check_target_identity(app.handle(), &registration, deadline, &fence)
        .is_err());
}

#[test]
fn replacing_a_registration_clears_its_emulation_profile() {
    let (controller, mut current) = controller_with_registration();
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .emulation_profiles
        .insert(current.registration_id.clone(), "mobile".into());
    current.generation += 1;
    controller
        .publish_registration(current.clone(), 0, "https://example.com/", None)
        .unwrap();
    assert!(!controller
        .inner
        .0
        .lock()
        .unwrap()
        .emulation_profiles
        .contains_key(&current.registration_id));
}

#[test]
fn capture_document_identity_changes_on_navigation_hide_and_replacement() {
    let (controller, expected) = controller_with_registration();
    let document = controller.document_version(&expected).unwrap();
    controller.invalidate_page(&expected.registration_id);
    assert_ne!(controller.document_version(&expected).unwrap(), document);
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut(&expected.registration_id)
        .unwrap()
        .visible = false;
    assert!(controller.document_version(&expected).is_err());
    controller.inner.0.lock().unwrap().registrations.insert(
        expected.registration_id.clone(),
        Registration {
            generation: expected.generation + 1,
            ..expected.clone()
        },
    );
    assert!(controller.document_version(&expected).is_err());
}

#[test]
fn a_different_native_navigation_supersedes_a_bound_load_even_if_it_finishes_late() {
    let (controller, expected) = controller_with_registration();
    let sequence = controller
        .prepare_page_load(&expected.registration_id, "https://example.com/wanted")
        .unwrap();
    controller.mark_page_started(
        &expected.registration_id,
        expected.generation,
        1,
        "https://example.com/wanted".into(),
    );
    controller.mark_page_started(
        &expected.registration_id,
        expected.generation,
        2,
        "https://example.com/user".into(),
    );
    controller.mark_page_finished(&expected.registration_id, expected.generation, 1, None);
    assert!(controller
        .wait_for_page_load(
            &expected.registration_id,
            sequence,
            Instant::now() + Duration::from_secs(1)
        )
        .unwrap_err()
        .contains("no longer current"));
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn autonomous_load_revocation_stops_only_the_pending_exact_navigation() {
    for scenario in [
        "timeout",
        "backend",
        "placement",
        "superseded",
        "replacement",
    ] {
        let controller = BrowserController::new(Default::default());
        let expected = registration();
        let id = &expected.registration_id;
        let url = "https://example.com/first";
        controller
            .publish_registration(expected.clone(), 0, url, None)
            .unwrap();
        let sequence = controller
            .prepare_navigation(&expected, url, None, None, || Ok(()))
            .unwrap();
        controller.mark_page_started(id, expected.generation, 17, url.into());
        if scenario == "superseded" {
            controller.mark_page_started(
                id,
                expected.generation,
                18,
                "https://example.com/next".into(),
            );
            controller.mark_page_committed(
                id,
                expected.generation,
                18,
                "https://example.com/next".into(),
            );
            controller.mark_page_finished(id, expected.generation, 18, None);
        }
        if scenario == "replacement" {
            let mut new = expected.clone();
            new.generation += 1;
            controller.publish_registration(new, 0, url, None).unwrap();
        }
        let now = Instant::now();
        let deadline = if scenario == "timeout" {
            now
        } else {
            now + Duration::from_secs(90)
        };
        let result =
            controller.wait_for_navigation_load(&expected, sequence, deadline, || match scenario {
                "backend" | "placement" => Err(scenario.into()),
                _ => Ok(()),
            });
        assert!(result.is_err(), "{scenario}: {result:?}");
        assert_eq!(
            controller.take_navigation_stop(&expected, sequence),
            matches!(scenario, "timeout" | "backend" | "placement"),
            "{scenario}",
        );
        assert!(!controller.take_navigation_stop(&expected, sequence));
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
#[test]
fn autonomous_load_returns_the_completion_url_once_and_rejects_a_later_document() {
    let controller = BrowserController::new(Default::default());
    let expected = registration();
    let id = &expected.registration_id;
    let url = "https://example.com/first";
    let redirected = "https://example.com/redirected";
    controller
        .publish_registration(expected.clone(), 0, url, None)
        .unwrap();
    let document = controller.document_version(&expected).unwrap();
    let sequence = controller
        .prepare_navigation(&expected, url, Some(document), None, || Ok(()))
        .unwrap();
    controller.mark_page_started(id, expected.generation, 17, url.into());
    controller.mark_page_started(id, expected.generation, 17, redirected.into());
    controller.mark_page_committed(id, expected.generation, 17, redirected.into());
    controller.mark_page_finished(id, expected.generation, 17, None);
    let deadline = Instant::now() + Duration::from_secs(90);
    assert_eq!(
        controller
            .wait_for_navigation_load(&expected, sequence, deadline, || Ok(()))
            .unwrap(),
        redirected
    );
    controller.mark_page_started(id, expected.generation, 18, url.into());
    assert!(controller
        .wait_for_navigation_load(&expected, sequence, deadline, || Ok(()))
        .is_err());
    assert!(!controller.take_navigation_stop(&expected, sequence));
}

#[test]
fn history_requires_current_owner_and_generation_but_survives_hide() {
    let (controller, expected) = controller_with_registration();
    assert!(controller.check_history_registration(&expected).is_ok());
    let mut foreign = expected.clone();
    foreign.window_label = OTHER.into();
    assert!(controller.check_history_registration(&foreign).is_err());
    let mut stale = expected.clone();
    stale.generation += 1;
    assert!(controller.check_history_registration(&stale).is_err());
    {
        let mut inner = controller.inner.0.lock().unwrap();
        inner
            .registrations
            .get_mut(&expected.registration_id)
            .unwrap()
            .visible = false;
    }
    assert!(controller.check_history_registration(&expected).is_ok());
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .remove(&expected.registration_id);
    assert!(controller.check_history_registration(&expected).is_err());
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
            "https://example.com/",
            None,
        )
        .is_err());
    assert!(controller
        .publish_registration(
            registration,
            controller.renderer_version(OWNER).unwrap(),
            "https://example.com/",
            None,
        )
        .is_ok());
}

#[test]
fn older_creation_and_foreign_window_cannot_replace_current_registration() {
    let (controller, mut current) = controller_with_registration();
    current.generation = 3;
    controller
        .publish_registration(current.clone(), 0, "https://example.com/", None)
        .unwrap();
    let mut stale = current.clone();
    stale.generation = 2;
    assert!(controller
        .publish_registration(stale, 0, "https://example.com/", None)
        .is_err());
    let mut foreign = current.clone();
    foreign.window_label = OTHER.into();
    foreign.generation = 4;
    assert!(controller
        .publish_registration(foreign, 0, "https://example.com/", None)
        .is_err());
    assert_eq!(
        controller
            .owned_registration(OWNER, "preview")
            .unwrap()
            .generation,
        3
    );
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .remove("preview");
    current.generation = 2;
    assert!(controller
        .publish_registration(current, 0, "https://example.com/", None)
        .is_err());
}

#[test]
fn hiding_revokes_page_authority_even_when_native_hide_fails() {
    let (app, _, child) = app_with_preview();
    let (controller, registration) = controller_with_registration();
    let lease = controller
        .reserve_page(registration, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    child.close().unwrap();
    assert!(controller
        .update(
            app.handle(),
            OWNER,
            BrowserTargetUpdate {
                instance_id: None,
                registration_id: "preview".into(),
                bounds: None,
                visible: Some(false),
                presentation: None,
            }
        )
        .is_err());
    assert!(
        !controller
            .owned_registration(OWNER, "preview")
            .unwrap()
            .visible
    );
    assert!(controller
        .check_page_state(&lease, Instant::now() + Duration::from_secs(1))
        .is_err());
    assert!(controller.inner.0.lock().unwrap().page_leases.is_empty());
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
fn document_bound_page_leases_preserve_uri_changes_and_registration_fences() {
    let (controller, registration) = controller_with_registration();
    let operation = uuid::Uuid::new_v4().to_string();
    let mut lease = controller.reserve_page(registration, &operation).unwrap();
    lease.document = Some("isolated-document-token".into());
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .page_leases
        .insert(operation.clone(), lease.clone());
    controller.invalidate_page_for_generation("preview", 1);
    controller.invalidate_page("preview");
    let deadline = Instant::now() + Duration::from_secs(1);
    assert!(controller.check_page_state(&lease, deadline).is_ok());
    // The native adapter checks the document token; URI callbacks keep the lease.
    assert!(controller.check_page_state(&lease, Instant::now()).is_err());
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut("preview")
        .unwrap()
        .visible = false;
    assert!(controller.check_page_state(&lease, deadline).is_err());
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut("preview")
        .unwrap()
        .visible = true;
    controller
        .inner
        .0
        .lock()
        .unwrap()
        .registrations
        .get_mut("preview")
        .unwrap()
        .generation += 1;
    assert!(controller.check_page_state(&lease, deadline).is_err());
    controller.end_page("session", &operation);
    assert!(controller.check_page_state(&lease, deadline).is_err());
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
