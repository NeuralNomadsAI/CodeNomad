use rune::{Key, KeyEvent};

pub(super) fn blocks_recording(event: &KeyEvent, composer_scope: bool) -> bool {
    consumed_by_editor(
        event,
        cfg!(target_arch = "wasm32"),
        cfg!(target_os = "windows"),
        composer_scope,
    )
}

fn consumed_by_editor(event: &KeyEvent, web: bool, windows: bool, composer_scope: bool) -> bool {
    let mods = event.mods;
    let primary = mods.ctrl || mods.cmd || mods.logo;
    // Rune reserves F6 / Shift+F6 for region focus cycling (and floating panel focus).
    if !primary && !mods.alt && event.key == Key::Function(6) {
        return true;
    }
    // Rune #1661: the Web text-field bridge drops function keys without Ctrl/Cmd.
    if web && !primary && matches!(event.key, Key::Function(_)) {
        return true;
    }
    // On Web, Rune's focused textarea sends bare printable keys as edits, never to on_input_key.
    if web && composer_scope && !primary && !mods.alt && matches!(event.key, Key::Text(_)) {
        return true;
    }
    // Rune #1662: native paste is handled before a focused editor can see Ctrl+V.
    // The browser's editor bridge also leaves Ctrl/Cmd+V to the DOM paste path.
    let v = matches!(event.key, Key::Command(c) if c.eq_ignore_ascii_case(&'v'))
        || matches!(&event.key, Key::Text(text) if text.eq_ignore_ascii_case("v"));
    v && (web && primary && !(mods.ctrl && mods.alt)
        || windows && mods.ctrl && !mods.shift && !mods.alt && !mods.logo)
}

#[cfg(test)]
#[test]
fn only_record_shortcuts_the_focused_editor_can_receive() {
    let f8 = KeyEvent {
        key: Key::Function(8),
        mods: Default::default(),
    };
    let ctrl = rune::Mods {
        ctrl: true,
        cmd: true, // Rune's native Windows key table mirrors Ctrl into cmd.
        ..Default::default()
    };
    let paste = KeyEvent {
        key: Key::Command('v'),
        mods: ctrl,
    };
    let f6 = KeyEvent {
        key: Key::Function(6),
        mods: Default::default(),
    };
    let shift_f6 = KeyEvent {
        key: Key::Function(6),
        mods: rune::Mods {
            shift: true,
            ..Default::default()
        },
    };
    assert!(consumed_by_editor(&f6, false, true, false));
    assert!(consumed_by_editor(&shift_f6, false, true, false));
    assert!(!consumed_by_editor(
        &KeyEvent {
            key: Key::Function(6),
            mods: ctrl,
        },
        false,
        true,
        false
    ));
    assert!(consumed_by_editor(&f8, true, false, false));
    assert!(!consumed_by_editor(&f8, false, true, false));
    assert!(!consumed_by_editor(
        &KeyEvent {
            key: Key::Function(8),
            mods: ctrl
        },
        true,
        false,
        false
    ));
    assert!(consumed_by_editor(&paste, false, true, false));
    assert!(consumed_by_editor(&paste, true, false, false));
    let plain_x = KeyEvent {
        key: Key::Text("x".into()),
        mods: Default::default(),
    };
    assert!(consumed_by_editor(&plain_x, true, false, true));
    assert!(!consumed_by_editor(&plain_x, true, false, false));
    assert!(!consumed_by_editor(&plain_x, false, true, true));
}
