use super::*;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::{WebviewUrl, WebviewWindowBuilder};

const OWNER: &str = "local-11111111-1111-4111-8111-111111111111";
const OTHER: &str = "local-22222222-2222-4222-8222-222222222222";

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
        Some(false)
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
        Some(false)
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
