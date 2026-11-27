use super::{acknowledge, can_send, draft::Attachment, send};
use crate::{
    Phase, State,
    strings::t,
    transport::{Command, PromptOutcome},
};
use rune::{Env, Key, KeyEvent, Mods, Runtime, edit::TextEdit};
use serde_json::Value;

fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| node(child, key))
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

#[test]
fn bang_enters_shell_mode_without_text_and_exposes_accessible_state() {
    let (mut rt, _rx) = chat_runtime();
    let before_height = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("composer"))
        .expect("composer element")
        .rect[3];
    send_key(
        &mut rt,
        Key::Text("!".into()),
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert!(rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());
    let after_height = rt
        .elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some("composer"))
        .expect("composer element")
        .rect[3];
    assert!(
        (after_height - before_height).abs() < 0.5,
        "shell status must stay inside the existing composer height ({before_height} vs {after_height})"
    );

    let tree = rt.accessibility_json();
    let status = node(&tree, "composer-shell-status").expect("shell status note");
    assert_eq!(status["role"], "note");
    assert!(
        status["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["name"] == t("promptInput.overlay.shellModeActive"))
            || status["name"] == t("promptInput.overlay.shellModeActive")
    );
    let input = node(&tree, "input").expect("composer input");
    assert_eq!(
        input["description"],
        t("promptInput.overlay.shellModeActive")
    );
    let send_btn = node(&tree, "send").expect("send button");
    assert_eq!(send_btn["name"], t("promptInput.send.ariaLabel"));

    // Typing '!' while already in shell mode inserts literally and hides the visual status overlay
    // while keeping semantic description and shell mode active.
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "!");
    let typing_tree = rt.accessibility_json();
    assert!(node(&typing_tree, "composer-shell-status").is_none());
    let typing_input = node(&typing_tree, "input").expect("composer input");
    assert_eq!(
        typing_input["description"],
        t("promptInput.overlay.shellModeActive")
    );

    // Typing '!' at index 0 when normal composer already has text does not enter shell mode.
    rt.update(|s, _| {
        s.composer.shell_mode = false;
        s.draft = TextEdit::new("hello");
        s.draft.focused = true;
        s.draft.set_caret(0);
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "!hello");
}

