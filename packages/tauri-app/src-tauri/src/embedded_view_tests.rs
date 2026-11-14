use super::*;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const OWNER: &str = "local-11111111-1111-4111-8111-111111111111";
const OTHER: &str = "local-22222222-2222-4222-8222-222222222222";

#[test]
fn private_preview_origin_matches_only_the_parsed_content_host() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/private-preview-url-cases.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let raw = case["url"].as_str().unwrap();
        let expected = case["private"].as_bool().unwrap();
        assert_eq!(preview_origin::private_preview_url(raw), expected, "{raw}");
        if let Ok(url) = tauri::Url::parse(raw) {
            assert_eq!(private_preview_url(&url), expected, "{raw}");
        }
    }
}

#[test]
fn child_policy_is_registered_before_creation_and_fails_closed() {
    let views = EmbeddedViews::default();
    let http = "https://example.com".parse().unwrap();
    let blank = "about:blank".parse().unwrap();
    assert_eq!(
        views.navigation_allowed("browser-missing", &http),
        Some(false)
    );
    assert_eq!(views.navigation_allowed(OWNER, &http), None);
    assert!(views.reserve("remote-guest", "browser-child").is_err());
    let remote = views.reserve(OWNER, "embedded-remote-child").unwrap();
    assert_eq!(
        views.navigation_allowed("embedded-remote-child", &http),
        Some(true)
    );
    views.remove_exact("embedded-remote-child", &remote);
    assert_eq!(
        views.navigation_allowed("embedded-remote-child", &http),
        Some(false)
    );
    let record = views.reserve(OWNER, "browser-child").unwrap();
    assert!(views.owned(OTHER, "browser-child").is_err());
    assert!(views.owned(OWNER, "browser-missing").is_err());
    assert_eq!(
        views.navigation_allowed("browser-child", &blank),
        Some(true)
    );
    assert_eq!(views.navigation_allowed("browser-child", &http), Some(true));
    views.finish_creation("browser-child", &record).unwrap();
    assert_eq!(
        views.navigation_allowed("browser-child", &blank),
        Some(true)
    );
    for raw in [
        "file:///secret",
        "https://user:pass@example.com",
        "javascript:alert(1)",
        "data:text/html,test",
    ] {
        assert_eq!(
            views.navigation_allowed("browser-child", &raw.parse().unwrap()),
            Some(false)
        );
    }
}

#[test]
fn failed_creation_rolls_back_only_its_exact_reservation() {
    let views = EmbeddedViews::default();
    let failed = views.reserve(OWNER, "browser-child").unwrap();
    assert!(views.remove_exact("browser-child", &failed));
    assert_eq!(
        views.navigation_allowed("browser-child", &"https://example.com".parse().unwrap()),
        Some(false)
    );
    let replacement = views.reserve(OWNER, "browser-child").unwrap();
    let stale = views.clone();
    let worker = std::thread::spawn(move || {
        assert!(!stale.remove_exact("browser-child", &failed));
        assert!(stale.finish_creation("browser-child", &failed).is_err());
    });
    worker.join().unwrap();
    views
        .finish_creation("browser-child", &replacement)
        .unwrap();
    assert_eq!(
        views.owned(OWNER, "browser-child").unwrap().token,
        replacement.token
    );
}

#[test]
fn native_creation_installs_protections_before_return_and_rolls_back_failure() {
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    app.manage(StorageIdentity::new(
        "dev".into(),
        "/home/me/config.yaml".into(),
    ));
    WebviewWindowBuilder::new(&app, OWNER, WebviewUrl::default())
        .build()
        .unwrap();
    let owner = app.get_window(OWNER).unwrap();
    let views = EmbeddedViews::default();
    app.manage(views.clone());
    let bounds = Bounds {
        x: 10,
        y: 20,
        width: 300,
        height: 200,
    };
    let result = views.create_with(
        &owner,
        "browser-failed",
        PathBuf::new(),
        bounds,
        |_, _| {},
        |_| true,
        |webview| {
            assert!(views.owned(OWNER, webview.label()).is_ok());
            assert_eq!(
                views.navigation_allowed(webview.label(), &"about:blank".parse().unwrap()),
                Some(true)
            );
            Err("mandatory protection failed".into())
        },
    );
    assert_eq!(result.err().unwrap(), "mandatory protection failed");
    assert!(views.owned(OWNER, "browser-failed").is_err());
    assert!(app.get_webview("browser-failed").is_none());
    let child = views
        .create_with(
            &owner,
            "browser-ready",
            PathBuf::new(),
            bounds,
            |_, _| {},
            |_| true,
            |_| Ok(()),
        )
        .unwrap();
    assert!(crate::intercept_navigation(
        &child,
        &"https://example.com".parse().unwrap()
    ));
    assert!(!crate::intercept_navigation(
        &child,
        &"file:///secret".parse().unwrap()
    ));
    assert_eq!(
        views.navigation_allowed(child.label(), &"about:blank".parse().unwrap()),
        Some(true)
    );
    let record = views.owned(OWNER, child.label()).unwrap();
    views.remove_exact(child.label(), &record);
    assert!(!crate::intercept_navigation(
        &child,
        &"https://example.com".parse().unwrap()
    ));
    let duplicate = views.create_with(
        &owner,
        child.label(),
        PathBuf::new(),
        bounds,
        |_, _| {},
        |_| true,
        |_| Ok(()),
    );
    assert!(duplicate.is_err());
    assert!(views.owned(OWNER, child.label()).is_err());
    child.close().unwrap();

    let reloaded = views.create_with(
        &owner,
        "browser-reloading",
        PathBuf::new(),
        bounds,
        |_, _| {},
        |_| true,
        |_| {
            views.remove_owner(app.handle(), OWNER);
            Ok(())
        },
    );
    assert!(reloaded.is_err());
    assert!(views.owned(OWNER, "browser-reloading").is_err());
    assert!(app.get_webview("browser-reloading").is_none());
}

