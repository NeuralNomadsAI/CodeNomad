use rune::{Key, KeyEvent};

pub(super) fn blocks_recording(event: &KeyEvent) -> bool {
    consumed_by_editor(
        event,
        cfg!(target_arch = "wasm32"),
        cfg!(target_os = "windows"),
    )
}

fn consumed_by_editor(event: &KeyEvent, web: bool, windows: bool) -> bool {
    let mods = event.mods;
    let primary = mods.ctrl || mods.cmd || mods.logo;
    // Rune #1661: the Web text-field bridge drops function keys without Ctrl/Cmd.
    if web && !primary && matches!(event.key, Key::Function(_)) {
        return true;
    }
    // Rune #1662: native paste is handled before a focused editor can see Ctrl+V.
    // The browser's editor bridge also leaves Ctrl/Cmd+V to the DOM paste path.
    let v = matches!(event.key, Key::Command(c) if c.eq_ignore_ascii_case(&'v'))
        || matches!(&event.key, Key::Text(text) if text.eq_ignore_ascii_case("v"));
    v && (web && primary && !(mods.ctrl && mods.alt)
        || windows && mods.ctrl && !mods.shift && !mods.alt && !mods.cmd && !mods.logo)
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
        ..Default::default()
    };
    let paste = KeyEvent {
        key: Key::Command('v'),
        mods: ctrl,
    };
    assert!(consumed_by_editor(&f8, true, false));
    assert!(!consumed_by_editor(&f8, false, true));
    assert!(!consumed_by_editor(
        &KeyEvent {
            key: Key::Function(8),
            mods: ctrl
        },
        true,
        false
    ));
    assert!(consumed_by_editor(&paste, false, true));
    assert!(consumed_by_editor(&paste, true, false));
}
