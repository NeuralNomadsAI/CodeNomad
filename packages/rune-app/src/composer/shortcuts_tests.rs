use super::{acknowledge, recall};
use crate::{
    Message, Phase, State,
    strings::t,
    transport::{Command, PromptOutcome},
};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};

fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| node(child, key))
}

fn primary_mods(shift: bool) -> Mods {
    Mods {
        ctrl: !cfg!(target_os = "macos"),
        cmd: true,
        logo: cfg!(target_os = "macos"),
        shift,
        alt: false,
    }
}

fn send_key(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    let event = KeyEvent { key, mods };
    rt.key(event.clone());
    rt.key_up(event);
    rt.frame(0.02);
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.frame(0.02);
}

fn chat_runtime() -> (Runtime<State>, codenomad_client::Receiver<Command>) {
    let (sender, receiver) = codenomad_client::bounded(8);
    let mut s = crate::init();
    s.phase = Phase::Ready;
    s.commands = Some(sender);
    s.composer.picker.set_attachments_supported(true);
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    rt.update(|_, tx| tx.focus("composer", false));
    rt.frame(0.0);
    (rt, receiver)
}

fn settle_sent(rt: &mut Runtime<State>, cmd: Command) -> String {
    let Command::Prompt(prompt) = cmd else {
        panic!("expected Command::Prompt");
    };
    let id = prompt.id.clone().expect("prompt id");
    acknowledge(&mut rt.state, &id, PromptOutcome::Confirmed(id.clone()));
    rt.frame(0.0);
    prompt.text
}

fn menu_item_description(rt: &mut Runtime<State>, item_key: &str) -> Option<String> {
    click(rt, "composer-more:trigger");
    let tree = rt.accessibility_json();
    let item = node(&tree, item_key).unwrap_or_else(|| panic!("missing {item_key}"));
    let description = item["description"].as_str().map(str::to_owned);
    send_key(rt, Key::Escape, Mods::default());
    rt.update(|_, tx| tx.focus("composer", false));
    rt.frame(0.0);
    description
}

#[test]
fn prompt_send_and_newline_honor_submit_on_enter_and_overrides_in_normal_mode() {
    let (mut rt, rx) = chat_runtime();

    // Default (promptSubmitOnEnter = true): Shift+Enter and Mod+Enter insert newlines; Enter sends.
    rt.update(|s, _| s.draft.replace_text("line1"));
    rt.frame(0.0);
    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "line1\n");

    send_key(&mut rt, Key::Enter, primary_mods(false));
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "line1\n\n");

    send_key(&mut rt, Key::Text("line2".into()), Mods::default());
    send_key(&mut rt, Key::Enter, Mods::default());
    assert_eq!(
        settle_sent(&mut rt, rx.try_recv().expect("send on Enter")),
        "line1\n\nline2"
    );

    // promptSubmitOnEnter = false: plain Enter and Shift+Enter insert newlines; Mod+Enter sends.
    rt.update(|s, tx| {
        crate::settings::fixture_settings(s, json!({ "promptSubmitOnEnter": false }));
        s.draft.replace_text("multi");
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "multi\n");

    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "multi\n\n");

    send_key(&mut rt, Key::Text("end".into()), Mods::default());
    send_key(&mut rt, Key::Enter, primary_mods(false));
    assert_eq!(
        settle_sent(&mut rt, rx.try_recv().expect("send on Mod+Enter")),
        "multi\n\nend"
    );

    // Custom overrides: prompt-send -> F9, prompt-newline -> F8. Old defaults stay inert.
    rt.update(|s, tx| {
        crate::settings::fixture_settings(
            s,
            json!({
                "promptSubmitOnEnter": true,
                "hotkeyOverrides": {
                    "prompt-send": [{ "key": "F9" }],
                    "prompt-newline": [{ "key": "F8" }]
                }
            }),
        );
        s.draft.replace_text("custom");
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    let send_help = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("send"))
        .and_then(|el| el.help);
    assert_eq!(
        send_help.as_deref(),
        Some(format!("{} (F9)", t("promptInput.send.ariaLabel")).as_str())
    );

    send_key(&mut rt, Key::Enter, Mods::default());
    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    send_key(&mut rt, Key::Enter, primary_mods(false));
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "custom");

    send_key(&mut rt, Key::Function(8), Mods::default());
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "custom\n");

    send_key(&mut rt, Key::Text("end".into()), Mods::default());
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert_eq!(
        settle_sent(&mut rt, rx.try_recv().expect("send on F9")),
        "custom\nend"
    );

    // Disabled overrides ([]): neither defaults nor former custom keys fire.
    rt.update(|s, tx| {
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "prompt-send": [],
                "prompt-newline": []
            }),
        );
        s.draft.replace_text("disabled");
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    let send_help = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("send"))
        .and_then(|el| el.help);
    assert_eq!(send_help.as_deref(), Some(t("promptInput.send.ariaLabel")));

    send_key(&mut rt, Key::Enter, Mods::default());
    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    send_key(&mut rt, Key::Enter, primary_mods(false));
    send_key(&mut rt, Key::Function(8), Mods::default());
    send_key(&mut rt, Key::Function(9), Mods::default());
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "disabled");
}

