use super::*;
use crate::{backend::Backend, launcher::poll};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// A server with `/srv`, its folder `app` and nothing else. Answers until dropped with the test.
fn server() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let asked = Arc::new(Mutex::new(Vec::new()));
    let seen = asked.clone();
    std::thread::spawn(move || {
        for mut socket in listener.incoming().flatten() {
            let mut request = [0u8; 4096];
            let read = socket.read(&mut request).unwrap_or(0);
            let head = String::from_utf8_lossy(&request[..read]);
            let target = head
                .split_whitespace()
                .nth(1)
                .unwrap_or_default()
                .to_owned();
            let (status, body) = match target.as_str() {
                "/api/filesystem?includeFiles=" => (
                    "200 OK",
                    serde_json::json!({
                        "entries": [{"name": "app", "path": "/srv/app", "type": "directory"}],
                        "metadata": {"scope": "unrestricted", "currentPath": "/srv", "rootPath": "/srv", "homePath": "/home/me",
                            "displayPath": "/srv", "pathKind": "absolute", "parentPath": "/"},
                    }),
                ),
                "/api/filesystem?includeFiles=&path=%2Fsrv%2Fapp" => (
                    "200 OK",
                    serde_json::json!({
                        "entries": [],
                        "metadata": {"scope": "unrestricted", "currentPath": "/srv/app", "rootPath": "/srv", "homePath": "/home/me",
                            "displayPath": "/srv/app", "pathKind": "absolute", "parentPath": "/srv"},
                    }),
                ),
                _ => ("400 Bad Request", serde_json::json!({"error": "ENOENT"})),
            };
            seen.lock().unwrap().push(target);
            let body = body.to_string();
            let _ = socket.write_all(
                format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
                    .as_bytes(),
            );
        }
    });
    (base, asked)
}

fn english(s: &State, cx: &mut rune::Cx<State>) -> rune::El {
    crate::strings::with_locale("en", || crate::view(s, cx))
}

fn rig(base: &str, typed: &str) -> rune::Runtime<State> {
    let mut s = crate::init();
    let mut l = Launcher::fixture();
    l.connection = Some(Backend::unauthenticated(base).unwrap());
    l.folder = TextEdit::new(typed);
    s.screen = crate::Screen::Launcher(l);
    let mut rt = rune::Runtime::new(s, english, (1000.0, 800.0), rune::Env::new(false, 1.0));
    rt.frame(0.0);
    rt
}

/// Lets the listing asked for arrive and the launcher show it.
fn settle(rt: &mut rune::Runtime<State>) {
    let until = Instant::now() + Duration::from_secs(5);
    while rt.state.screen.launcher().unwrap().folders.load.is_some() {
        assert!(Instant::now() < until, "the folder listing never arrived");
        rt.update(|s, tx| {
            let _ = poll(s, tx);
        });
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
}

fn tap(rt: &mut rune::Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(1.0 / 60.0);
}

fn folder(rt: &rune::Runtime<State>) -> &str {
    &rt.state.screen.launcher().unwrap().folder.text
}

#[test]
fn browsing_lists_the_servers_folders_and_each_one_fills_the_folder_field() {
    let (base, asked) = server();
    let mut rt = rig(&base, "");
    assert!(rt.find("folder-0").is_none(), "closed until asked for");
    rt.update(|s, _| toggle(s));
    settle(&mut rt);
    assert_eq!(folder(&rt), "/srv", "the folder the server starts from");
    assert!(rt.find("folder-home").is_some() && rt.find("folder-parent").is_some());

    tap(&mut rt, "folder-0");
    settle(&mut rt);
    assert_eq!(folder(&rt), "/srv/app");
    assert!(rt.find("folder-0").is_none(), "it holds no folder");
    assert!(
        rt.find("folder-current").is_some(),
        "named above its folders"
    );
    assert_eq!(
        *asked.lock().unwrap(),
        [
            "/api/filesystem?includeFiles=",
            "/api/filesystem?includeFiles=&path=%2Fsrv%2Fapp"
        ],
        "folders alone, then the one tapped as the server spelled it"
    );

    rt.update(|s, _| toggle(s));
    rt.frame(1.0 / 60.0);
    assert!(
        rt.find("folder-parent").is_none(),
        "browse again puts the list away"
    );
    assert_eq!(folder(&rt), "/srv/app", "and keeps the folder chosen");
}

#[test]
fn a_typed_folder_the_server_does_not_list_starts_from_the_servers_own() {
    let (base, asked) = server();
    let mut rt = rig(&base, "nowhere");
    rt.update(|s, _| toggle(s));
    settle(&mut rt);
    settle(&mut rt);
    assert_eq!(folder(&rt), "/srv");
    assert_eq!(asked.lock().unwrap().len(), 2);
    assert!(rt.find("folder-0").is_some());
}

#[test]
fn a_listing_that_fails_keeps_the_folders_shown_and_says_so() {
    let (base, _) = server();
    let mut rt = rig(&base, "");
    rt.update(|s, _| toggle(s));
    settle(&mut rt);
    // `/` isn't a folder this server lists.
    tap(&mut rt, "folder-parent");
    settle(&mut rt);
    let l = rt.state.screen.launcher().unwrap();
    assert!(l.folders.failed);
    assert_eq!(l.folder.text, "/srv");
    assert!(rt.find("folder-0").is_some());
}
