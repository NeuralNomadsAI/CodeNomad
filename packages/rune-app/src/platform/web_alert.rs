// The canvas mirror presents the text; the DOM live region supplies the alert role.
pub(crate) fn history_filtered(message: Option<&str>) {
    if let Some(alert) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.get_element_by_id("rune-history-alert"))
    {
        alert.set_text_content(message);
    }
}