#[test]
fn prompt_alternate_send_honors_custom_and_disabled_overrides_and_menu_label() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        s.phase = Phase::Streaming;
        s.draft.replace_text("follow-up");
    });
    rt.frame(0.0);

    // Custom override: F10 triggers alternate delivery; old defaults do not.
    rt.update(|s, tx| {
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "prompt-alternate-send": [{ "key": "F10" }]
            }),
        );
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:queue").as_deref(),
        Some("F10")
    );

    send_key(&mut rt, Key::Enter, primary_mods(true));
    #[cfg(not(target_os = "macos"))]
    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            alt: true,
            ..Mods::default()
        },
    );
    assert!(rx.try_recv().is_err());

    send_key(&mut rt, Key::Function(10), Mods::default());
    let Command::Prompt(prompt) = rx.try_recv().expect("alternate send on F10") else {
        panic!("expected prompt");
    };
    assert_eq!(prompt.text, "follow-up");
    assert_eq!(
        prompt.delivery,
        Some(codenomad_client::prompt::Delivery::Queue)
    );
    let id = prompt.id.clone().expect("prompt id");
    acknowledge(&mut rt.state, &id, PromptOutcome::Confirmed(id.clone()));
    rt.frame(0.0);

    // Disabled override ([]): neither defaults nor F10 sends, and menu hides description.
    rt.update(|s, tx| {
        crate::settings::fixture_shortcuts(s, json!({ "prompt-alternate-send": [] }));
        s.draft.replace_text("blocked");
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:queue"),
        None
    );

    send_key(&mut rt, Key::Enter, primary_mods(true));
    #[cfg(not(target_os = "macos"))]
    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            alt: true,
            ..Mods::default()
        },
    );
    send_key(&mut rt, Key::Function(10), Mods::default());
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "blocked");
}

#[test]
fn prompt_history_prev_and_next_honor_custom_and_disabled_overrides_and_menu_labels() {
    let (mut rt, _rx) = chat_runtime();
    rt.update(|s, _| {
        s.draft.replace_text("first");
        assert!(recall::record(s, "first".into(), false));
        s.draft.replace_text("second");
        assert!(recall::record(s, "second".into(), false));
        s.draft.clear();
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "prompt-history-prev": [{ "key": "F7" }],
                "prompt-history-next": [{ "key": "F8" }]
            }),
        );
    });
    rt.frame(0.0);
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:previous").as_deref(),
        Some("F7")
    );
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:next").as_deref(),
        Some("F8")
    );

    // Old default ArrowUp no longer recalls.
    send_key(&mut rt, Key::Up, Mods::default());
    assert!(rt.state.draft.text.is_empty());

    // Custom F7/F8 step through history and restore the empty draft.
    send_key(&mut rt, Key::Function(7), Mods::default());
    assert_eq!(rt.state.draft.text, "second");
    send_key(&mut rt, Key::Function(7), Mods::default());
    assert_eq!(rt.state.draft.text, "first");
    send_key(&mut rt, Key::Down, Mods::default());
    assert_eq!(rt.state.draft.text, "first");
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert_eq!(rt.state.draft.text, "second");
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert!(rt.state.draft.text.is_empty());

    // Disabled overrides ([]) prevent recall and hide menu labels.
    rt.update(|s, tx| {
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "prompt-history-prev": [],
                "prompt-history-next": []
            }),
        );
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:previous"),
        None
    );
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:next"),
        None
    );
    send_key(&mut rt, Key::Up, Mods::default());
    send_key(&mut rt, Key::Function(7), Mods::default());
    assert!(rt.state.draft.text.is_empty());
}

