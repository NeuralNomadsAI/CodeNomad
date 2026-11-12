use super::*;

fn id(value: u8) -> String {
    format!("00000000-0000-4000-8000-{value:012}")
}

#[test]
fn registry_tracks_uuid_labels_mru_and_folder_ack_order() {
    let mut registry = Registry::default();
    let first = registry.add(id(1), true).unwrap();
    let second = registry.add(id(2), true).unwrap();
    assert_eq!(registry.mru_label(), Some(second.label.clone()));
    assert_eq!(registry.mark_focused(&first.label), Some(first.id.clone()));
    assert_eq!(registry.mru_label(), Some(first.label.clone()));
    let record = registry.records.get_mut(&first.label).unwrap();
    record.pending_folders.push_back(PendingFolder {
        path: "one".to_string(),
        attempts: 0,
    });
    record.pending_folders.push_back(PendingFolder {
        path: "two".to_string(),
        attempts: 0,
    });
    assert_eq!(
        record
            .pending_folders
            .front()
            .map(|pending| pending.path.as_str()),
        Some("one")
    );
    assert_eq!(registry.remove(&first.label).unwrap().id, first.id);
    assert_eq!(registry.mru_label(), Some(second.label));
}

#[test]
fn registry_enforces_maximum_and_lowercase_labels() {
    let mut registry = Registry::default();
    for value in 0..MAX_LOCAL_WINDOWS {
        registry.add(id(value as u8), true).unwrap();
    }
    assert_eq!(
        registry.add(id(99), false).unwrap_err(),
        "Too many local windows"
    );
}

#[test]
fn new_window_admission_ignores_hidden_launch_windows() {
    let windows = LocalWindows::default();
    {
        let mut registry = windows.registry.lock().unwrap();
        registry.add_window(id(99), false, true).unwrap();
        for value in 0..MAX_LOCAL_WINDOWS - 1 {
            registry.add(id(value as u8), true).unwrap();
        }
    }
    // create_new_window's preflight: sixteen records, fifteen of them user windows.
    assert_eq!(windows.records().len(), MAX_LOCAL_WINDOWS);
    assert!(windows.has_user_window_capacity());
    windows.registry.lock().unwrap().add(id(98), true).unwrap();
    assert!(!windows.has_user_window_capacity());
    assert_eq!(
        windows.connect_only_labels(),
        vec![local_window_label(&id(99)).unwrap()]
    );
    assert!(windows.is_connect_only(&local_window_label(&id(99)).unwrap()));
    assert!(!windows.is_connect_only(&local_window_label(&id(0)).unwrap()));
    // Shutdown asks only user windows' renderers to persist their state.
    let user_labels = windows.user_window_labels();
    assert_eq!(user_labels.len(), MAX_LOCAL_WINDOWS);
    assert!(!user_labels.contains(&local_window_label(&id(99)).unwrap()));
}

#[test]
fn only_a_user_window_closing_beside_another_one_forgets_its_saved_state() {
    let windows = LocalWindows::default();
    let (first, second) = {
        let mut registry = windows.registry.lock().unwrap();
        // A hidden launch window and remote windows never count: they hold no local state.
        registry.add_window(id(99), false, true).unwrap();
        (
            registry.add(id(1), true).unwrap().label,
            registry.add(id(2), true).unwrap().label,
        )
    };
    assert!(windows.has_other_user_window(&first, |_| false));
    // The other one is already closing: this is the last local window, which keeps its state.
    assert!(!windows.has_other_user_window(&first, |label| label == second));
    windows.remove_runtime(&second);
    assert!(!windows.has_other_user_window(&first, |_| false));
}

#[test]
fn connect_only_launches_defer_the_preferences_restore_until_a_normal_start() {
    let windows = LocalWindows::default();
    assert!(!windows.startup_restore_deferred());
    windows.defer_startup_restore();
    assert!(windows.startup_restore_deferred());
    windows.release_startup_restore();
    assert!(!windows.startup_restore_deferred());
}

