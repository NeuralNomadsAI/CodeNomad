//! Read-only Mission directory. Shell mounting is separate from the project-owned state.
mod directory;
mod view;

pub(crate) use directory::Panel;
pub(crate) use view::panel;
