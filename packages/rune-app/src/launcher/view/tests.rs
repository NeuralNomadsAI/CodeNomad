use super::*;
use crate::components::button;
use rune::{Cx, Env, Runtime};

fn view(s: &State, _: &mut Cx<State>) -> El {
    let action = if s.paging {
        button_tx(
            "action",
            t("rune.refresh"),
            false,
            crate::screen::action_tx(&s.input_scope, |s, tx| {
                s.draft.text.push_str("accepted");
                tx.focus("destination", true);
            }),
        )
    } else {
        button(
            "action",
            t("rune.refresh"),
            false,
            crate::screen::action(&s.input_scope, |s| s.draft.text.push_str("accepted")),
        )
    };
    col()
        .child(action)
        .child(text(t("rune.refresh")).key("destination").focusable(true))
}

#[test]
fn queued_actions_keep_their_screen_scope_and_tx() {
    for tx in [false, true] {
        let mut s = crate::init();
        s.paging = tx;
        let mut rt = Runtime::new(s, view, (320.0, 180.0), Env::new(false, 1.0));
        rt.frame(1.0);
        let (x, y) = rt.find("action").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        // The gesture is queued against the old tree when a session replaces its scope.
        rt.state.renew_scope();
        rt.frame(0.02);
        assert!(rt.state.draft.text.is_empty());

        rt.update(|_, _| {});
        rt.frame(0.02);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert_eq!(rt.state.draft.text, "accepted");
        let destination = rt
            .elements()
            .into_iter()
            .find(|node| node.key.as_deref() == Some("destination"))
            .unwrap();
        assert_eq!(destination.focused, tx);
    }
}

fn web_view(s: &State, cx: &mut Cx<State>) -> El {
    cx.web_focus();
    view(s, cx)
}

#[test]
fn web_focus_keyboard_actions_keep_their_screen_scope_and_tx() {
    for transactional in [false, true] {
        for key in [rune::Key::Enter, rune::Key::Text(" ".into())] {
            let mut s = crate::init();
            s.paging = transactional;
            let mut rt = Runtime::new(s, web_view, (320.0, 180.0), Env::new(false, 1.0));
            rt.frame(0.0);
            rt.update(|_, tx| tx.focus("action", true));
            rt.frame(0.0);
            let event = rune::KeyEvent {
                key,
                mods: rune::Mods::default(),
            };
            rt.key(event.clone());
            rt.state.renew_scope();
            rt.frame(0.0);
            rt.key_up(event.clone());
            rt.frame(0.0);
            assert!(
                rt.state.draft.text.is_empty(),
                "queued activation keeps old screen scope"
            );
            assert!(
                !rt.elements()
                    .iter()
                    .any(|node| node.key.as_deref() == Some("destination") && node.focused)
            );

            rt.update(|_, _| {});
            rt.frame(0.0);
            rt.key(event.clone());
            rt.frame(0.0);
            rt.key_up(event);
            rt.frame(0.0);
            assert_eq!(rt.state.draft.text, "accepted");
            let destination = rt
                .elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some("destination"))
                .unwrap();
            assert_eq!(
                destination.focused, transactional,
                "original Tx reaches the destination"
            );
        }
    }
}

fn launcher_state() -> State {
    let mut s = crate::init();
    s.screen = crate::Screen::Launcher(Box::new(launcher::Launcher::fixture()));
    s
}

fn product_root_with_probe(s: &State, cx: &mut Cx<State>) -> El {
    let probe = text(t("rune.refresh"))
        .key("web-focus-probe")
        .role("button")
        .label(t("rune.refresh"))
        .on_press(|_: &mut State| {});
    col().child(probe).child(crate::view(s, cx))
}

