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
            .with_documents(
                s.documents.clone(),
                s.workspace
                    .as_ref()
                    .map_or_else(|| backend.workspace.clone(), |ui| ui.active_key().into()),
            ),
        )
    });
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod test_http;
#[cfg(test)]
mod tests;