#[test]
fn hidden_launch_windows_hold_no_slot_and_are_never_launch_targets() {
    let mut registry = Registry::default();
    let launch = registry.add_window(id(99), false, true).unwrap();
    assert_eq!(
        registry.mru_label(),
        None,
        "folder launches never land in it"
    );
    assert_eq!(registry.mark_focused(&launch.label), None);
    assert_eq!(registry.mru_label(), None);
    for value in 0..MAX_LOCAL_WINDOWS {
        registry.add(id(value as u8), true).unwrap();
    }
    assert_eq!(
        registry.add(id(98), true).unwrap_err(),
        "Too many local windows",
        "all sixteen saved windows restore beside the hidden one"
    );
    assert_ne!(registry.mru_label(), Some(launch.label.clone()));
    registry.promote(&launch.label);
    assert_eq!(registry.mru_label(), Some(launch.label));
}

#[test]
fn hidden_launch_windows_settle_by_outcome() {
    let mut registry = Registry::default();
    let launch = registry.add_window(id(1), false, true).unwrap();
    registry
        .queue_connection(&launch.label, "prod".into(), None)
        .unwrap();
    assert_eq!(
        registry.next_connection(&launch.label).unwrap(),
        Some(PendingConnectionPayload {
            target: "prod".into(),
            failure: None,
            hidden: true,
        })
    );
    assert_eq!(
        registry
            .acknowledge_connection(&launch.label, "prod", None, false)
            .unwrap(),
        ConnectionSettlement::Close
    );

    registry
        .queue_connection(&launch.label, "missing".into(), None)
        .unwrap();
    registry
        .queue_connection(&launch.label, "later".into(), None)
        .unwrap();
    assert!(registry
        .acknowledge_connection(&launch.label, "later", None, false)
        .unwrap_err()
        .contains("out of order"));
    assert_eq!(
        registry
            .acknowledge_connection(&launch.label, "missing", Some("unknown".into()), false)
            .unwrap(),
        ConnectionSettlement::StartNormally(VecDeque::from([
            PendingConnection {
                target: "missing".into(),
                failure: Some("unknown".into()),
            },
            PendingConnection {
                target: "later".into(),
                failure: None,
            },
        ]))
    );
    assert_eq!(registry.next_connection(&launch.label).unwrap(), None);

    registry
        .queue_connection(&launch.label, "self-signed".into(), None)
        .unwrap();
    assert_eq!(
        registry
            .acknowledge_connection(&launch.label, "self-signed", None, true)
            .unwrap(),
        ConnectionSettlement::StartNormally(VecDeque::from([PendingConnection {
            target: "self-signed".into(),
            failure: None,
        }])),
        "a connection that needs a prompt runs in a visible window"
    );

    registry
        .queue_connection(&launch.label, "slow".into(), None)
        .unwrap();
    assert_eq!(registry.abandon_connections(&launch.label).len(), 1);
    assert!(registry.abandon_connections(&launch.label).is_empty());
}

#[test]
fn ordinary_windows_report_their_own_failures_and_stay_open() {
    let mut registry = Registry::default();
    let local = registry.add(id(1), true).unwrap();
    registry
        .queue_connection(
            &local.label,
            "missing".into(),
            Some("No saved server".into()),
        )
        .unwrap();
    registry
        .queue_connection(&local.label, "down".into(), None)
        .unwrap();
    assert_eq!(
        registry.next_connection(&local.label).unwrap(),
        Some(PendingConnectionPayload {
            target: "missing".into(),
            failure: Some("No saved server".into()),
            hidden: false,
        })
    );
    assert_eq!(
        registry
            .acknowledge_connection(&local.label, "missing", None, false)
            .unwrap(),
        ConnectionSettlement::Keep
    );
    assert_eq!(
        registry
            .acknowledge_connection(&local.label, "down", Some("unreachable".into()), false)
            .unwrap(),
        ConnectionSettlement::Keep
    );
    assert!(registry.abandon_connections(&local.label).is_empty());
}