#[test]
fn product_root_enables_web_focus_for_launcher_controls() {
    let mut rt = Runtime::new(
        launcher_state(),
        product_root_with_probe,
        (960.0, 640.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    // Without .focusable(true), a pressable role="button" only takes focus when
    // crate::view enables Cx::web_focus() through settings::render.
    rt.update(|_, tx| tx.focus("web-focus-probe", true));
    rt.frame(0.0);
    assert!(
        rt.elements()
            .iter()
            .any(|node| node.key.as_deref() == Some("web-focus-probe") && node.focused),
        "product root must enable shared web_focus so pressable buttons without focusable(true) take focus"
    );
}

#[test]
fn launcher_address_and_password_fields_preserve_focus_editing_and_a11y() {
    let mut s = launcher_state();
    s.screen.launcher_mut().unwrap().address = rune::TextEdit::new("");
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.frame(0.0);

    let click_and_type = |rt: &mut Runtime<State>, key: &str, text: &str| {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        rt.key(rune::KeyEvent {
            key: rune::Key::Text(text.into()),
            mods: rune::Mods::default(),
        });
        rt.frame(0.02);
    };

    click_and_type(&mut rt, "server-address", "https://demo.local:9898");
    click_and_type(&mut rt, "server-password", "s3cr3t-launcher-pass");

    let l = rt.state.screen.launcher().unwrap();
    assert_eq!(l.address.text, "https://demo.local:9898");
    assert_eq!(l.password.text, "s3cr3t-launcher-pass");

    let elements = rt.elements();
    let addr = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("server-address"))
        .unwrap();
    let pass = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("server-password"))
        .unwrap();
    assert_eq!(addr.role, "textbox");
    assert_eq!(pass.role, "textbox");
    assert!(
        !elements
            .iter()
            .any(|n| n.text.as_deref() == Some("s3cr3t-launcher-pass")),
        "secure launcher password must never leak into ElementInfo::text"
    );
    let a11y = rt.a11y_json();
    assert!(a11y.contains("https://demo.local:9898"));
    assert!(
        !a11y.contains("s3cr3t-launcher-pass"),
        "secure launcher password must never leak into a11y_json"
    );
}

#[test]
fn direct_recovery_fields_mount_inside_dialog_without_leaking_password() {
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    crate::chat::authentication::expired(
        &mut s,
        codenomad_client::transport::Authentication {
            backend,
            confirmed: true,
        },
    );
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.frame(0.0);

    let elements = rt.elements();
    let dialog = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("direct-recovery-dialog"))
        .unwrap();
    let user = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("direct-recovery-username"))
        .unwrap();
    let pass = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("direct-recovery-password"))
        .unwrap();
    assert_eq!(dialog.role, "dialog");
    let dialog_prefix = format!("{}/", dialog.path);
    assert!(
        user.path.starts_with(&dialog_prefix) && pass.path.starts_with(&dialog_prefix),
        "username and password must be descendants of the recovery dialog"
    );
    let has_intervening_scope = |field_path: &str| {
        elements.iter().any(|n| {
            n.path.starts_with(&dialog_prefix)
                && field_path.starts_with(&format!("{}/", n.path))
                && matches!(n.role, "form" | "dialog" | "alertdialog")
        })
    };
    assert!(
        !has_intervening_scope(&user.path) && !has_intervening_scope(&pass.path),
        "no intermediate form or dialog scope may split recovery username and password"
    );

    let (ux, uy) = rt.find("direct-recovery-username").unwrap();
    rt.pointer_down(ux, uy);
    rt.pointer_up(ux, uy);
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("-admin".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);

    let (px, py) = rt.find("direct-recovery-password").unwrap();
    rt.pointer_down(px, py);
    rt.pointer_up(px, py);
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("s3cr3t-recovery-pass".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);

    assert_eq!(
        rt.state.direct_authentication.username.text,
        "codenomad-admin"
    );
    assert_eq!(
        rt.state.direct_authentication.password.text,
        "s3cr3t-recovery-pass"
    );
    assert!(
        !rt.a11y_json().contains("s3cr3t-recovery-pass"),
        "secure recovery password must never leak into a11y_json"
    );
}