#[test]
fn backspace_escape_and_remapped_exit_shell_shortcut_exit_shell_mode() {
    let (mut rt, _rx) = chat_runtime();

    // Backspace on empty field exits shell mode.
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    send_key(&mut rt, Key::Backspace, Mods::default());
    assert!(!rt.state.composer.shell_mode);

    // Backspace on non-empty command edits text without exiting; Escape exits while keeping text.
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    send_key(&mut rt, Key::Text("ls".into()), Mods::default());
    assert_eq!(rt.state.draft.text, "ls");
    send_key(&mut rt, Key::Backspace, Mods::default());
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "l");
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "l");

    // Remapped prompt-exit-shell ignores Escape and exits on F10.
    rt.update(|s, tx| {
        s.draft.clear();
        crate::settings::fixture_shortcuts(
            s,
            serde_json::json!({
                "prompt-exit-shell": [{ "key": "F10" }]
            }),
        );
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(rt.state.composer.shell_mode);
    // Unconsumed Escape blurs the composer; refocus before pressing the remapped shortcut.
    rt.update(|_, tx| tx.focus("composer", false));
    rt.frame(0.0);
    send_key(&mut rt, Key::Function(10), Mods::default());
    assert!(!rt.state.composer.shell_mode);

    // Unbound prompt-exit-shell ignores Escape while Backspace on empty buffer still exits.
    rt.update(|s, tx| {
        crate::settings::fixture_shortcuts(
            s,
            serde_json::json!({
                "prompt-exit-shell": []
            }),
        );
        tx.focus("composer", false);
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    send_key(&mut rt, Key::Escape, Mods::default());
    assert!(rt.state.composer.shell_mode);
    rt.update(|_, tx| tx.focus("composer", false));
    rt.frame(0.0);
    send_key(&mut rt, Key::Backspace, Mods::default());
    assert!(!rt.state.composer.shell_mode);
}

#[test]
fn pickers_and_alternate_delivery_are_disabled_in_shell_mode() {
    let (mut rt, _rx) = chat_runtime();
    rt.update(|s, _| {
        s.phase = Phase::Streaming;
        s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
    });
    rt.frame(0.0);

    // Enter shell mode: attachment alone cannot enable Send without text.
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    assert!(!can_send(&rt.state));

    // Leading '/' and '@' do not open pickers or block Send in shell mode.
    send_key(
        &mut rt,
        Key::Text("/usr/bin/env @host".into()),
        Mods::default(),
    );
    assert!(!rt.state.composer.picker.open());
    assert!(rt.find("prompt-picker").is_none());
    assert!(rt.find("refresh-command-catalogue").is_none());
    assert!(can_send(&rt.state));

    // More actions menu disables alternate delivery and hides its shortcut hint in shell mode.
    click(&mut rt, "composer-more:trigger");
    let tree = rt.accessibility_json();
    let queue = node(&tree, "composer-more:item:queue").expect("queue item");
    assert!(
        queue["states"]
            .as_array()
            .unwrap()
            .iter()
            .any(|state| state == "disabled")
    );
    assert!(queue["description"].is_null());
}

#[test]
fn shell_send_handles_success_pre_send_rejection_and_unconfirmed_hold() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft = TextEdit::new("  echo [pasted #1] @literal  ");
        s.composer.draft.attach(Attachment::Pasted {
            id: 1,
            text: std::sync::Arc::from("world"),
        });
        s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
    });
    rt.frame(0.0);

    // Submit in shell mode: expands pasted placeholder, keeps @literal, exits shell mode,
    // consumes pasted placeholder while preserving unsent non-pasted attachments.
    rt.update(|s, tx| send(s, tx, true));
    let Command::Shell { attempt, command } = rx.try_recv().expect("shell command") else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo world @literal");
    assert!(!rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    assert!(matches!(
        rt.state.composer.draft.attachments[0],
        Attachment::Skill { .. }
    ));
    assert!(rt.state.messages.is_empty());

    // Pre-send rejection restores draft, attachments, and shell mode so user can retry.
    acknowledge(&mut rt.state, &attempt, PromptOutcome::Rejected);
    assert!(rt.state.composer.send_error);
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "  echo [pasted #1] @literal  ");
    assert_eq!(rt.state.composer.draft.attachments.len(), 2);
    assert!(can_send(&rt.state));

    // Retry and receive Unconfirmed: restores draft & shell mode but holds exact command against replay.
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell {
        attempt: second,
        command: second_cmd,
    } = rx.try_recv().expect("second shell command")
    else {
        panic!("expected Command::Shell");
    };
    assert_eq!(second_cmd, "echo world @literal");
    acknowledge(&mut rt.state, &second, PromptOutcome::Unconfirmed);
    assert!(!rt.state.composer.send_error);
    assert!(rt.state.composer.shell_mode);
    assert!(super::actions::command_held(&rt.state));
    assert!(!can_send(&rt.state));

    // Exiting shell mode lets the same text be edited/sent as a normal prompt (distinct from shell hold).
    rt.update(|s, _| s.composer.exit_shell_mode());
    assert!(!super::actions::command_held(&rt.state));

    // Re-entering shell mode still holds the exact unconfirmed command until edited or settled.
    rt.update(|s, _| s.composer.shell_mode = true);
    assert!(super::actions::command_held(&rt.state));
    rt.update(|s, _| {
        s.draft = TextEdit::new("echo different");
    });
    assert!(!super::actions::command_held(&rt.state));
    assert!(can_send(&rt.state));

    // Late exact receipt settles the hold.
    rt.update(|s, _| {
        s.draft = TextEdit::new("echo world @literal");
    });
    assert!(super::actions::command_held(&rt.state));
    acknowledge(
        &mut rt.state,
        &second,
        PromptOutcome::Confirmed(second.clone()),
    );
    assert!(!super::actions::command_held(&rt.state));
    assert!(can_send(&rt.state));
}

