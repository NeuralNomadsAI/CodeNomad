//! Clone Git Repository modal opened from the Home launcher top action bar.
use crate::{
    State,
    backend::Backend,
    launcher::recent,
    platform, screen,
    shell::{directory_browser, launcher_replaces_project},
    strings::{locale, t, with_locale},
    workspace,
};
use codenomad_client::{
    Receiver, bounded,
    workspaces_clone::{
        CloneWorkspaceError, CloneWorkspaceRequest, ClonedWorkspace, parent_directory,
        suggest_clone_destination,
    },
};
use rune::{El, Key, KeyEvent, Mods, Tx, edit::TextEdit};
use rune_theme_codenomad::{
    field_kit,
    launcher::{self as theme, clone_dialog as dialog_theme},
    layout,
};
use std::rc::Rc;

pub(crate) const TRIGGER_KEY: &str = "launcher-clone-repo";
pub(crate) const DIALOG_KEY: &str = "launcher-clone-dialog";
pub(crate) const REPO_URL_FIELD: &str = "clone-repository-url";
pub(crate) const DEST_PATH_FIELD: &str = "clone-destination-path";
pub(crate) const BROWSE_BUTTON: &str = "clone-destination-browse";
pub(crate) const CLEANUP_CHECKBOX: &str = "clone-cleanup-checkbox";
pub(crate) const CANCEL_BUTTON: &str = "clone-cancel";
pub(crate) const SUBMIT_BUTTON: &str = "clone-submit";

struct InFlight {
    connection_generation: u64,
    origin: Backend,
    rx: Receiver<Result<ClonedWorkspace, CloneWorkspaceError>>,
}

#[derive(Default)]
pub(crate) struct CloneDialog {
    open: bool,
    repository_url: TextEdit,
    destination_path: TextEdit,
    clone_parent: Option<String>,
    last_clone_parent: Option<String>,
    destination_edited: bool,
    cleanup: bool,
    error: Option<String>,
    in_flight: Option<InFlight>,
    return_focus: Option<String>,
    pending_restore_focus: Option<String>,
}

impl CloneDialog {
    pub(crate) fn is_busy(&self) -> bool {
        self.in_flight.is_some()
    }

    pub(crate) fn is_composing(&self) -> bool {
        self.open && (self.repository_url.is_composing() || self.destination_path.is_composing())
    }

    fn reset_form(&mut self) {
        self.repository_url = TextEdit::new("");
        self.destination_path = TextEdit::new("");
        self.clone_parent = None;
        self.destination_edited = false;
        self.cleanup = false;
        self.error = None;
    }

    pub(crate) fn dismiss(&mut self) {
        self.open = false;
        self.in_flight = None;
        self.return_focus = None;
        self.pending_restore_focus = None;
        self.reset_form();
    }

    pub(crate) fn reset_for_new_connection(&mut self) {
        self.last_clone_parent = None;
        self.dismiss();
    }

    fn dismiss_from_dialog(&mut self) {
        if self.is_busy() {
            return;
        }
        let restore = self.return_focus.take();
        self.dismiss();
        self.pending_restore_focus = restore;
    }
}

pub(crate) fn host_supports_clone(s: &State) -> bool {
    s.screen
        .launcher()
        .and_then(|l| l.connection.as_ref())
        .is_some_and(|backend| backend.client.supports("workspace-clone"))
}

pub(crate) fn is_open(s: &State) -> bool {
    launcher_replaces_project(s)
        && s.screen.launcher().is_some_and(|l| {
            l.clone_dialog.open && l.connection.is_some() && !l.authentication_required
        })
}

pub(crate) fn is_composing(s: &State) -> bool {
    is_open(s)
        && s.screen
            .launcher()
            .is_some_and(|l| l.clone_dialog.is_composing())
}

fn suggested_clone_parent(s: &State) -> Option<String> {
    let l = s.screen.launcher()?;
    if let Some(parent) = l.clone_dialog.clone_parent.as_deref()
        && !parent.trim().is_empty()
    {
        return Some(parent.to_owned());
    }
    if let Some(parent) = l.clone_dialog.last_clone_parent.as_deref()
        && !parent.trim().is_empty()
    {
        return Some(parent.to_owned());
    }
    recent::collect_recent_entries(s)
        .into_iter()
        .next()
        .map(|entry| parent_directory(&entry.path))
        .filter(|parent| !parent.trim().is_empty())
}

