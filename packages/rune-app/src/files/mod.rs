pub mod document;
mod errors;
mod layout;
mod markdown_images;
mod presentation;
pub mod reader;
pub mod request;
pub mod state;
mod ui;
pub(crate) mod view;
pub use ui::Ui;
pub(crate) use view::{reader, tree};

pub(crate) fn has_preview(s: &crate::State) -> bool {
    s.files
        .as_ref()
        .is_some_and(|ui| ui.reader.target().is_some())
}

pub(crate) fn modal_open(s: &crate::State) -> bool {
    s.files
        .as_ref()
        .is_some_and(|ui| ui.document.confirmation().is_some() || ui.actions.is_menu_open())
}

pub(crate) fn poll_notices(s: &mut crate::State) -> bool {
    let saved = s.files.as_mut().is_some_and(Ui::observe_document_write);
    if saved {
        crate::shell::notifications::emit(
            s,
            crate::shell::notifications::Category::Files,
            None,
            crate::strings::t("instanceShell.rightPanel.toast.saveSuccess"),
        );
    }
    saved | view::poll_notices(s)
}

pub(crate) fn open_session_path(
    s: &mut crate::State,
    backend: &crate::backend::Backend,
    directory: String,
    path: String,
) -> bool {
    let Some(ui) = s
        .files
        .as_mut()
        .filter(|ui| ui.backend.workspace == backend.workspace && ui.uses_connection(backend))
    else {
        return false;
    };
    ui.open_session_path(directory, path)
}

pub(crate) fn poll(s: &mut crate::State, now: f64, tx: &mut rune::Tx) -> bool {
    let notices = poll_notices(s);
    let changed = s.files.as_mut().is_some_and(|ui| {
        let selected = ui.sync_tree_focus(tx);
        let polled = ui.poll(now);
        if let Some(deadline) = ui.next_wake() {
            tx.wake_after(std::time::Duration::from_secs_f64(
                (deadline - now).max(0.0),
            ));
        }
        polled || selected
    });
    notices | changed | view::poll_actions(s, tx)
}

pub fn bind(s: &mut crate::State, backend: &crate::backend::Backend) {
    if let Some(ui) = s.files.as_mut().filter(|ui| {
        ui.backend.workspace == backend.workspace
            && ui.backend.base == backend.base
            && (ui.uses_connection(backend) || ui.same_server_identity(backend))
            && ui.backend.session.is_empty()
    }) {
        ui.rebind_session(backend);
        return;
    }
    s.files = s.screen.launcher().and_then(|launcher| {
        let project = launcher
            .project
            .as_ref()
            .filter(|p| p.id == backend.workspace)?;
        Some(
            Ui::new(
                backend.clone(),
                project.path.clone(),
                s.reads.clone(),
                s.wake.clone(),
            )
            .with_shell(launcher.local_connection())
            .with_documents(
                s.documents.clone(),
                s.workspace
                    .as_ref()
                    .map_or_else(|| backend.workspace.clone(), |ui| ui.active_key().into()),
            )
            .with_draft_project(project.clone()),
        )
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) mod test_http;
#[cfg(test)]
mod tests;