#[test]
fn switching_conversation_or_tab_resets_shell_mode() {
    let mut s = crate::init();
    let mut ui = crate::workspace::Ui::new();
    ui.fixture_ready();
    s.workspace = Some(ui);
    let mut rt = Runtime::new(s, crate::view, (960.0, 640.0), Env::new(false, 1.0));
    rt.frame(0.0);

    let mut backend_a =
        codenomad_client::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    backend_a.workspace = "ws-1".into();
    backend_a.session = "ses_a".into();
    let mut backend_b = backend_a.clone();
    backend_b.session = "ses_b".into();

    rt.update(|s, _| {
        crate::workspace::bound(s, &backend_a);
        s.composer.shell_mode = true;
    });
    assert!(rt.state.composer.shell_mode);

    // Switching to another session resets shell mode.
    rt.update(|s, _| {
        crate::workspace::bound(s, &backend_b);
    });
    assert!(!rt.state.composer.shell_mode);

    // Switching to a second tab stashes and resets shell mode on the inactive tab.
    rt.update(|s, tx| {
        s.composer.shell_mode = true;
        crate::workspace::new_tab(s, tx);
    });
    assert!(!rt.state.composer.shell_mode);
    rt.update(|s, tx| {
        crate::workspace::select_index(s, 0, tx);
    });
    assert!(!rt.state.composer.shell_mode);
}

#[test]
fn web_edit_bang_enters_shell_mode_but_paste_and_delete_to_bang_do_not() {
    assert!(super::web_bang::qualifies_beforeinput(
        Some("insertText"),
        Some("!"),
        false
    ));
    for (input_type, data, composing) in [
        (Some("insertText"), Some("!x"), false),
        (Some("insertText"), Some("!"), true),
        (Some("historyUndo"), Some("!"), false),
        (Some("historyRedo"), Some("!"), false),
        (Some("insertFromPaste"), Some("!"), false),
        (Some("insertFromDrop"), Some("!"), false),
        (Some("insertCompositionText"), Some("!"), false),
        (Some("insertFromComposition"), Some("!"), false),
        (None, Some("!"), false),
    ] {
        assert!(
            !super::web_bang::qualifies_beforeinput(input_type, data, composing),
            "must not arm shell mode for ({input_type:?}, {data:?}, composing={composing})"
        );
    }

    // Gate enforces matching beforeinput -> input target pairing, bubble expiry, and drop/cancel reset.
    let mut gate = super::web_bang::Gate::<u8>::default();
    gate.on_beforeinput(Some(1), Some("insertText"), Some("!"), false);
    assert!(
        !gate.take(),
        "beforeinput alone must not arm before matching input"
    );
    assert!(gate.on_input_capture(Some(&1), Some("insertText"), Some("!"), false));
    assert!(gate.take());
    assert!(!gate.take());
    gate.on_reset();
    // Canceled beforeinput on textarea 1 followed by input-only edit on textarea 2 never arms.
    gate.on_beforeinput(Some(1), Some("insertText"), Some("!"), false);
    assert!(!gate.on_input_capture(Some(&2), None, Some("!"), false));
    assert!(!gate.take());
    // Qualifying edit in another Rune field on the shared textarea expires at input bubble before drop/paste.
    gate.on_beforeinput(Some(1), Some("insertText"), Some("!"), false);
    assert!(gate.on_input_capture(Some(&1), Some("insertText"), Some("!"), false));
    gate.on_reset();
    assert!(!gate.take());
    // Non-insertText input event (e.g. historyUndo) on same textarea cannot reuse a canceled beforeinput.
    gate.on_beforeinput(Some(1), Some("insertText"), Some("!"), false);
    assert!(!gate.on_input_capture(Some(&1), Some("historyUndo"), Some("!"), false));
    assert!(!gate.take());

    let (mut rt, _rx) = chat_runtime();

    // Desktop clipboard paste / direct changed() must never arm shell mode even when pasting '!'.
    rt.update(|s, tx| {
        s.draft.paste("!");
        super::view::changed(s, tx);
    });
    rt.frame(0.0);
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "!");

    // Web bridge inserts '!' via qualifying beforeinput("insertText", "!") and enters shell mode.
    rt.update(|s, _| s.draft.clear());
    rt.frame(0.0);
    rt.update(|s, tx| {
        s.draft.insert("!");
        assert!(super::view::enter_shell_from_edit(s, tx, true));
    });
    rt.frame(0.0);
    assert!(rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());

    // Exit shell mode, then simulate browser-native Undo, IME commit, or paste (web_bang=false).
    rt.update(|s, _| s.composer.exit_shell_mode());
    rt.frame(0.0);
    rt.update(|s, tx| {
        s.draft.insert("!");
        assert!(!super::view::enter_shell_from_edit(s, tx, false));
        super::view::changed(s, tx);
    });
    rt.frame(0.0);
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "!");

    // A no-op keyboard Undo must not poison the next deliberate '!' on Web.
    rt.update(|s, _| s.draft.clear());
    rt.frame(0.0);
    send_key(
        &mut rt,
        Key::Command('z'),
        Mods {
            ctrl: !cfg!(target_os = "macos"),
            cmd: cfg!(target_os = "macos"),
            ..Mods::default()
        },
    );
    rt.update(|s, tx| {
        s.draft.insert("!");
        assert!(super::view::enter_shell_from_edit(s, tx, true));
    });
    assert!(rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());

    // Deleting "!ls" down to "!" does not enter shell mode because the buffer was not empty.
    rt.update(|s, _| {
        s.composer.exit_shell_mode();
        s.draft.replace_text("!ls");
    });
    rt.frame(0.0);
    rt.update(|s, tx| {
        s.draft.replace_text("!");
        assert!(!super::view::enter_shell_from_edit(s, tx, true));
        super::view::changed(s, tx);
    });
    rt.frame(0.0);
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "!");
}

