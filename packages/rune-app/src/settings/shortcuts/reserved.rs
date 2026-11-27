use rune::{Key, KeyEvent};

pub(super) fn blocks_recording(event: &KeyEvent, base: Option<char>) -> bool {
    consumed_by_editor(event, base, cfg!(target_arch = "wasm32"))
}

fn consumed_by_editor(event: &KeyEvent, base: Option<char>, web: bool) -> bool {
    let mods = event.mods;
    let primary = mods.ctrl || mods.cmd || mods.logo;
    // Rune reserves F6 / Shift+F6 for region focus cycling (and floating panel focus).
    if !primary && !mods.alt && event.key == Key::Function(6) {
        return true;
    }
    // Rune's Web bridge leaves browser-reserved F5/F12 to the browser without a primary modifier.
    if web && !primary && matches!(event.key, Key::Function(5 | 12)) {
        return true;
    }
    // The browser's editor bridge leaves primary-modifier V to the DOM paste path,
    // except when a non-Latin layout reports a non-V base character (e.g. Russian Ctrl+М).
    let v = base.is_none_or(|c| c.eq_ignore_ascii_case(&'v'))
        && (matches!(event.key, Key::Command(c) if c.eq_ignore_ascii_case(&'v'))
            || matches!(&event.key, Key::Text(text) if text.eq_ignore_ascii_case("v")));
    v && web && primary && !(mods.ctrl && mods.alt)
}

#[cfg(test)]
#[test]
fn only_record_shortcuts_the_focused_editor_can_receive() {
    let f5 = KeyEvent {
        key: Key::Function(5),
        mods: Default::default(),
    };
    let f8 = KeyEvent {
        key: Key::Function(8),
        mods: Default::default(),
    };
    let f12 = KeyEvent {
        key: Key::Function(12),
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
    assert!(consumed_by_editor(&f6, None, false));
    assert!(consumed_by_editor(&shift_f6, None, false));
    assert!(!consumed_by_editor(
        &KeyEvent {
            key: Key::Function(6),
            mods: ctrl,
        },
        None,
        false,
    ));
    assert!(!consumed_by_editor(&f8, None, true));
    assert!(!consumed_by_editor(&f8, None, false));
    assert!(consumed_by_editor(&f5, None, true));
    assert!(consumed_by_editor(&f12, None, true));
    assert!(!consumed_by_editor(&f5, None, false));
    assert!(!consumed_by_editor(&f12, None, false));
    assert!(!consumed_by_editor(
        &KeyEvent {
            key: Key::Function(5),
            mods: ctrl,
        },
        None,
        true,
    ));
    assert!(!consumed_by_editor(&paste, Some('v'), false));
    assert!(consumed_by_editor(&paste, Some('v'), true));
    assert!(consumed_by_editor(&paste, None, true));
    assert!(!consumed_by_editor(&paste, Some('м'), true));
    assert!(!consumed_by_editor(
        &KeyEvent {
            key: Key::Command('v'),
            mods: rune::Mods { alt: true, ..ctrl },
        },
        Some('v'),
        true,
    ));
}
