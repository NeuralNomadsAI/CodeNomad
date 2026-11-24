use gtk::glib::object::{ObjectExt, ObjectType};
use webkit2gtk::{BackForwardListExt, BackForwardListItem, BackForwardListItemExt, WebViewExt};

#[derive(Clone)]
pub(super) struct Entry(BackForwardListItem);

impl Entry {
    pub(super) fn token(&self) -> usize {
        self.0.as_ptr() as usize
    }

    pub(super) fn url(&self) -> String {
        self.0.uri().map(|uri| uri.to_string()).unwrap_or_default()
    }
}

pub(super) fn snapshot(webview: &webkit2gtk::WebView) -> (Vec<Entry>, Option<usize>) {
    let Some(list) = webview.back_forward_list() else {
        return (Vec::new(), None);
    };
    let current = list.current_item().map(|item| item.as_ptr() as usize);
    // nth_item is relative to the current item and keeps native ordering,
    // including multiple same-document entries with identical URLs.
    let entries = (-31..32)
        .filter_map(|offset| list.nth_item(offset))
        .map(Entry)
        .collect();
    (entries, current)
}

pub(super) fn go(webview: &webkit2gtk::WebView, entry: &Entry) -> Result<(), String> {
    webview.go_to_back_forward_list_item(&entry.0);
    Ok(())
}

pub(super) fn observe(webview: &webkit2gtk::WebView, changed: impl Fn(String) + 'static) {
    use std::rc::Rc;
    let changed = Rc::new(changed);
    let uri_changed = changed.clone();
    webview.connect_uri_notify(move |view| {
        if let Some(uri) = view.uri() {
            uri_changed(uri.to_string());
        }
    });
    if let Some(list) = webview.back_forward_list() {
        let weak = webview.downgrade();
        // The generated binding omits this signal's GList argument. GLib's
        // generic signal API handles it without taking ownership of that list.
        list.connect_local("changed", false, move |_| {
            if let Some(view) = weak.upgrade() {
                if let Some(uri) = view.uri() {
                    changed(uri.to_string());
                }
            }
            None
        });
    }
}