fn clone_destination_browse_path(s: &State) -> Option<String> {
    let l = s.screen.launcher()?;
    let destination = l.clone_dialog.destination_path.text.trim();
    if destination.is_empty() {
        return suggested_clone_parent(s);
    }
    if l.clone_dialog.clone_parent.as_deref() == Some(destination) {
        return Some(destination.to_owned());
    }
    let parent = parent_directory(destination);
    if parent.is_empty() {
        Some(destination.to_owned())
    } else {
        Some(parent)
    }
}

pub(crate) fn open(s: &mut State, tx: &mut Tx) {
    if !host_supports_clone(s)
        || !workspace::input_ready(s)
        || s.screen
            .launcher()
            .is_none_or(|l| l.pending || l.authentication_required)
    {
        return;
    }
    super::dismiss_recent_menu(s, tx);
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    l.clone_dialog.reset_form();
    l.clone_dialog.in_flight = None;
    l.clone_dialog.open = true;
    l.clone_dialog.return_focus = Some(TRIGGER_KEY.to_owned());
    l.clone_dialog.pending_restore_focus = None;
    tx.focus_when_shown(REPO_URL_FIELD, true);
    tx.instant();
}

pub(crate) fn close(s: &mut State, tx: &mut Tx) {
    let target = {
        let Some(l) = s.screen.launcher_mut() else {
            return;
        };
        if !l.clone_dialog.open || l.clone_dialog.is_busy() {
            return;
        }
        let restore = l.clone_dialog.return_focus.take();
        l.clone_dialog.dismiss();
        restore
    };
    if let Some(target) = target {
        tx.return_focus(target, tx.focus_visible());
    }
    tx.instant();
}

fn on_repository_url_change(s: &mut State) {
    let parent = suggested_clone_parent(s);
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if !l.clone_dialog.destination_edited {
        let suggested =
            suggest_clone_destination(parent.as_deref(), &l.clone_dialog.repository_url.text);
        l.clone_dialog.destination_path = TextEdit::new(suggested);
    }
}

fn on_destination_change(s: &mut State) {
    if let Some(l) = s.screen.launcher_mut() {
        l.clone_dialog.destination_edited = !l.clone_dialog.destination_path.text.trim().is_empty();
    }
}

pub(crate) fn choose_parent(s: &mut State, path: String) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return;
    }
    let parent = trimmed.to_owned();
    let url = l.clone_dialog.repository_url.text.trim().to_owned();
    l.clone_dialog.clone_parent = Some(parent.clone());
    l.clone_dialog.destination_edited = false;
    let next_dest = if url.is_empty() {
        parent
    } else {
        suggest_clone_destination(Some(&parent), &url)
    };
    l.clone_dialog.destination_path = TextEdit::new(next_dest);
}

pub(crate) fn browse_destination_in_dialog(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || s.screen.launcher().is_none_or(|l| l.clone_dialog.is_busy()) {
        return;
    }
    let initial = clone_destination_browse_path(s);
    let _ = directory_browser::open_with_callback(
        s,
        initial,
        Some(BROWSE_BUTTON.to_owned()),
        Some(Rc::new(|s, path, _| {
            choose_parent(s, path);
        })),
        tx,
    );
}

pub(crate) fn browse_destination(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || s.screen.launcher().is_none_or(|l| l.clone_dialog.is_busy()) {
        return;
    }
    if platform::folder_picker_available() {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let scope = s.input_scope.clone();
            tx.open_folder(
                rune::file_dialog::FileDialogOptions {
                    title: t("folderSelection.clone.destination.title").into(),
                    ..Default::default()
                },
                move |s: &mut State, result, tx| {
                    if !s.current_scope(&scope) || !is_open(s) {
                        return;
                    }
                    if let Ok(Some(path)) = result {
                        choose_parent(s, path.to_string_lossy().into_owned());
                        tx.instant();
                    }
                },
            );
            return;
        }
    }
    browse_destination_in_dialog(s, tx);
}