#[test]
fn recent_folder_display_and_keys_match_solid_contract() {
    let split = |p| {
        let (base, dir) = recent::split_folder_path(p);
        (base.into_owned(), dir)
    };
    assert_eq!(
        split("/Users/alice/work/app"),
        ("app".into(), "/Users/alice/work")
    );
    assert_eq!(split("D:\\CodeNomad\\"), ("CodeNomad".into(), "D:"));
    assert_eq!(split("C:\\"), ("C:\\".into(), ""));
    assert_eq!(split("/"), ("/".into(), ""));
    assert_eq!(
        split("\\\\srv\\share\\repo"),
        ("repo".into(), "\\\\srv\\share")
    );
    assert_eq!(
        recent::project_display_name("/Users/alice/work/app", None),
        "app"
    );
    assert_eq!(
        recent::project_display_name("/Users/alice/work/app", Some("  Custom App  ")),
        "Custom App"
    );
    assert_eq!(recent::display_path("/Users/alice/work/app"), "~/work/app");
    assert_eq!(recent::display_path("/home/bob/src"), "~/src");
    assert_eq!(
        recent::display_path("C:\\Users\\Admin\\CodeNomad"),
        "~\\CodeNomad"
    );
    assert_eq!(
        recent::display_path("C:/Users/Admin/CodeNomad"),
        "~/CodeNomad"
    );
    assert_eq!(recent::display_path("D:\\CodeNomad"), "D:\\CodeNomad");

    assert_eq!(recent::split_folder_path("C:/").0.as_ref(), "C:\\");
    assert_eq!(recent::display_path("/Users/"), "/Users/");
    assert_eq!(recent::display_path("/Users//alice"), "/Users//alice");
    assert_eq!(
        recent::path_menu_key("C:/Users/Alice/Repo/"),
        recent::path_menu_key("c:\\users\\alice\\repo")
    );
    assert_eq!(
        recent::recent_row_key("C:/Users/Alice/Repo/"),
        recent::recent_row_key("c:\\users\\alice\\repo")
    );
    assert_eq!(
        recent::open_badge_key("C:/Users/Alice/Repo/"),
        recent::open_badge_key("c:\\users\\alice\\repo")
    );

    crate::strings::with_locale("en", || {
        assert_eq!(recent::format_item_count(1), "1 item");
        assert_eq!(recent::format_item_count(3), "3 items");
        assert_eq!(recent::format_relative_time(10_000, 15_000), "just now");
        assert_eq!(recent::format_relative_time(0, 5 * 60_000), "5m ago");
        assert_eq!(recent::format_relative_time(0, 2 * 3_600_000), "2h ago");
        assert_eq!(recent::format_relative_time(0, 3 * 86_400_000), "3d ago");
    });
}

fn connected_home_state() -> State {
    let mut s = launcher_state();
    let mut ui = workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let open_project = crate::catalog::Project {
        id: "p-alpha".into(),
        path: "/Users/alice/work/alpha".into(),
        temporary: false,
    };
    let closed_project = crate::catalog::Project {
        id: "p-beta".into(),
        path: "/Users/alice/work/beta".into(),
        temporary: false,
    };
    if let Some(l) = s.screen.launcher_mut() {
        l.connection = Some(backend);
        l.server_id = Some("srv-1".into());
        l.projects = vec![open_project.clone(), closed_project];
        l.project = Some(open_project.clone());
    }
    workspace::opened(&mut s, &open_project);
    let mut rt = Runtime::new(s, crate::view, (1040.0, 720.0), Env::new(false, 1.0));
    rt.update(workspace::new_tab);
    rt.state
}