#[test]
fn document_policy_allows_blank_and_only_owned_blob_origins() {
    let views = EmbeddedViews::for_test(OWNER, "browser-origin");
    views.observe_origin(
        "browser-origin",
        views.owned(OWNER, "browser-origin").unwrap().token,
        &"https://example.com/page".parse().unwrap(),
    );
    for url in [
        "https://example.com/page",
        "about:blank",
        "blob:https://example.com/id",
    ] {
        assert_eq!(
            views.navigation_allowed("browser-origin", &url.parse().unwrap()),
            Some(true)
        );
    }
    for url in [
        "blob:https://other.example/id",
        "blob:null/id",
        "file:///private",
        "tauri://localhost",
    ] {
        assert_eq!(
            views.navigation_allowed("browser-origin", &url.parse().unwrap()),
            Some(false)
        );
    }
    assert!(!is_allowed_url(&"about:blank".parse().unwrap()));
    assert!(!is_allowed_url(
        &"blob:https://example.com/id".parse().unwrap()
    ));
}

#[test]
fn tree_invalidation_includes_pending_descendants_and_fences_stale_callbacks() {
    let views = EmbeddedViews::default();
    let root = views.reserve(OWNER, "browser-tree").unwrap();
    let child = views.reserve(OWNER, "browser-popup-child").unwrap();
    let grandchild = views.reserve(OWNER, "browser-popup-grandchild").unwrap();
    let peer = views.reserve(OWNER, "browser-peer").unwrap();
    {
        let mut inner = views.0.lock().unwrap();
        inner.records.get_mut("browser-popup-child").unwrap().opener = Some("browser-tree".into());
        inner
            .records
            .get_mut("browser-popup-grandchild")
            .unwrap()
            .opener = Some("browser-popup-child".into());
        let removed = EmbeddedViews::take_tree(&mut inner, "browser-tree", root.token, true);
        assert_eq!(removed.len(), 3);
        assert_eq!(inner.records.len(), 1);
    }
    assert!(views
        .finish_creation("browser-popup-child", &child)
        .is_err());
    assert!(views
        .finish_creation("browser-popup-grandchild", &grandchild)
        .is_err());
    let replacement = views.reserve(OWNER, "browser-tree").unwrap();
    assert!(!views.current("browser-tree", root.token));
    views.observe_origin(
        "browser-tree",
        root.token,
        &"https://stale.invalid".parse().unwrap(),
    );
    assert_eq!(views.owned(OWNER, "browser-tree").unwrap().origin, None);
    assert!(EmbeddedViews::take_tree(
        &mut views.0.lock().unwrap(),
        "browser-tree",
        root.token,
        true
    )
    .is_empty());
    assert!(views.current("browser-tree", replacement.token));
    assert!(views.current("browser-peer", peer.token));
}

#[test]
fn reload_tree_invalidation_retains_root_and_isolates_other_owners() {
    let views = EmbeddedViews::default();
    let root = views.reserve(OWNER, "browser-reload-tree").unwrap();
    let child = views.reserve(OWNER, "browser-popup-reload").unwrap();
    let other = "local-22222222-2222-4222-8222-222222222222";
    let peer = views.reserve(other, "browser-popup-peer").unwrap();
    let mut inner = views.0.lock().unwrap();
    for label in ["browser-popup-reload", "browser-popup-peer"] {
        inner.records.get_mut(label).unwrap().opener = Some("browser-reload-tree".into());
    }
    let removed = EmbeddedViews::take_tree(&mut inner, "browser-reload-tree", root.token, false);
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].1.token, child.token);
    assert_eq!(
        inner.records.get("browser-reload-tree").unwrap().token,
        root.token
    );
    assert_eq!(
        inner.records.get("browser-popup-peer").unwrap().token,
        peer.token
    );
}

