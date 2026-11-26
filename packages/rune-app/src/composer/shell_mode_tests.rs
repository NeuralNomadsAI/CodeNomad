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

    // Typing '!' while already in shell mode inserts literally into the command.
    send_key(&mut rt, Key::Text("!".into()), Mods::default());
    assert!(rt.state.composer.shell_mode);
    assert_eq!(rt.state.draft.text, "!");

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

    // More actions menu disables alternate delivery in shell mode even while Streaming.
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

    // Submit in shell mode: expands pasted placeholder, keeps @literal, exits shell mode, clears attachments.
    rt.update(|s, tx| send(s, tx, true));
    let Command::Shell { attempt, command } = rx.try_recv().expect("shell command") else {
        panic!("expected Command::Shell");
    };
    assert_eq!(command, "echo world @literal");
    assert!(!rt.state.composer.shell_mode);
    assert!(rt.state.draft.text.is_empty());
    assert!(rt.state.composer.draft.attachments.is_empty());
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
