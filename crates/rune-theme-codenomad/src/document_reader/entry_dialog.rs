use super::*;

pub fn entry_dialog<S: 'static>(
    dark: bool,
    title: &str,
    pending: bool,
    close: impl Fn(&mut S) + Clone + 'static,
    body: El,
) -> Vec<El> {
    let mut layers = Vec::new();
    rune_kit::Dialog::new("file-create", title)
        .open(true)
        .fit()
        .click_outside(!pending)
        .on_close(close)
        .child(body)
        .build(kit(dark), &mut layers);
    layers
}