#[test]
fn home_view_adapts_between_two_columns_on_desktop_and_stacked_on_mobile() {
    let mut desktop = Runtime::new(
        connected_home_state(),
        crate::view,
        (1040.0, 720.0),
        Env::new(false, 1.0),
    );
    desktop.frame(0.0);
    desktop.frame(0.02);
    let elements = desktop.elements();
    let browse = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("launcher-browse-card"))
        .expect("browse card on desktop");
    let recent = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("launcher-recent-card"))
        .expect("recent card on desktop");
    assert!(
        browse.rect[0] + browse.rect[2] <= recent.rect[0] + 1.0,
        "desktop cards must sit side by side: browse={:?} recent={:?}",
        browse.rect,
        recent.rect
    );
    assert!(
        recent.rect[0] + recent.rect[2] <= 1040.0 + 0.5,
        "right column must stay inside viewport: recent={:?}",
        recent.rect
    );
    assert!(desktop.find("launcher-home-columns-desktop").is_some());
    assert!(desktop.find("folder-path").is_some());
    assert!(desktop.find("open-folder").is_some());
    assert!(desktop.find("browse").is_some());
    assert!(desktop.find("project-p-alpha").is_some());
    assert!(desktop.find("project-p-beta").is_some());
    let open_rect = elements
        .iter()
        .find(|n| n.key.as_deref() == Some("open-folder"))
        .expect("open button")
        .rect;
    assert!(
        open_rect[0] + open_rect[2] <= browse.rect[0] + browse.rect[2] + 0.5,
        "open button must fit inside browse card: open={open_rect:?} browse={:?}",
        browse.rect
    );

    let mut mobile = Runtime::new(
        connected_home_state(),
        crate::view,
        (390.0, 844.0),
        Env::new(false, 1.0),
    );
    mobile.frame(0.0);
    mobile.frame(0.02);
    let m_elements = mobile.elements();
    let m_browse = m_elements
        .iter()
        .find(|n| n.key.as_deref() == Some("launcher-browse-card"))
        .expect("browse card on mobile");
    let m_recent = m_elements
        .iter()
        .find(|n| n.key.as_deref() == Some("launcher-recent-card"))
        .expect("recent card on mobile");
    assert!(
        m_browse.rect[1] + m_browse.rect[3] <= m_recent.rect[1] + 1.0,
        "mobile cards must stack vertically: browse={:?} recent={:?}",
        m_browse.rect,
        m_recent.rect
    );
    assert!(mobile.find("launcher-home-columns-stacked").is_some());
}

