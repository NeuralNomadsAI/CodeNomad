use crate::{State, platform};
use rune::{Key, KeyEvent, PhysicalInput, PhysicalKeyCode, Tx};
use std::{cell::Cell, rc::Rc};

pub(super) type Read = Rc<Cell<bool>>;

pub fn physical(s: &mut State, event: &PhysicalInput, tx: &mut Tx) -> bool {
    let PhysicalInput::Key {
        key: PhysicalKeyCode::KeyV,
        mods,
        pressed: true,
        repeat,
        ..
    } = *event
    else {
        return false;
    };
    if (KeyEvent {
        key: Key::Command('v'),
        mods,
    })
    .edit_command()
        != Some('v')
    {
        return false;
    }
    if !repeat {
        request(s, tx);
    }
    true
}

pub fn request(s: &mut State, tx: &mut Tx) {
    if !s.composer_active() || s.composer_editing_locked() || s.composer.device.clipboard.is_some()
    {
        return;
    }
    let owner = Rc::new(Cell::new(true));
    let scope = s.input_scope.clone();
    let text = s.draft.text.clone();
    let range = s.draft.range();
    s.composer.device.clipboard = Some(owner.clone());
    tx.read_clipboard(move |s: &mut State, content, tx| {
        if !s
            .composer
            .device
            .clipboard
            .as_ref()
            .is_some_and(|id| Rc::ptr_eq(id, &owner))
        {
            return;
        }
        s.composer.device.clipboard = None;
        if !owner.get()
            || !s.current_scope(&scope)
            || s.draft.text != text
            || s.draft.range() != range
        {
            return;
        }
        if !platform::device_picker::paste(s, content)
            && !content.text().is_empty()
            && !super::long_paste::paste(s, content.text(), tx)
        {
            s.draft.paste(content.text());
            super::view::changed(s, tx);
        }
    });
}

pub fn menu(
    s: &mut State,
    point: (f32, f32),
    look: rune_theme_codenomad::layout::PopupMenuLook,
    tx: &mut Tx,
) {
    let scope = s.input_scope.clone();
    let (a, b) = s.draft.range();
    rune_theme_codenomad::layout::editor_menu(
        tx,
        point,
        a != b,
        look,
        move |s: &mut State, action, tx| {
            if !s.current_scope(&scope) || s.composer.editing_locked() {
                return;
            }
            match action {
                Some("paste") => {
                    tx.focus("composer", false);
                    request(s, tx);
                }
                Some("cut" | "copy") => {
                    let (a, b) = s.draft.range();
                    if a != b
                        && let Some(text) = s.draft.text.get(a..b)
                    {
                        crate::chat::tools::children::note_clipboard_write();
                        tx.copy(text);
                        if action == Some("cut") {
                            s.draft.insert("");
                            super::view::changed(s, tx);
                        }
                    }
                }
                Some("select-all") => s.draft.set_selection(0, s.draft.text.len()),
                _ => {}
            }
        },
    );
}