#[test]
fn owner_cleanup_removes_ready_and_pending_children_without_touching_other_owners() {
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    WebviewWindowBuilder::new(&app, OWNER, WebviewUrl::default())
        .build()
        .unwrap();
    let window = app.get_window(OWNER).unwrap();
    let child = window
        .add_child(
            tauri::webview::WebviewBuilder::new("browser-ready", WebviewUrl::default()),
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(300, 200),
        )
        .unwrap();
    let views = EmbeddedViews::for_test(OWNER, child.label());
    let pending = views.reserve(OWNER, "browser-pending").unwrap();
    views.reserve(OTHER, "browser-other").unwrap();
    assert!(views
        .set_visible(app.handle(), OTHER, child.label(), true)
        .is_err());
    assert!(views
        .set_bounds(
            app.handle(),
            OTHER,
            child.label(),
            Bounds {
                x: 0,
                y: 0,
                width: 1,
                height: 1
            }
        )
        .is_err());
    assert!(views.close(app.handle(), OTHER, child.label()).is_err());
    assert!(app.get_webview(child.label()).is_some());
    views.remove_owner(app.handle(), OWNER);
    assert!(app.get_webview(child.label()).is_none());
    assert!(views.finish_creation("browser-pending", &pending).is_err());
    assert!(views.owned(OTHER, "browser-other").is_ok());
    views.close(app.handle(), OWNER, "browser-ready").unwrap();
    assert!(app.get_webview(OWNER).is_some());
}

#[test]
fn fullscreen_keeps_normal_bounds_and_owner_cleanup_restores_the_window() {
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    WebviewWindowBuilder::new(&app, OWNER, WebviewUrl::default())
        .build()
        .unwrap();
    let window = app.get_window(OWNER).unwrap();
    let child = window
        .add_child(
            tauri::webview::WebviewBuilder::new("browser-fullscreen", WebviewUrl::default()),
            PhysicalPosition::new(10, 20),
            PhysicalSize::new(300, 200),
        )
        .unwrap();
    let views = EmbeddedViews::for_test(OWNER, child.label());
    let normal = Bounds {
        x: 10,
        y: 20,
        width: 300,
        height: 200,
    };
    views
        .set_bounds(app.handle(), OWNER, child.label(), normal)
        .unwrap();
    views
        .set_fullscreen(app.handle(), child.label(), true)
        .unwrap();
    let saved = views.owned(OWNER, child.label()).unwrap().bounds;
    views
        .set_bounds(
            app.handle(),
            OWNER,
            child.label(),
            Bounds {
                width: 1600,
                height: 900,
                ..normal
            },
        )
        .unwrap();
    assert_eq!(views.owned(OWNER, child.label()).unwrap().bounds, saved);
    views
        .set_fullscreen(app.handle(), child.label(), false)
        .unwrap();
    assert!(views
        .owned(OWNER, child.label())
        .unwrap()
        .fullscreen
        .is_none());
    views
        .set_fullscreen(app.handle(), child.label(), true)
        .unwrap();
    views.remove_owner(app.handle(), OWNER);
    assert!(app.get_webview(child.label()).is_none());
    assert!(!window.is_fullscreen().unwrap());
}
#[test]
fn storage_identifiers_share_only_the_same_full_identity_and_domain() {
    let storage = Storage::from(browser_storage(std::path::Path::new("profile/browser")));
    assert_eq!(
        storage.directory,
        std::path::Path::new("profile/browser/shared-v1")
    );
    assert_eq!(storage.domain, "browser/shared-v1");
    let identity = super::StorageIdentity::new("dev".into(), "/home/me/config.yaml".into());
    let id = identity.identifier("browser/shared-v1");
    assert_eq!(
        id,
        [
            0xf8, 0x14, 0x9e, 0x7f, 0x1a, 0x96, 0x3c, 0x98, 0xdd, 0x87, 0xcc, 0xfa, 0x46, 0x6b,
            0x6f, 0xad
        ]
    );
    assert_eq!(id, identity.identifier("browser/shared-v1"));
    assert_ne!(id, identity.identifier("local"));
    assert_ne!(id, identity.identifier("remote/server"));
    assert_ne!(
        id,
        super::StorageIdentity::new("stable".into(), "/home/me/config.yaml".into())
            .identifier("browser/shared-v1")
    );
    assert_ne!(
        id,
        super::StorageIdentity::new("dev".into(), "/home/other/config.yaml".into())
            .identifier("browser/shared-v1")
    );
    // Length framing also separates identities containing the delimiter used by older stores.
    assert_ne!(
        super::StorageIdentity::new("a\0b".into(), "c".into()).identifier("browser/shared-v1"),
        super::StorageIdentity::new("a".into(), "b\0c".into()).identifier("browser/shared-v1"),
    );
    use sha2::{Digest, Sha256};
    let app_store: [u8; 16] = Sha256::digest(b"local")[..16].try_into().unwrap();
    assert_ne!(id, app_store);
    let cwd = std::path::Path::new("/home/me");
    let home = std::path::Path::new("/home/me");
    let normalized = |path| crate::identity::normalize_config_identity(Some(path), cwd, home);
    assert_eq!(
        super::StorageIdentity::new("dev".into(), normalized("config.json"))
            .identifier("browser/shared-v1"),
        super::StorageIdentity::new("dev".into(), normalized("./config.yaml"))
            .identifier("browser/shared-v1"),
    );
}