#[test]
fn clear_input_and_user_message_jump_honor_custom_and_disabled_overrides() {
    let (mut rt, _rx) = chat_runtime();
    rt.update(|s, _| {
        s.messages = vec![
            std::sync::Arc::new(Message {
                id: "u1".into(),
                role: "user".into(),
                completed: true,
                body: "first user".into(),
                usage: None,
                parts: Vec::new(),
            }),
            std::sync::Arc::new(Message {
                id: "u2".into(),
                role: "user".into(),
                completed: true,
                body: "second user".into(),
                usage: None,
                parts: Vec::new(),
            }),
        ];
        s.draft.replace_text("clear me");
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "clear-input": [{ "key": "F4" }],
                "user-message-prev": [{ "key": "F2" }],
                "user-message-next": [{ "key": "F3" }]
            }),
        );
    });
    rt.frame(0.0);
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:clear").as_deref(),
        Some("F4")
    );
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:user-message-prev").as_deref(),
        Some("F2")
    );
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:user-message-next").as_deref(),
        Some("F3")
    );

    // Old default Mod+K does not clear; custom F4 clears.
    send_key(&mut rt, Key::Command('k'), primary_mods(false));
    assert_eq!(rt.state.draft.text, "clear me");
    send_key(&mut rt, Key::Function(4), Mods::default());
    assert!(rt.state.draft.text.is_empty());

    // Old default Alt+Up (or Alt+Mod+Up on Mac) does not jump; custom F2/F3 jump across users.
    let old_jump_mods = if cfg!(target_os = "macos") {
        Mods {
            alt: true,
            ..primary_mods(false)
        }
    } else {
        Mods {
            alt: true,
            ..Mods::default()
        }
    };
    assert!(crate::chat::reading::can_jump_user(&rt.state, true));
    assert!(!crate::chat::reading::can_jump_user(&rt.state, false));
    send_key(&mut rt, Key::Up, old_jump_mods);
    send_key(&mut rt, Key::Up, old_jump_mods);
    assert!(!crate::chat::reading::can_jump_user(&rt.state, false));

    send_key(&mut rt, Key::Function(2), Mods::default());
    send_key(&mut rt, Key::Function(2), Mods::default());
    assert!(crate::chat::reading::can_jump_user(&rt.state, false));
    assert!(!crate::chat::reading::can_jump_user(&rt.state, true));
    send_key(&mut rt, Key::Function(3), Mods::default());
    assert!(!crate::chat::reading::can_jump_user(&rt.state, false));
    assert!(crate::chat::reading::can_jump_user(&rt.state, true));

    // Disabled overrides ([]) disable clear-input and user-message jumps and hide menu labels.
    rt.update(|s, tx| {
        s.draft.replace_text("stay");
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "clear-input": [],
                "user-message-prev": [],
                "user-message-next": []
            }),
        );
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:clear"),
        None
    );
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:user-message-prev"),
        None
    );
    assert_eq!(
        menu_item_description(&mut rt, "composer-more:item:user-message-next"),
        None
    );
    send_key(&mut rt, Key::Command('k'), primary_mods(false));
    send_key(&mut rt, Key::Function(4), Mods::default());
    assert_eq!(rt.state.draft.text, "stay");
    send_key(&mut rt, Key::Function(2), Mods::default());
    send_key(&mut rt, Key::Up, old_jump_mods);
    assert!(!crate::chat::reading::can_jump_user(&rt.state, false));
}

