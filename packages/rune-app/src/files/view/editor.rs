use super::{State, activate_enter, document_action_tx, layout, t, theme};
use crate::files::{Ui, document::editor::Decision};
use crate::settings::shortcuts;
use rune::{El, TextEdit};

pub(super) fn source(
    s: &State,
    ui: &Ui,
    path: &str,
    view_width: Option<f32>,
    actions: &mut Vec<El>,
) -> Option<El> {
    if !ui.document.editable() {
        return None;
    }
    let dark = layout::dark();
    let wrap = crate::workspace::file_wrap(s);
    let scope = ui.document.scope();
    let scroll_key = format!("file-source-scroll-{scope}");
    let disabled = !ui.document.writable();
    let save = |ui: &mut Ui, _: &mut rune::Tx| ui.save_document(ui.document.scope());
    let label = t("instanceShell.rightPanel.actions.save");
    let control = theme::editor::save(
        dark,
        label,
        &shortcuts::save_label(s),
        disabled,
        document_action_tx(s, save),
    )
    .key("file-save");
    actions.push(if disabled {
        control
    } else {
        activate_enter(control, document_action_tx(s, save))
    });

    let input_scope = s.input_scope.clone();
    let field = theme::editor::field(dark, path, ui.document.edit(), path, wrap, view_width)
        .on_edit(move |s: &mut State| -> &mut TextEdit {
            if s.current_scope(&input_scope)
                && let Some(ui) = &mut s.files
            {
                return ui.document.input(scope);
            }
            s.rejected_edit = TextEdit::new("");
            &mut s.rejected_edit
        })
        .on_change(document_action_tx(s, |ui, tx| {
            ui.document.changed(ui.document.scope());
            tx.wake_after(std::time::Duration::ZERO);
        }))
        .on_submit(document_action_tx(s, |ui, tx| {
            let scope = ui.document.scope();
            ui.document.input(scope).insert("\n");
            ui.document.changed(scope);
            tx.wake_after(std::time::Duration::ZERO);
        }))
        .on_key({
            let save = document_action_tx(s, save);
            move |s: &mut State, key, tx| {
                if s.files
                    .as_ref()
                    .is_some_and(|ui| !ui.document.edit().is_composing())
                    && shortcuts::matches_save(s, key, tx)
                {
                    if !tx.key_repeat() {
                        save(s, tx);
                    }
                    return true;
                }
                false
            }
        })
        .build(&theme::editor::code_kit(dark))
        .key("file-editor");
    let text = &ui.document.edit().text;
    let source_layout = theme::editor::SourceLayout::new(dark, text, wrap, view_width);
    let viewport = ui.document.source_viewport();
    let reflow = viewport.reflow();
    let restore = document_action_tx(s, {
        let viewport = viewport.clone();
        let scroll_key = scroll_key.clone();
        move |ui, tx| {
            if viewport.reflow() == reflow && (!wrap || view_width.is_some()) {
                viewport.restore(&scroll_key, &ui.document.edit().text, source_layout, tx);
            }
        }
    });
    // Replacement or a new wrap width can move rows without changing the viewport rectangle.
    let watch = rune::el()
        .key(format!(
            "{scroll_key}-anchor-{reflow}-{}",
            source_layout.width_key()
        ))
        .on_layout_tx(move |s, _, tx| restore(s, tx));
    Some(
        theme::editor::editor_view(dark, field, text, wrap, view_width, watch)
            .key(&scroll_key)
            .on_scroll_offset(move |scroll| viewport.observe(scroll.offset, source_layout)),
    )
}

pub(super) fn decision(s: &State, ui: &Ui) -> Option<El> {
    let prompt = ui.document.confirmation()?;
    let (message, cancel, confirm) = match prompt.decision {
        Decision::Overwrite => (
            "instanceShell.rightPanel.actions.conflict.message",
            "instanceShell.rightPanel.actions.conflict.cancelLabel",
            "instanceShell.rightPanel.actions.conflict.confirmLabel",
        ),
        Decision::Discard => (
            "instanceShell.rightPanel.actions.refreshDirty.message",
            "instanceShell.rightPanel.actions.refreshDirty.cancelLabel",
            "instanceShell.rightPanel.actions.refreshDirty.confirmLabel",
        ),
    };
    let scope = s.input_scope.clone();
    let document = ui.document.scope();
    Some(theme::editor::confirmation(
        layout::dark(),
        t(message),
        t(cancel),
        t(confirm),
        move |s: &mut State, accept, tx| {
            if s.current_scope(&scope)
                && let Some(ui) = &mut s.files
                && ui.document.scope() == document
            {
                ui.confirm_document(prompt.id, accept);
                tx.wake_after(std::time::Duration::ZERO);
            }
        },
    ))
}