#[test]
fn shell_mode_honors_prompt_submit_on_enter_and_ignores_alternate_send() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        crate::settings::fixture_settings(s, serde_json::json!({ "promptSubmitOnEnter": false }));
    });
    rt.frame(0.0);

    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    send_key(&mut rt, Key::Text("echo hi".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);

    let primary = if cfg!(target_os = "macos") {
        Mods {
            cmd: true,
            logo: true,
            ..Mods::default()
        }
    } else {
        Mods {
            ctrl: true,
            ..Mods::default()
        }
    };

    // Primary+Shift+Enter (cross-platform alternate delivery) must not execute in shell mode.
    send_key(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..primary
        },
    );
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
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo hi");

    // With promptSubmitOnEnter=false, plain Enter inserts a newline instead of executing.
    send_key(&mut rt, Key::Enter, Mods::default());
    assert!(rx.try_recv().is_err());
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo hi\n");

    // Mod+Enter sends the shell command.
    send_key(&mut rt, Key::Enter, primary);
    let Command::Shell { command, .. } = rx.try_recv().expect("shell command on Mod+Enter") else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo hi");
    assert!(!rt.state.composer.shell_mode);
}

#[test]
fn in_flight_shell_reserves_command_and_reconciles_from_history_and_clear_keeps_attachments() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo once");
        s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
    });
    rt.frame(0.0);

    // Enqueue reserves the session/command pair immediately across the window.
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell { attempt, command } = rx.try_recv().expect("shell command") else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo once");

    // Simulate another tab on the same session trying to dispatch the same command while in-flight.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo once");
    });
    assert!(super::command_receipts::repeats(&rt.state));
    assert!(!super::actions::command_held(&rt.state));
    assert!(!can_send(&rt.state));

    // Order 1: Unconfirmed arrives FIRST (restoring untouched draft in shell mode),
    // then matching shell row arrives and clears BOTH the hold and the untouched restored draft.
    rt.update(|s, _| {
        s.draft.clear();
        s.composer.shell_mode = false;
    });
    acknowledge(&mut rt.state, &attempt, PromptOutcome::Unconfirmed);
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo once");
    assert!(super::actions::command_held(&rt.state));
    assert!(!can_send(&rt.state));
    rt.update(|s, _| {
        s.messages.push(std::sync::Arc::new(crate::Message {
            id: attempt.clone(),
            role: "shell".into(),
            completed: true,
            body: "$ echo once\nonce".into(),
            usage: None,
            parts: Vec::new(),
        }));
        super::actions::reconcile(s);
    });
    assert!(!super::command_receipts::repeats(&rt.state));
    assert!(!super::actions::command_held(&rt.state));
    assert!(!rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);

    // Order 2: Matching running shell row arrives BEFORE HTTP Unconfirmed.
    // Reservation stays active while POST is in flight; late Unconfirmed settles without holding or restoring.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo twice");
    });
    rt.frame(0.0);
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell {
        attempt: attempt2,
        command: cmd2,
    } = rx.try_recv().expect("second shell command")
    else {
        panic!("expected Command::Shell");
    };
    assert_eq!(cmd2, "echo twice");
    rt.update(|s, _| {
        s.messages.push(std::sync::Arc::new(crate::Message {
            id: attempt2.clone(),
            role: "shell".into(),
            completed: false,
            body: "echo twice".into(),
            usage: None,
            parts: Vec::new(),
        }));
        super::actions::reconcile(s);
    });
    // Still reserved while HTTP POST has not settled.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo twice");
    });
    assert!(super::command_receipts::repeats(&rt.state));
    rt.update(|s, _| {
        s.draft.clear();
        s.composer.shell_mode = false;
    });
    acknowledge(&mut rt.state, &attempt2, PromptOutcome::Unconfirmed);
    assert!(!super::command_receipts::repeats(&rt.state));
    assert!(!super::actions::command_held(&rt.state));
    assert!(!rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());

    // Tab stash before a late shell refusal preserves draft text without re-arming shell mode.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo stashed");
    });
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell {
        attempt: attempt3, ..
    } = rx.try_recv().expect("third shell command")
    else {
        panic!("expected Command::Shell");
    };
    rt.update(|s, _| s.composer.on_tab_stash());
    acknowledge(&mut rt.state, &attempt3, PromptOutcome::Rejected);
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo stashed");

    // Recalling in shell mode, exiting shell mode, then clearing (Ctrl+K) still preserves parked attachments.
    rt.update(|s, _| {
        s.draft.clear();
        s.composer.shell_mode = true;
        assert_eq!(s.composer.draft.attachments.len(), 1);
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Up, Mods::default());
    assert_eq!(rt.state.draft.text, "echo stashed");
    assert!(rt.state.composer.recall.is_some());
    rt.update(|s, _| s.composer.exit_shell_mode());
    rt.update(|s, tx| super::menu::clear(s, tx));
    assert!(rt.state.draft.text.is_empty());
    assert!(rt.state.composer.recall.is_none());
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    assert!(matches!(
        rt.state.composer.draft.attachments[0],
        Attachment::Skill { .. }
    ));

    // Repeated large paste placeholders fail fast under the 128 KiB shell limit.
    rt.update(|s, _| {
        s.composer.draft.attach(Attachment::Pasted {
            id: 9,
            text: std::sync::Arc::from("x".repeat(40 * 1024)),
        });
        s.draft = TextEdit::new("[pasted #9] [pasted #9] [pasted #9] [pasted #9]");
    });
    assert!(
        rt.state
            .composer
            .draft
            .resolve_shell(&rt.state.draft)
            .is_none()
    );
}