#[test]
fn composer_shortcut_guards_preserve_picker_ime_device_busy_repeat_and_shell_mode() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        s.composer.picker.add_test_command("help");
        s.draft.replace_text("saved");
        assert!(recall::record(s, "saved".into(), false));
        s.draft.clear();
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "prompt-send": [{ "key": "F9" }],
                "prompt-alternate-send": [{ "key": "F10" }],
                "prompt-newline": [{ "key": "F8" }],
                "prompt-history-prev": [{ "key": "F7" }],
                "prompt-exit-shell": [{ "key": "F11" }],
                "clear-input": [{ "key": "F4" }]
            }),
        );
    });
    rt.frame(0.0);

    // 1. Open slash picker blocks remapped send, alternate-send, newline and recall.
    send_key(&mut rt, Key::Text("/he".into()), Mods::default());
    assert!(rt.state.composer.picker.open());
    send_key(&mut rt, Key::Function(9), Mods::default());
    send_key(&mut rt, Key::Function(10), Mods::default());
    send_key(&mut rt, Key::Function(8), Mods::default());
    send_key(&mut rt, Key::Function(7), Mods::default());
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "/he");
    // Enter still chooses the picker entry.
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(!rt.state.composer.picker.open());
    assert_eq!(rt.state.draft.text, "/help ");

    // 2. IME composition blocks all composer shortcuts.
    rt.update(|s, tx| {
        s.draft.replace_text("ime");
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    rt.ime(rune::edit::Ime::Preedit("ni".into(), None, Vec::new()));
    rt.frame(0.0);
    assert!(rt.state.draft.is_composing());
    for key in [
        Key::Function(9),
        Key::Function(10),
        Key::Function(8),
        Key::Function(4),
    ] {
        send_key(&mut rt, key, Mods::default());
    }
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "ime");
    rt.ime(rune::edit::Ime::Preedit(String::new(), None, Vec::new()));
    rt.frame(0.0);
    assert!(!rt.state.draft.is_composing());

    // 3. Device busy blocks remapped send/alternate/newline/clear without raising send_error.
    rt.update(|s, _| {
        s.composer.device.choosing = true;
    });
    rt.frame(0.0);
    for key in [
        Key::Function(9),
        Key::Function(10),
        Key::Function(8),
        Key::Function(4),
    ] {
        send_key(&mut rt, key, Mods::default());
    }
    assert!(rx.try_recv().is_err());
    assert!(!rt.state.composer.send_error);
    assert_eq!(rt.state.draft.text, "ime");
    rt.update(|s, _| {
        s.composer.device.choosing = false;
    });

    // 4. Key repeat never fires remapped send, alternate-send, clear, or exit-shell.
    for key in [Key::Function(9), Key::Function(10), Key::Function(4)] {
        rt.repeat_key(KeyEvent {
            key,
            mods: Mods::default(),
        });
        rt.frame(0.02);
    }
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "ime");

    // 5. Shell mode honors remapped newline, send and exit-shell while ignoring alternate-send.
    rt.update(|s, tx| {
        s.draft.clear();
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    send_key(&mut rt, Key::Text("echo ok".into()), Mods::default());
    // Held repeat of ExitShell (F11) does not exit shell mode.
    rt.repeat_key(KeyEvent {
        key: Key::Function(11),
        mods: Mods::default(),
    });
    rt.frame(0.02);
    assert!(rt.state.composer.shell_mode);
    // Remapped alternate-send (F10) is ignored in shell mode.
    send_key(&mut rt, Key::Function(10), Mods::default());
    assert!(rx.try_recv().is_err());
    assert!(rt.state.composer.shell_mode);
    // Remapped newline (F8) inserts newline; remapped send (F9) sends Command::Shell.
    send_key(&mut rt, Key::Function(8), Mods::default());
    assert_eq!(rt.state.draft.text, "echo ok\n");
    send_key(&mut rt, Key::Function(9), Mods::default());
    let Command::Shell { command, .. } = rx.try_recv().expect("shell command on F9") else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo ok");
    assert!(!rt.state.composer.shell_mode);
}

#[test]
fn invalid_reserved_and_digit_slot_overrides_use_shared_resolver() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        s.draft.replace_text("shared");
        crate::settings::fixture_shortcuts(
            s,
            json!({
                "prompt-send": [{ "key": "F6" }],
                "clear-input": [{ "key": "Dead" }],
                "prompt-newline": [{ "key": "Digit1", "ctrl": true }]
            }),
        );
    });
    rt.frame(0.0);

    // Reserved region-cycle F6 is stripped from prompt-send by the shared resolver.
    send_key(&mut rt, Key::Function(6), Mods::default());
    assert!(rx.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "shared");
    // Unconsumed F6 cycles region focus; refocus the composer before testing Ctrl+1.
    rt.update(|_, tx| tx.focus("composer", false));
    rt.frame(0.0);

    // Digit1 slot override works through the shared resolver.
    send_key(
        &mut rt,
        Key::Command('1'),
        Mods {
            ctrl: true,
            cmd: !cfg!(target_os = "macos"),
            ..Mods::default()
        },
    );
    assert_eq!(rt.state.draft.text, "shared\n");

    // Invalid rule on clear-input falls back to default Mod+K instead of disabling it.
    send_key(&mut rt, Key::Command('k'), primary_mods(false));
    assert!(rt.state.draft.text.is_empty());
}
