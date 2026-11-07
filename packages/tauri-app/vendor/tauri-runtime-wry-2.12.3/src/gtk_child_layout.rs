// Copyright 2026 CodeNomad contributors
// SPDX-License-Identifier: Apache-2.0 OR MIT

use gtk::prelude::*;

const NAME: &str = "tauri-webview-overlay";

pub(crate) fn content(vbox: &gtk::Box) -> gtk::Box {
  vbox
    .children()
    .into_iter()
    .find(|widget| widget.widget_name() == NAME)
    .and_then(|widget| widget.downcast::<gtk::Overlay>().ok())
    .and_then(|overlay| overlay.child())
    .and_then(|widget| widget.downcast::<gtk::Box>().ok())
    .unwrap_or_else(|| vbox.clone())
}

// GTK owns the layout for exactly the lifetime of its window. Keeping the
// overlay inside Tao's vbox leaves the menu bar outside content coordinates.
pub(crate) fn containers(vbox: &gtk::Box) -> (gtk::Box, gtk::Fixed) {
  if let Some(overlay) = vbox.children().into_iter().find_map(|widget| {
    (widget.widget_name() == NAME)
      .then(|| widget.downcast::<gtk::Overlay>().ok())
      .flatten()
  }) {
    let content = overlay.child().unwrap().downcast::<gtk::Box>().unwrap();
    let children = overlay
      .children()
      .into_iter()
      .find_map(|widget| widget.downcast::<gtk::Fixed>().ok())
      .unwrap();
    return (content, children);
  }

  let overlay = gtk::Overlay::new();
  overlay.set_widget_name(NAME);
  let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
  let children = gtk::Fixed::new();
  overlay.add(&content);
  // The primary-only path keeps Tao's original box. Install the overlay lazily
  // on first child creation and move only its existing WebKit content.
  for widget in vbox.children() {
    if widget.is::<webkit2gtk::WebView>() {
      vbox.remove(&widget);
      content.pack_start(&widget, true, true, 0);
    }
  }
  overlay.add_overlay(&children);
  // GtkFixed has no native input window; WebKit's child windows receive input
  // inside their rectangles, while the uncovered area reaches the main view.
  overlay.set_overlay_pass_through(&children, true);
  vbox.pack_start(&overlay, true, true, 0);
  overlay.show_all();
  (content, children)
}