#[test]
fn remote_focus_never_falls_through_to_background_local() {
    let local = format!("local-{}", id(1));
    assert_eq!(
        select_local_label(Some("remote-profile"), Some(&local)),
        None
    );
    assert_eq!(select_local_label(None, Some(&local)), Some(local.clone()));
    assert_eq!(select_local_label(Some(&local), None), Some(local));
}

#[test]
fn updates_requested_from_preferences_or_remote_run_in_the_last_local_window() {
    let local = format!("local-{}", id(1));
    let other = format!("local-{}", id(2));
    for focused in ["preferences", "remote-profile"] {
        assert_eq!(select_update_label(Some(focused), Some(&local)), Some(local.clone()));
    }
    assert_eq!(select_update_label(Some(&other), Some(&local)), Some(other));
    assert_eq!(select_update_label(Some("preferences"), None), None);
}

#[test]
fn browser_children_are_not_top_level_focus_targets() {
    let local = format!("local-{}", id(1));
    assert!(is_primary_webview_label(&local, &local));
    assert!(!is_primary_webview_label("browser-registration", &local));
}

#[test]
fn menu_toggle_during_native_focus_gap_keeps_view_and_file_commands_enabled() {
    let windows = LocalWindows::default();
    let local = windows.registry.lock().unwrap().add(id(1), true).unwrap();
    let snapshot = |checked| {
        serde_json::from_value::<crate::view_menu::ViewMenuState>(serde_json::json!({
            "leftPanel": { "label": "Left", "checked": checked, "enabled": true },
            "rightPanel": { "label": "Right", "checked": true, "enabled": true },
            "timeline": { "label": "Timeline", "checked": true, "enabled": true }
        })).unwrap()
    };
    windows.set_workspace_menu_enabled(&local.label, true).unwrap();
    windows.set_view_menu_state(&local.label, Some(snapshot(true))).unwrap();
    assert_eq!(windows.menu_state(Some(&local.label)), (true, Some(snapshot(true))));

    // The native popup temporarily owns focus, then the renderer publishes the
    // unchecked panel. Both menus must retain the same target as click dispatch.
    assert_eq!(windows.menu_state(None), (true, Some(snapshot(true))));
    windows.set_view_menu_state(&local.label, Some(snapshot(false))).unwrap();
    assert_eq!(windows.menu_state(None), (true, Some(snapshot(false))));
    assert_eq!(windows.menu_state(Some(&local.label)), (true, Some(snapshot(false))));

    for non_local in ["remote-profile", crate::preferences_window::LABEL] {
        assert_eq!(windows.menu_state(Some(non_local)), (false, None));
    }
    let other = windows.registry.lock().unwrap().add(id(2), true).unwrap();
    assert_eq!(windows.menu_state(Some(&local.label)), (true, Some(snapshot(false))));
    assert_eq!(windows.menu_state(None), (false, None), "new MRU has no project");
    windows.remove_runtime(&other.label);
    assert_eq!(windows.menu_state(None), (true, Some(snapshot(false))));
    windows.set_workspace_menu_enabled(&local.label, false).unwrap();
    assert_eq!(windows.menu_state(None), (false, None), "reload clears both snapshots");
    windows.remove_runtime(&local.label);
    assert_eq!(windows.menu_state(None), (false, None), "closed windows cannot remain targets");
}

#[test]
fn initial_local_document_is_an_offline_about_blank() {
    // Windows gates the custom protocol and loopback on proxy/PAC resolution;
    // about:blank never touches the network, so the window can paint at t=0.
    let WebviewUrl::External(url) = local_window_initial_url() else {
        panic!("the initial local document must be an external URL");
    };
    assert_eq!(url.as_str(), "about:blank");
}