#[test]
fn home_view_open_badge_switches_tab_and_recent_menu_renames_and_removes() {
    let mut rt = Runtime::new(
        connected_home_state(),
        crate::view,
        (1040.0, 720.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    rt.frame(0.02);

    // Alpha is open in tab-0; beta is closed -> only alpha gets the OPEN badge.
    assert!(crate::shell::launcher_replaces_project(&rt.state));
    let alpha_open_key = recent::open_badge_key("/Users/alice/work/alpha");
    let beta_open_key = recent::open_badge_key("/Users/alice/work/beta");
    assert!(rt.find(&alpha_open_key).is_some());
    assert!(rt.find(&beta_open_key).is_none());

    // Open menu on beta by stable path key, click Rename, reject empty commit, then commit new name.
    let beta_menu = recent::path_menu_key("/Users/alice/work/beta");
    let beta_trigger = format!("{beta_menu}:trigger");
    let (mx, my) = rt.find(&beta_trigger).unwrap();
    rt.pointer_down(mx, my);
    rt.pointer_up(mx, my);
    rt.frame(0.02);
    let (rx, ry) = rt
        .find(&format!("{beta_menu}:item:rename"))
        .expect("rename item in recent actions menu");
    rt.pointer_down(rx, ry);
    rt.pointer_up(rx, ry);
    rt.frame(0.02);
    rt.update(|s, tx| {
        launcher::poll(s, tx);
    });
    rt.frame(0.02);
    assert!(
        crate::shell::tab_rename::is_open(&rt.state),
        "Rename action must open shared ProjectRenameDialog"
    );
    // Clearing to whitespace and committing keeps the dialog open on a recent folder.
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("   ".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    rt.update(crate::shell::tab_rename::commit);
    rt.frame(0.02);
    assert!(
        crate::shell::tab_rename::is_open(&rt.state),
        "Empty rename on recent folder must keep dialog open"
    );
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("Beta Custom".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    rt.update(crate::shell::tab_rename::commit);
    rt.frame(0.02);
    assert!(!crate::shell::tab_rename::is_open(&rt.state));
    let beta_entry = recent::collect_recent_entries(&rt.state)
        .into_iter()
        .find(|e| e.path == "/Users/alice/work/beta")
        .unwrap();
    assert_eq!(beta_entry.display_name, "Beta Custom");

    // Empty rename input leaves existing custom name intact.
    launcher::rename_recent(&mut rt.state, "/Users/alice/work/beta", "   ");
    let beta_after_empty = recent::collect_recent_entries(&rt.state)
        .into_iter()
        .find(|e| e.path == "/Users/alice/work/beta")
        .unwrap();
    assert_eq!(beta_after_empty.display_name, "Beta Custom");

    // Open menu on beta again and Remove from recent.
    let (mx, my) = rt.find(&beta_trigger).unwrap();
    rt.pointer_down(mx, my);
    rt.pointer_up(mx, my);
    rt.frame(0.02);
    let (dx, dy) = rt
        .find(&format!("{beta_menu}:item:remove"))
        .expect("remove item in recent actions menu");
    rt.pointer_down(dx, dy);
    rt.pointer_up(dx, dy);
    rt.frame(0.02);
    rt.update(|s, tx| {
        launcher::poll(s, tx);
    });
    rt.frame(0.02);
    assert!(
        recent::collect_recent_entries(&rt.state)
            .iter()
            .all(|e| e.path != "/Users/alice/work/beta"),
        "Removed project must disappear from recent entries"
    );

    // Clicking the OPEN badge on alpha switches away from the blank New tab to tab-0.
    assert!(
        workspace::active_workspace(&rt.state).is_none(),
        "Blank New tab must be active before clicking OPEN badge"
    );
    let alpha_tab_key = workspace::open_tab_for_folder(&rt.state, "/Users/alice/work/alpha")
        .expect("alpha open tab key");
    let (ox, oy) = rt.find(&alpha_open_key).unwrap();
    rt.pointer_down(ox, oy);
    rt.pointer_up(ox, oy);
    rt.frame(0.02);
    assert_eq!(
        workspace::active_workspace(&rt.state).map(|(key, w)| (key, w.folder.as_str())),
        Some((alpha_tab_key.as_str(), "/Users/alice/work/alpha")),
        "OPEN badge must switch the active tab from the blank tab to alpha"
    );
    assert!(
        !crate::shell::launcher_replaces_project(&rt.state),
        "Home view must give way to the selected open project tab"
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn home_view_recents_sort_and_patch_persistence_coalescing_and_rollback() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let addr = listener.local_addr().unwrap();
    let patches: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let fail_next = Arc::new(AtomicBool::new(false));
    let gate_first = Arc::new(AtomicBool::new(false));
    let (gate_tx, gate_rx) = mpsc::channel::<()>();
    let (entered_tx, entered_rx) = mpsc::channel::<()>();

    let patches_srv = patches.clone();
    let fail_srv = fail_next.clone();
    let gate_srv = gate_first.clone();
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut header_end = None;
            let mut content_len = 0usize;
            loop {
                let Ok(n) = stream.read(&mut chunk) else {
                    break;
                };
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if header_end.is_none()
                    && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
                {
                    header_end = Some(pos + 4);
                    let headers = String::from_utf8_lossy(&buf[..pos]);
                    for line in headers.lines() {
                        if let Some((k, v)) = line.split_once(':')
                            && k.trim().eq_ignore_ascii_case("content-length")
                        {
                            content_len = v.trim().parse().unwrap_or(0);
                        }
                    }
                }
                if let Some(end) = header_end
                    && buf.len() >= end + content_len
                {
                    break;
                }
            }
            let Some(end) = header_end else {
                continue;
            };
            let body_bytes = &buf[end..buf.len().min(end + content_len)];
            let body: serde_json::Value =
                serde_json::from_slice(body_bytes).unwrap_or(serde_json::Value::Null);
            let should_gate = gate_srv.swap(false, Ordering::SeqCst);
            if should_gate {
                let _ = entered_tx.send(());
                let _ = gate_rx.recv();
            }
            let should_fail = fail_srv.swap(false, Ordering::SeqCst);
            patches_srv.lock().unwrap().push(body.clone());
            let response = if should_fail {
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_owned()
            } else {
                let payload = body.to_string();
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    payload.len(),
                    payload
                )
            };
            let _ = stream.write_all(response.as_bytes());
        }
    });

    let mut s = connected_home_state();
    let backend = crate::backend::Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
    s.screen.launcher_mut().unwrap().connection = Some(backend);
    settings::fixture_state(
        &mut s,
        serde_json::json!({
            "recentFolders": [
                { "path": "/Users/alice/work/alpha", "lastAccessed": 1000, "projectName": "Alpha Saved" },
                { "path": "/Users/alice/work/gamma", "lastAccessed": 5000 },
                { "path": "/Users/alice/work/beta", "lastAccessed": 3000, "projectName": "Beta Saved" }
            ]
        }),
    );

    // 1. Entries must sort by lastAccessed descending regardless of input order.
    let entries = recent::collect_recent_entries(&s);
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "/Users/alice/work/gamma",
            "/Users/alice/work/beta",
            "/Users/alice/work/alpha",
        ],
        "Recent entries must sort newest lastAccessed first"
    );
    assert_eq!(entries[1].display_name, "Beta Saved");
    assert_eq!(entries[2].display_name, "Alpha Saved");

    let mut rt = Runtime::new(s, crate::view, (1040.0, 720.0), Env::new(false, 1.0));
    rt.frame(0.0);

    // 2. Renaming an open tab via tab_rename persists projectName to recentFolders.
    let alpha_tab = workspace::open_tab_for_folder(&rt.state, "/Users/alice/work/alpha")
        .expect("alpha open tab");
    rt.update(|s, tx| {
        assert!(tab_rename::open_for_tab(s, &alpha_tab, tx));
    });
    rt.frame(0.02);
    rt.key(rune::KeyEvent {
        key: rune::Key::Text("Alpha Persisted".into()),
        mods: rune::Mods::default(),
    });
    rt.frame(0.02);
    rt.update(tab_rename::commit);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let mut settled = false;
        rt.update(|s, tx| {
            if launcher::poll(s, tx) && s.screen.launcher().unwrap().custom_names.is_empty() {
                settled = true;
            }
        });
        if settled {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        rt.state.screen.launcher().unwrap().custom_names.is_empty(),
        "custom_names must clear once server PATCH settles"
    );
    let persisted = settings::recent_folders(&rt.state);
    assert_eq!(
        persisted
            .iter()
            .find(|(p, _, _)| p == "/Users/alice/work/alpha")
            .and_then(|(_, _, name)| name.as_deref()),
        Some("Alpha Persisted")
    );

    // 3. Back-to-back mutations while a PATCH is in flight coalesce without dropping either edit.
    gate_first.store(true, Ordering::SeqCst);
    launcher::rename_recent(&mut rt.state, "/Users/alice/work/beta", "Beta V2");
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("first PATCH reached server");
    rt.update(|s, tx| {
        launcher::remove_recent(s, "/Users/alice/work/gamma", tx);
    });
    gate_tx.send(()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        rt.update(|s, tx| {
            launcher::poll(s, tx);
        });
        let settled = {
            let l = rt.state.screen.launcher().unwrap();
            l.custom_names.is_empty() && l.removed_recents.is_empty()
        };
        let count = patches.lock().unwrap().len();
        if settled && count >= 3 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let last_patch = patches.lock().unwrap().last().cloned().unwrap();
    let last_rows = last_patch["recentFolders"].as_array().unwrap();
    assert!(
        last_rows
            .iter()
            .all(|row| row["path"] != "/Users/alice/work/gamma"),
        "coalesced final PATCH must drop removed gamma"
    );
    assert_eq!(
        last_rows
            .iter()
            .find(|row| row["path"] == "/Users/alice/work/beta")
            .and_then(|row| row["projectName"].as_str()),
        Some("Beta V2"),
        "coalesced final PATCH must preserve beta rename"
    );

    // 4. HTTP 500 rejection rolls back optimistic custom_names and emits a settings error toast.
    fail_next.store(true, Ordering::SeqCst);
    launcher::rename_recent(&mut rt.state, "/Users/alice/work/beta", "Broken Rename");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let mut rolled_back = false;
        rt.update(|s, tx| {
            if launcher::poll(s, tx) && s.screen.launcher().unwrap().custom_names.is_empty() {
                rolled_back = true;
            }
        });
        if rolled_back {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let beta_after_fail = recent::collect_recent_entries(&rt.state)
        .into_iter()
        .find(|e| e.path == "/Users/alice/work/beta")
        .unwrap();
    assert_eq!(
        beta_after_fail.display_name, "Beta V2",
        "Rejected PATCH must roll back optimistic rename to last saved name"
    );
    assert!(
        rt.state
            .notifications
            .queued_messages()
            .iter()
            .any(|(cat, body)| {
                *cat == crate::shell::notifications::Category::Settings
                    && body == t("settings.preferenceSaveFailed")
            }),
        "Rejected PATCH must emit a settings failure notification"
    );
}
