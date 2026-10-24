//! Native dialog shown when the data profile cannot be selected (an invalid `CODENOMAD_PROFILE`).
//! It appears before any profile, and so any saved UI locale, is opened, so it is English-only like
//! the native menus.

/// Reports a startup failure (such as an invalid explicit profile) before exiting.
pub(crate) fn show_startup_error(message: &str) {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("CodeNomad cannot start")
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
