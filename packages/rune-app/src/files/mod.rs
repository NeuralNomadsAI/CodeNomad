pub mod document;
pub mod reader;
pub mod request;
pub mod state;
mod ui;
pub use ui::Ui;

pub fn bind(s: &mut crate::State, backend: &crate::backend::Backend) {
    s.files = s.launcher.as_ref().and_then(|launcher| {
        let project = launcher
            .project
            .as_ref()
            .filter(|p| p.id == backend.workspace)?;
        Some(Ui::new(
            backend.clone(),
            project.path.clone(),
            s.reads.clone(),
            s.wake.clone(),
        ))
    });
}

#[cfg(test)]
mod tests;