#[test]
fn local_window_initialization_script_appends_the_boot_splash() {
    let script = local_window_initialization_script("window-1");
    assert!(script.starts_with(LOCAL_WINDOW_CONTEXT_SCRIPT));
    assert!(script.contains("window.__CODENOMAD_WINDOW_ID__ = \"window-1\";"));
    assert!(
        script.ends_with(BOOT_SPLASH_SCRIPT),
        "the boot splash must run in the initial about:blank document"
    );
}

#[test]
fn window_created_after_error_publication_opens_the_loading_page() {
    // A published failure routes every window through show_loading_all(),
    // which clears the backend target. A window built afterwards navigates
    // via local_window_initial_destination — the same production call
    // build_local_window makes — and must reach the loading page (which
    // displays the error), not sit on the static splash forever.
    let after_error = LocalWindows::default();
    assert_eq!(after_error.backend_target(), None);
    assert_eq!(
        local_window_initial_destination(after_error.backend_target().as_deref()),
        LOADING_PAGE_URL,
        "a window created after a published error must reach the loading page"
    );

    // With a ready backend the destination stays the backend target.
    let mut ready = LocalWindows::default();
    ready.set_backend_target(Some("http://127.0.0.1:9899/".to_string()));
    assert_eq!(
        local_window_initial_destination(ready.backend_target().as_deref()),
        "http://127.0.0.1:9899/"
    );
}

/// Node harness executing the real `boot_splash.js` against fake realms:
/// the committed guards are checked as behavior (what mounts, what stays
/// untouched, what repeated execution does), not as substrings.
const BOOT_SPLASH_BEHAVIOR_HARNESS: &str = r###"
import { readFileSync } from 'node:fs'

const source = readFileSync(process.argv[2], 'utf8')
const failures = []
const check = (name, ok) => { if (!ok) failures.push(name) }

function makeElement(tag) {
  return {
    tag,
    id: null,
    role: null,
    innerHTML: null,
    textContent: null,
    setAttribute(name, value) { if (name === 'role') this.role = value },
  }
}

function makeRealm({ href, isTop = true, hasBody = true }) {
  const appended = []
  const listeners = []
  const document = {
    title: null,
    body: hasBody ? { appendChild: (node) => appended.push(['body', node]) } : null,
    head: { appendChild: (node) => appended.push(['head', node]) },
    documentElement: { appendChild: (node) => appended.push(['documentElement', node]) },
    createElement: makeElement,
    addEventListener: (type, fn, options) => listeners.push({ type, fn, options }),
  }
  const window = { location: { href } }
  window.top = isTop ? window : {}
  return { window, document, appended, listeners }
}

const run = (realm) => {
  const execute = new Function('window', 'document', source)
  execute(realm.window, realm.document)
}

const splashNodes = (realm) =>
  realm.appended.filter(([, node]) => node.tag === 'div' && node.id === 'codenomad-boot')

// A top-level about:blank document with a body mounts the splash immediately.
{
  const realm = makeRealm({ href: 'about:blank' })
  run(realm)
  check('top-level blank sets the title', realm.document.title === 'CodeNomad')
  check('top-level blank marks the realm', realm.window.__CODENOMAD_BOOT__ === true)
  check('top-level blank mounts one splash', splashNodes(realm).length === 1)
  const mounted = realm.appended.find(([, node]) => node.id === 'codenomad-boot')
  check('splash mounts on the body', mounted !== undefined && mounted[0] === 'body')
  check('splash announces status', mounted !== undefined && mounted[1].role === 'status')
  check(
    'splash embeds logo, title and spinner',
    mounted !== undefined &&
      mounted[1].innerHTML.includes('<svg') &&
      mounted[1].innerHTML.includes('boot-title') &&
      mounted[1].innerHTML.includes('boot-spinner'),
  )
  check(
    'splash styles reach the head',
    realm.appended.some(([parent, node]) => parent === 'head' && node.tag === 'style'),
  )
}

