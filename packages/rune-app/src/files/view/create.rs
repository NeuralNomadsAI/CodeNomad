use crate::{
    State,
    components::button_tx,
    files::{Ui, ui::entry_create::create_key},
    screen,
    strings::t,
};
use codenomad_client::files::EntryKind;
use rune::{El, TextEdit, text};
use rune_theme_codenomad::{
    Space, document_reader, field_kit,
    layout::{self, Layout},
};
use std::rc::Rc;

fn label(kind: EntryKind) -> &'static str {
    t(match kind {
        EntryKind::File => "filesPanel.newFile",
        EntryKind::Directory => "directoryBrowser.newFolder",
    })
}

pub(super) fn toolbar(s: &State, ui: &Ui) -> Option<El> {
    ui.create.local.then(|| {
        let scope = &s.input_scope;
        let mut actions = layout::action_row().pad(Space::Sm);
        for kind in [EntryKind::File, EntryKind::Directory] {
            let run = Rc::new(screen::action_tx(scope, move |s, tx| {
                if let Some(ui) = &mut s.files {
                    ui.start_create(kind, tx);
                }
            }));
            let enter = run.clone();
            let disabled = !ui.can_create();
            let button = button_tx(create_key(kind), label(kind), disabled, move |s, tx| {
                run(s, tx)
            });
            actions = actions.child(if disabled {
                button
            } else {
                super::activate_enter(button, move |s, tx| enter(s, tx))
            });
        }
        actions.children(
            ui.creation_unclear()
                .then(|| text(t("filesPanel.entryCreateUnclear")).role("alert")),
        )
    })
}

pub(super) fn dialog(s: &State, ui: &Ui) -> Vec<El> {
    let Some(form) = &ui.create.form else {
        return vec![];
    };
    let id = form.id;
    let dark = layout::dark();
    let scope = s.input_scope.clone();
    let pending = ui.create.pending;
    let submit = Rc::new(screen::action_tx(&scope, move |s, _| {
        if let Some(ui) = &mut s.files {
            ui.create_entry(id);
        }
    }));
    let cancel = Rc::new(screen::action(&scope, move |s| {
        if let Some(ui) = &mut s.files {
            ui.cancel_create(id);
        }
    }));
    let on_submit = submit.clone();
    let input = layout::literal_field(&form.edit)
        .label(t(if form.kind() == EntryKind::Directory {
            "directoryBrowser.createFolder.inputLabel"
        } else {
            "filesPanel.fileName"
        }))
        .disabled(pending)
        .on_edit(move |s: &mut State| -> &mut TextEdit {
            if s.current_scope(&scope)
                && let Some(ui) = s.files.as_mut()
                && !ui.create.pending
                && let Some(form) = ui.create.form.as_mut().filter(|form| form.id == id)
            {
                return &mut form.edit;
            }
            s.rejected_edit = TextEdit::new("");
            &mut s.rejected_edit
        })
        .on_submit(move |s, tx| on_submit(s, tx))
        .build(field_kit(dark))
        .key("file-create-name");
    let press = submit.clone();
    let close = cancel.clone();
    let confirm = button_tx(
        "file-create-confirm",
        t("directoryBrowser.createFolder.confirmLabel"),
        pending,
        move |s, tx| press(s, tx),
    );
    let dismiss = button_tx(
        "file-create-cancel",
        t("alertDialog.actions.cancel"),
        pending,
        move |s, _| close(s),
    );
    let enter = cancel.clone();
    let actions = layout::action_row()
        .child(if pending {
            dismiss
        } else {
            super::activate_enter(dismiss, move |s, _| enter(s))
        })
        .child(if pending {
            confirm
        } else {
            super::activate_enter(confirm, move |s, tx| submit(s, tx))
        });
    document_reader::entry_dialog(
        dark,
        label(form.kind()),
        pending,
        move |s: &mut State| cancel(s),
        rune::col()
            .pad(Space::Md)
            .separate(Space::Sm)
            .child(text(if form.parent() == "." {
                ui.tree.directory()
            } else {
                form.parent()
            }))
            .child(input)
            .children(
                form.error
                    .as_ref()
                    .map(|error| text(error.message()).role("alert")),
            )
            .child(actions),
    )
}
