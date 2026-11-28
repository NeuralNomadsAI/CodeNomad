use super::{project_runtime, send_key, settle, workspace_state};
use crate::{Screen, backend::Backend, init, settings};
use rune::{Key, KeyEvent, Mods};
use serde_json::json;

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn open_help_and_sponsor_shortcuts_follow_locale_and_respect_guards() {
    let mut rt = project_runtime(workspace_state(1));
    assert!(rt.take_url_requests().is_empty());

    // Initially unbound.
    send_key(&mut rt, Key::Function(8), Mods::default());
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert!(rt.take_url_requests().is_empty());

    // Configured shortcuts open localized help and sponsor pages.
    settings::notification_test_config(
        &rt.state,
        json!({
            "settings": {
                "locale": "en",
                "hotkeyOverrides": {
                    "open-help": [{"key": "f8"}],
                    "open-sponsor": [{"key": "f9"}]
                }
            }
        }),
    );
    send_key(&mut rt, Key::Function(8), Mods::default());
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert_eq!(
        rt.take_url_requests(),
        [
            "https://neuralnomadsai.github.io/CodeNomad/en/",
            "https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html",
        ]
    );

    // Non-English locale is reflected in both URLs.
    settings::notification_test_config(
        &rt.state,
        json!({
            "settings": {
                "locale": "de",
                "hotkeyOverrides": {
                    "open-help": [{"key": "f8"}],
                    "open-sponsor": [{"key": "f9"}]
                }
            }
        }),
    );
    send_key(&mut rt, Key::Function(8), Mods::default());
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert_eq!(
        rt.take_url_requests(),
        [
            "https://neuralnomadsai.github.io/CodeNomad/de/",
            "https://neuralnomadsai.github.io/CodeNomad/de/sponsor.html",
        ]
    );

    // Key repeat does not open duplicate browser tabs.
    rt.repeat_key(KeyEvent {
        key: Key::Function(8),
        mods: Mods::default(),
    });
    settle(&mut rt);
    assert!(rt.take_url_requests().is_empty());

    // Modal, overlay, IME composition, and auth-required guards all block dispatch.
    rt.update(|s, tx| crate::shell::command_palette::open(s, tx));
    settle(&mut rt);
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert!(rt.take_url_requests().is_empty());
    rt.update(|s, _| s.command_palette.dismiss());
    settle(&mut rt);

    let handle = crate::agent::start(
        Backend::unauthenticated("http://127.0.0.1:9/").unwrap(),
        rt.state.wake.clone(),
    );
    let mut agent = crate::agent::Ui::new(handle);
    agent.picker = true;
    rt.state.agent = Some(agent);
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert!(rt.take_url_requests().is_empty());
    rt.state.agent = None;

    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(&mut rt);
    rt.ime(rune::edit::Ime::Preedit("ni".into(), None, Vec::new()));
    settle(&mut rt);
    assert!(rt.state.draft.is_composing());
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert!(rt.take_url_requests().is_empty());
    rt.ime(rune::edit::Ime::Preedit(String::new(), None, Vec::new()));
    settle(&mut rt);
    assert!(!rt.state.draft.is_composing());

    rt.state
        .screen
        .launcher_mut()
        .unwrap()
        .authentication_required = true;
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert!(rt.take_url_requests().is_empty());
    rt.state
        .screen
        .launcher_mut()
        .unwrap()
        .authentication_required = false;

    // Explicit empty disable suppresses dispatch.
    settings::fixture_shortcuts(&rt.state, json!({ "open-help": [], "open-sponsor": [] }));
    send_key(&mut rt, Key::Function(8), Mods::default());
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert!(rt.take_url_requests().is_empty());

    // Global app scope: also works on the home/launcher view.
    let mut home = init();
    home.screen = Screen::Launcher(Box::new(crate::launcher::Launcher::fixture()));
    let mut home_rt = project_runtime(home);
    settings::notification_test_config(
        &home_rt.state,
        json!({
            "settings": {
                "locale": "en",
                "hotkeyOverrides": { "open-help": [{"key": "f8"}] }
            }
        }),
    );
    send_key(&mut home_rt, Key::Function(8), Mods::default());
    assert_eq!(
        home_rt.take_url_requests(),
        ["https://neuralnomadsai.github.io/CodeNomad/en/"]
    );
}
