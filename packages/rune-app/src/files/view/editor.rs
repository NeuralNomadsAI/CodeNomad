use super::{State, activate_enter, document_action_tx, layout, t, theme};
use crate::files::{Ui, document::editor::Decision};
use rune::{El, Key, TextEdit};

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
    let wrap = ui.presentation.wrap;
    let scope = ui.document.scope();
    let disabled = !ui.document.writable();
    let save = |ui: &mut Ui, _: &mut rune::Tx| ui.save_document(ui.document.scope());
    let label = t("instanceShell.rightPanel.actions.save");
    let control =
        theme::editor::save(dark, label, disabled, document_action_tx(s, save)).key("file-save");
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
        .on_change(document_action_tx(s, |ui, _| {
            ui.document.changed(ui.document.scope())
        }))
        .on_submit(document_action_tx(s, |ui, _| {
            let scope = ui.document.scope();
            ui.document.input(scope).insert("\n");
            ui.document.changed(scope);
        }))
        .on_key({
            let save = document_action_tx(s, save);
            move |s, key, tx| {
                if matches!(key.key, Key::Command('s' | 'S'))
                    && key.mods.cmd
                    && !key.mods.shift
                    && !key.mods.alt
                {
                    if !tx.key_repeat() {
                        save(s, tx);
                    }
                    return true;
                }
                false
            }
        })
        .build(theme::editor::code_kit(dark))
        .key("file-editor");
    Some(theme::editor::editor_view(
        dark,
        field,
        &ui.document.edit().text,
        wrap,
        view_width,
    ))
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
        move |s: &mut State, accept, _| {
            if s.current_scope(&scope)
                && let Some(ui) = &mut s.files
                && ui.document.scope() == document
            {
                ui.confirm_document(prompt.id, accept);
            }
        },
    ))
}