// A top-level about:blank before the body exists defers to DOMContentLoaded.
{
  const realm = makeRealm({ href: 'about:blank', hasBody: false })
  run(realm)
  check('no body defers mounting', realm.appended.length === 0)
  check(
    'no body registers one once-only DOMContentLoaded listener',
    realm.listeners.length === 1 &&
      realm.listeners[0].type === 'DOMContentLoaded' &&
      realm.listeners[0].options.once === true,
  )
  if (realm.listeners[0]) realm.listeners[0].fn()
  check('DOMContentLoaded mounts the splash', splashNodes(realm).length === 1)
}

// Real documents stay untouched.
{
  const realm = makeRealm({ href: 'http://127.0.0.1:9899/' })
  run(realm)
  check(
    'real document is not modified',
    realm.appended.length === 0 &&
      realm.listeners.length === 0 &&
      realm.document.title === null &&
      realm.window.__CODENOMAD_BOOT__ === undefined,
  )
}

// Subframes stay untouched even on about:blank.
{
  const realm = makeRealm({ href: 'about:blank', isTop: false })
  run(realm)
  check(
    'subframe is not modified',
    realm.appended.length === 0 &&
      realm.listeners.length === 0 &&
      realm.window.__CODENOMAD_BOOT__ === undefined,
  )
}

// Repeated execution stays idempotent.
{
  const realm = makeRealm({ href: 'about:blank' })
  run(realm)
  run(realm)
  check('repeated execution mounts one splash', splashNodes(realm).length === 1)
}

if (failures.length > 0) {
  console.error(`boot splash behavior failures: ${failures.join('; ')}`)
  process.exit(1)
}
"###;

#[test]
fn boot_splash_guards_run_and_mount_like_the_browser_does() {
    let node = std::env::var("CODENOMAD_TEST_NODE").unwrap_or_else(|_| "node".into());
    let directory = tempfile::tempdir().unwrap();
    let splash = directory.path().join("boot-splash.js");
    std::fs::write(&splash, BOOT_SPLASH_SCRIPT).unwrap();
    let harness = directory.path().join("boot-splash-behavior.mjs");
    std::fs::write(&harness, BOOT_SPLASH_BEHAVIOR_HARNESS).unwrap();
    let output = std::process::Command::new(&node)
        .arg(harness)
        .arg(splash)
        .output()
        .expect("node is required to execute the boot splash behavior checks");
    assert!(
        output.status.success(),
        "boot splash behavior checks failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn boot_splash_has_no_network_or_storage_dependencies() {
    for forbidden in [
        "fetch(",
        "XMLHttpRequest",
        "WebSocket",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        " src=",
        "import ",
    ] {
        assert!(
            !BOOT_SPLASH_SCRIPT.contains(forbidden),
            "the boot splash must not use {forbidden}"
        );
    }
}

#[test]
fn boot_splash_renders_the_real_logo_and_loading_palette() {
    let logo = include_str!("../../../ui/src/images/CodeNomad-Logo-OnDark.svg");
    let mut paths = 0;
    for path in logo.split("d=\"").skip(1) {
        let data = path.split('"').next().unwrap();
        assert!(!data.is_empty());
        assert!(
            BOOT_SPLASH_SCRIPT.contains(data),
            "the boot splash must embed the checked-in on-dark logo"
        );
        paths += 1;
    }
    assert_eq!(paths, 2, "the on-dark logo has two paths");
    assert!(BOOT_SPLASH_SCRIPT.contains("viewBox=\"-100 -115.47 200 230.94\""));
    for visual in [
        "#1a1a1a",
        "#cfd4dc",
        "rgba(255, 255, 255, 0.18)",
        "#0080ff",
        "5.3rem",
        "CodeNomad",
        "@keyframes",
    ] {
        assert!(
            BOOT_SPLASH_SCRIPT.contains(visual),
            "the boot splash must copy the loading page visuals: {visual}"
        );
    }
}