pub(crate) fn submit(s: &mut State, tx: &mut Tx) {
    if !is_open(s) || !host_supports_clone(s) {
        return;
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.clone_dialog.is_busy() {
        return;
    }
    let repository_url = l.clone_dialog.repository_url.text.trim().to_owned();
    let destination_path = l.clone_dialog.destination_path.text.trim().to_owned();
    if repository_url.is_empty() || destination_path.is_empty() {
        l.clone_dialog.error = Some(t("folderSelection.clone.dialog.errorRequired").to_owned());
        tx.instant();
        return;
    }
    let Some(backend) = l.connection.clone() else {
        return;
    };
    let cleanup = l.clone_dialog.cleanup;
    let connection_generation = l.connection_generation;
    let wake = l.wake.clone();
    let (out, rx) = bounded(1);
    l.clone_dialog.error = None;
    l.clone_dialog.in_flight = Some(InFlight {
        connection_generation,
        origin: backend.clone(),
        rx,
    });
    let request = CloneWorkspaceRequest {
        repository_url,
        destination_path,
        cleanup,
    };
    platform::spawn(async move {
        let outcome = backend.clone_workspace_repository(&request).await;
        let _ = out.send(outcome).await;
        wake();
    });
    tx.instant();
}

pub(crate) fn handle_key(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if !is_open(s) || directory_browser::is_open(s) {
        return false;
    }
    if event.key == Key::Escape && event.mods == Mods::default() && !tx.key_repeat() {
        close(s, tx);
        return true;
    }
    false
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let mut changed = false;
    let restore = s
        .screen
        .launcher_mut()
        .and_then(|l| l.clone_dialog.pending_restore_focus.take());
    if let Some(target) = restore {
        if !is_open(s) && tx.focused().is_none() {
            tx.return_focus(target, tx.focus_visible());
        }
        changed = true;
    }

    let unavailable = !launcher_replaces_project(s)
        || s.screen
            .launcher()
            .is_none_or(|l| l.connection.is_none() || l.authentication_required);
    if unavailable {
        if let Some(l) = s.screen.launcher_mut()
            && (l.clone_dialog.open || l.clone_dialog.in_flight.is_some())
        {
            l.clone_dialog.dismiss();
            return true;
        }
        return changed;
    }

    let settled = s.screen.launcher_mut().and_then(|l| {
        let result = l.clone_dialog.in_flight.as_ref()?.rx.try_recv().ok()?;
        let flight = l.clone_dialog.in_flight.take()?;
        let same_gen = flight.connection_generation == l.connection_generation;
        Some((same_gen, flight.origin, result))
    });

    let Some((same_gen, origin, result)) = settled else {
        return changed;
    };
    if !same_gen {
        return true;
    }

    match result {
        Ok(cloned) => {
            let parent = parent_directory(&cloned.path);
            if let Some(l) = s.screen.launcher_mut() {
                if !parent.trim().is_empty() {
                    l.clone_dialog.last_clone_parent = Some(parent);
                }
                l.clone_dialog.dismiss();
            }
            let _ = directory_browser::open_workspace_folder(s, &cloned.path, tx);
        }
        Err(CloneWorkspaceError::Unauthorized) => {
            if let Some(l) = s.screen.launcher_mut() {
                l.clone_dialog.dismiss();
            }
            crate::settings::authentication_required(s, &origin);
        }
        Err(err) => {
            if let Some(l) = s.screen.launcher_mut() {
                let message = err.to_string();
                l.clone_dialog.error = Some(if message.trim().is_empty() {
                    t("rune.open_error").to_owned()
                } else {
                    message
                });
            }
        }
    }
    tx.instant();
    true
}

pub(crate) fn append_overlay(s: &State, layer: &mut Vec<El>) {
    if !is_open(s) {
        return;
    }
    let Some(l) = s.screen.launcher() else {
        return;
    };
    let dialog = &l.clone_dialog;
    let scope = s.input_scope.clone();
    let render_locale = locale();
    let busy = dialog.is_busy();

    let repo_field = theme::hinted_literal_field(
        &dialog.repository_url,
        t("folderSelection.clone.dialog.repositoryUrlPlaceholder"),
    )
    .label(t("folderSelection.clone.dialog.repositoryUrl"))
    .input_mode(rune::InputMode::Url)
    .disabled(busy)
    .on_edit({
        let scope = scope.clone();
        move |s: &mut State| {
            if s.current_scope(&scope)
                && let Some(l) = s.screen.launcher_mut()
            {
                &mut l.clone_dialog.repository_url
            } else {
                &mut s.rejected_edit
            }
        }
    })
    .on_change(screen::action_tx(&scope, |s, _| {
        on_repository_url_change(s);
    }))
    .on_submit({
        let scope = scope.clone();
        move |s: &mut State, tx| {
            if s.current_scope(&scope) {
                with_locale(render_locale, || submit(s, tx));
            }
        }
    })
    .build(&field_kit(layout::dark()))
    .key(REPO_URL_FIELD);

    let dest_field = theme::hinted_literal_field(
        &dialog.destination_path,
        t("folderSelection.clone.dialog.destinationPathPlaceholder"),
    )
    .label(t("folderSelection.clone.dialog.destinationPath"))
    .disabled(busy)
    .on_edit({
        let scope = scope.clone();
        move |s: &mut State| {
            if s.current_scope(&scope)
                && let Some(l) = s.screen.launcher_mut()
            {
                &mut l.clone_dialog.destination_path
            } else {
                &mut s.rejected_edit
            }
        }
    })
    .on_change(screen::action_tx(&scope, |s, _| {
        on_destination_change(s);
    }))
    .on_submit({
        let scope = scope.clone();
        move |s: &mut State, tx| {
            if s.current_scope(&scope) {
                with_locale(render_locale, || submit(s, tx));
            }
        }
    })
    .build(&field_kit(layout::dark()))
    .key(DEST_PATH_FIELD);

    let browse_btn = dialog_theme::secondary_button(
        BROWSE_BUTTON,
        t("folderSelection.clone.dialog.browseDestination"),
        busy,
        {
            let scope = scope.clone();
            move |s: &mut State, tx| {
                if s.current_scope(&scope) {
                    with_locale(render_locale, || browse_destination(s, tx));
                }
            }
        },
    );

    let repo_section =
        dialog_theme::field_section(t("folderSelection.clone.dialog.repositoryUrl"), repo_field);
    let dest_section = dialog_theme::field_section(
        t("folderSelection.clone.dialog.destinationPath"),
        theme::inline_row(dest_field, browse_btn),
    );

    let cleanup = dialog_theme::cleanup_checkbox(
        CLEANUP_CHECKBOX,
        t("folderSelection.clone.dialog.cleanupDestination"),
        dialog.cleanup,
        busy,
        {
            let scope = scope.clone();
            move |s: &mut State| {
                if s.current_scope(&scope)
                    && let Some(l) = s.screen.launcher_mut()
                    && !l.clone_dialog.is_busy()
                {
                    l.clone_dialog.cleanup = !l.clone_dialog.cleanup;
                }
            }
        },
    );

    let error = dialog.error.as_deref().map(theme::error_text);

    let cancel = dialog_theme::secondary_button(
        CANCEL_BUTTON,
        t("folderSelection.clone.dialog.cancel"),
        busy,
        {
            let scope = scope.clone();
            move |s: &mut State, tx| {
                if s.current_scope(&scope) {
                    close(s, tx);
                }
            }
        },
    );

    let submit_label = if busy {
        t("folderSelection.clone.dialog.cloning")
    } else {
        t("folderSelection.clone.dialog.clone")
    };
    let submit_btn = dialog_theme::primary_button(SUBMIT_BUTTON, submit_label, busy, {
        let scope = scope.clone();
        move |s: &mut State, tx| {
            if s.current_scope(&scope) {
                with_locale(render_locale, || submit(s, tx));
            }
        }
    });

    let browser_open = directory_browser::is_open(s);
    let key_scope = scope.clone();
    let close_scope = scope;
    dialog_theme::modal(
        DIALOG_KEY,
        t("folderSelection.clone.dialog.title"),
        t("directoryBrowser.close"),
        busy || browser_open,
        repo_section,
        dest_section,
        cleanup,
        error,
        cancel,
        submit_btn,
        move |s: &mut State, event, tx| {
            s.current_scope(&key_scope) && with_locale(render_locale, || handle_key(s, event, tx))
        },
        move |s: &mut State| {
            if s.current_scope(&close_scope)
                && !directory_browser::is_open(s)
                && let Some(l) = s.screen.launcher_mut()
            {
                l.clone_dialog.dismiss_from_dialog();
                (l.wake)();
            }
        },
        layer,
    );
}