#[test]
fn shell_reconciliation_clears_stashed_and_recalled_restores_and_held_enter_never_double_sends() {
    let (mut rt, rx) = chat_runtime();
    rt.update(|s, _| {
        s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
    });
    rt.frame(0.0);

    // Holding Enter across a shell send with parked attachments must not send an ordinary prompt.
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    send_key(&mut rt, Key::Text("echo hold".into()), Mods::default());
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(0.02);
    let Command::Shell { attempt, command } = rx.try_recv().expect("shell command") else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo hold");
    assert!(!rt.state.composer.shell_mode);
    acknowledge(
        &mut rt.state,
        &attempt,
        PromptOutcome::Confirmed(attempt.clone()),
    );
    rt.repeat_key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(0.02);
    assert!(
        rx.try_recv().is_err(),
        "repeated Enter after shell send must not submit parked attachments as a prompt"
    );
    rt.key_up(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });

    // Stashing before Unconfirmed restores plain draft with RestoredShell;
    // even a held Enter repeat after tab stash must never submit it as an ordinary prompt,
    // and history reconciliation clears the restored draft cleanly.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo pre-stash");
    });
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell { attempt: a_pre, .. } = rx.try_recv().expect("pre-stash shell") else {
        panic!("expected Command::Shell");
    };
    rt.update(|s, _| s.composer.on_tab_stash());
    acknowledge(&mut rt.state, &a_pre, PromptOutcome::Unconfirmed);
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo pre-stash");
    rt.repeat_key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(0.02);
    assert!(
        rx.try_recv().is_err(),
        "repeated Enter after tab stash + Unconfirmed restore must not submit an ordinary prompt"
    );
    rt.update(|s, _| {
        s.messages.push(std::sync::Arc::new(crate::Message {
            id: a_pre.clone(),
            role: "shell".into(),
            completed: true,
            body: "$ echo pre-stash\nok".into(),
            usage: None,
            parts: Vec::new(),
        }));
        super::actions::reconcile(s);
    });
    assert!(rt.state.draft.text.is_empty());
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);

    // Reconciling while forced recall is active (even after editing the recalled entry)
    // clears the parked untouched fresh draft AND exits shell mode when leaving recall.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo recalled-restore");
    });
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell { attempt: a_rec, .. } = rx.try_recv().expect("recall-restore shell") else {
        panic!("expected Command::Shell");
    };
    acknowledge(&mut rt.state, &a_rec, PromptOutcome::Unconfirmed);
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo recalled-restore");
    rt.update(|s, tx| {
        assert!(super::recall::step(s, true, true, tx));
        // Editing the recalled entry must NOT mark the parked RestoredShell as edited.
        s.draft.insert(" --flag");
        s.composer.mark_edited();
    });
    assert!(rt.state.composer.recall.is_some());
    rt.update(|s, _| {
        s.messages.push(std::sync::Arc::new(crate::Message {
            id: a_rec.clone(),
            role: "shell".into(),
            completed: true,
            body: "$ echo recalled-restore\nok".into(),
            usage: None,
            parts: Vec::new(),
        }));
        super::actions::reconcile(s);
    });
    // Leaving recall restores an empty fresh draft in normal mode (not shell mode) with parked skill intact.
    rt.update(|s, _| super::recall::restore(s));
    assert!(rt.state.draft.text.is_empty());
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);

    // Exiting shell mode after reconciliation during recall and pressing Clear still keeps parked attachments.
    rt.update(|s, _| {
        s.composer.shell_mode = true;
        s.draft.replace_text("echo recalled-clear");
    });
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell { attempt: a_clr, .. } = rx.try_recv().expect("recall-clear shell") else {
        panic!("expected Command::Shell");
    };
    acknowledge(&mut rt.state, &a_clr, PromptOutcome::Unconfirmed);
    rt.update(|s, tx| {
        assert!(super::recall::step(s, true, true, tx));
    });
    rt.update(|s, _| {
        s.messages.push(std::sync::Arc::new(crate::Message {
            id: a_clr.clone(),
            role: "shell".into(),
            completed: true,
            body: "$ echo recalled-clear\nok".into(),
            usage: None,
            parts: Vec::new(),
        }));
        super::actions::reconcile(s);
        s.composer.exit_shell_mode();
    });
    rt.update(|s, tx| super::menu::clear(s, tx));
    assert!(rt.state.draft.text.is_empty());
    assert!(!rt.state.composer.shell_mode);
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    assert!(matches!(
        rt.state.composer.draft.attachments[0],
        Attachment::Skill { .. }
    ));

    // Holding Escape on an edited recalled entry in shell mode exits shell mode without cancelling recall.
    rt.update(|s, _| {
        s.draft.clear();
        s.composer.shell_mode = true;
    });
    rt.frame(0.0);
    send_key(&mut rt, Key::Up, Mods::default());
    send_key(&mut rt, Key::Text(" --edited".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    assert!(rt.state.composer.recall.is_some());
    let edited_text = rt.state.draft.text.clone();
    assert!(edited_text.ends_with(" --edited"));
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    rt.frame(0.02);
    assert!(!rt.state.composer.shell_mode);
    assert!(rt.state.composer.recall.is_some());
    assert_eq!(rt.state.draft.text, edited_text);
    rt.repeat_key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    rt.frame(0.02);
    assert!(
        rt.state.composer.recall.is_some(),
        "repeated Escape after ExitShell must not discard edited recall"
    );
    assert_eq!(rt.state.draft.text, edited_text);
    rt.key_up(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
}

#[test]
fn in_flight_shell_holds_unconfirmed_when_auth_expires_before_receipt() {
    let (mut rt, rx) = chat_runtime();
    let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
    let (event_tx, event_rx) = codenomad_client::bounded(8);
    rt.update(|s, _| {
        crate::settings::connected(s, &backend);
        s.incoming = Some(event_rx);
        s.composer.shell_mode = true;
        s.draft.replace_text("echo auth-expiry-race");
    });
    rt.update(|s, tx| send(s, tx, false));
    let Command::Shell { attempt, command } = rx.try_recv().expect("dispatched shell command")
    else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo auth-expiry-race");
    assert!(rt.state.composer.pending_shell());

    // Transport exits on a concurrent 401 (e.g. SSE or history) before ShellSettled arrives.
    event_tx
        .try_send(codenomad_client::transport::Event::AuthenticationRequired(
            codenomad_client::transport::Authentication {
                backend,
                confirmed: false,
            },
        ))
        .unwrap();
    rt.frame(0.02);

    assert!(!rt.state.composer.pending());
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "echo auth-expiry-race");
    assert!(!rt.state.composer.send_error);
    assert!(super::actions::command_held(&rt.state));
    assert!(
        rt.elements().iter().any(|el| {
            el.role == "alert"
                && el.text.as_deref() == Some(t("missionsPanel.action.requestUpdateUncertain"))
        }),
        "unconfirmed command alert must be visible"
    );

    // Even after reconnecting, the exact command stays held against replay until history confirms it.
    let (reconnected_tx, _reconnected_rx) = codenomad_client::bounded(4);
    rt.update(|s, _| {
        s.phase = Phase::Ready;
        s.stream_offline = false;
        s.commands = Some(reconnected_tx);
    });
    assert!(super::actions::command_held(&rt.state));
    assert!(!can_send(&rt.state));

    rt.update(|s, _| {
        s.messages.push(std::sync::Arc::new(crate::Message {
            id: attempt.clone(),
            role: "shell".into(),
            completed: true,
            body: "$ echo auth-expiry-race\nok".into(),
            usage: None,
            parts: Vec::new(),
        }));
        super::actions::reconcile(s);
    });
    assert!(!super::actions::command_held(&rt.state));
    assert!(rt.state.draft.text.is_empty());
    assert!(!rt.state.composer.shell_mode);
}
