pub mod document;
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

pub(crate) fn poll(s: &mut crate::State, now: f64, tx: &mut rune::Tx) -> bool {
    let changed = s.files.as_mut().is_some_and(|ui| {
        let selected = ui.sync_tree_focus(tx);
        ui.poll(now) || selected
    });
    changed | view::poll_actions(s, tx)
}

pub fn bind(s: &mut crate::State, backend: &crate::backend::Backend) {
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
