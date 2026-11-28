//! The connected server's folders in the launcher, for a machine whose own folder picker
//! cannot name them (a phone, a browser). Each folder listed fills the folder field, which
//! Open takes.
use super::Launcher;
use crate::{State, components::button_tx, strings::t};
use codenomad_client::{Receiver, bounded, folders::Folders};
use rune::{El, edit::TextEdit, text};
use rune_theme_codenomad::{TextRole, layout::Layout};
use std::rc::Rc;

#[derive(Default)]
pub(crate) struct Browser {
    open: bool,
    listing: Option<Folders>,
    failed: bool,
    /// The listing asked for: the connection it was asked of, whether it named a folder, and
    /// its answer.
    load: Option<(u64, bool, Receiver<Option<Folders>>)>,
}

/// Browse where this machine has no folder picker: shows the server's folders, from the one
/// typed in the field when the server lists it, and hides them again.
pub(super) fn toggle(s: &mut State) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if std::mem::take(&mut l.folders).open {
        return;
    }
    l.folders.open = true;
    let typed = l.folder.text.trim();
    let start = (!typed.is_empty()).then(|| typed.to_owned());
    list(l, start);
}

fn list(l: &mut Launcher, path: Option<String>) {
    let Some(backend) = l.connection.clone() else {
        return;
    };
    let (out, input) = bounded(1);
    let wake = l.wake.clone();
    l.folders.failed = false;
    // A listing still on its way is dropped with its receiver: the last one asked for wins.
    l.folders.load = Some((l.connection_generation, path.is_some(), input));
    crate::platform::spawn(async move {
        let _ = out.send(backend.folders(path.as_deref()).await.ok()).await;
        wake();
    });
}

pub(super) fn poll(s: &mut State) -> bool {
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let Some((generation, named, answer)) = &l.folders.load else {
        return false;
    };
    let Ok(listing) = answer.try_recv() else {
        return false;
    };
    let (generation, named) = (*generation, *named);
    l.folders.load = None;
    if generation != l.connection_generation {
        l.folders = Browser::default();
        return true;
    }
    match listing {
        Some(listing) => {
            if let Some(path) = &listing.absolute {
                l.folder = TextEdit::new(path);
            }
            l.folders.listing = Some(listing);
        }
        // The folder typed in the field isn't one the server lists: start from its own.
        None if named && l.folders.listing.is_none() => list(l, None),
        None => l.folders.failed = true,
    }
    true
}

/// The browser's rows under the launcher's folder actions; none while it is closed.
pub(super) fn rows(l: &Launcher, scope: &Rc<()>, busy: bool) -> Vec<El> {
    let browser = &l.folders;
    if !browser.open {
        return Vec::new();
    }
    let busy = busy || browser.load.is_some();
    let go = |key: &str, label: &str, path: &str| {
        let path = path.to_owned();
        button_tx(
            key,
            label,
            busy,
            crate::screen::action_tx(scope, move |s: &mut State, _| {
                if let Some(l) = s.screen.launcher_mut() {
                    list(l, Some(path.clone()));
                }
            }),
        )
    };
    // The folder being listed, by its name: the field above shows the start of its path.
    let title = match browser.listing.as_ref().and_then(|l| l.absolute.as_deref()) {
        Some(path) => text(codenomad_client::server_path_basename(path)).literal_direction(),
        None => text(t("directoryBrowser.goTo")),
    };
    let mut rows = vec![title.text_role(TextRole::Title).key("folder-current")];
    if browser.failed {
        rows.push(text(t("directoryBrowser.load.errorFallback")));
    }
    let Some(listing) = &browser.listing else {
        if browser.load.is_some() {
            rows.push(text(t("directoryBrowser.loadingFolders")));
        }
        return rows;
    };
    if let Some(parent) = &listing.parent {
        rows.push(go(
            "folder-parent",
            t("directoryBrowser.goToParent"),
            parent,
        ));
    }
    if let Some(home) = listing
        .home
        .as_ref()
        .filter(|home| listing.absolute.as_ref() != Some(home))
    {
        rows.push(go("folder-home", t("directoryBrowser.goToHome"), home));
    }
    if listing.folders.is_empty() {
        rows.push(text(t("directoryBrowser.noFolders")));
    }
    for (index, folder) in listing.folders.iter().enumerate() {
        rows.push(go(&format!("folder-{index}"), &folder.name, &folder.path).literal_direction());
    }
    rows
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
