use crate::{
    State,
    files::{Ui, ui::Row},
    platform::{
        self,
        workspace_open::{self, DefaultMode, Target},
    },
    screen,
    strings::{locale, t},
};
use rune::{El, Tx};
use rune_theme_codenomad::{
    action_menu::{self, Item, Menu},
    catalogue, file_row_actions as controls, workspace_tree,
};
use std::{collections::HashMap, rc::Rc, sync::Arc};

use crate::shell::notifications::{Category, emit_outcome};
type Notice = (Category, bool, String);

pub(in crate::files) struct Actions {
    rows: HashMap<String, controls::State>,
    menu: action_menu::State<State>,
    open: Option<String>,
    focus: Option<String>,
    owner: Arc<()>,
    incoming: codenomad_client::Receiver<Notice>,
    out: codenomad_client::Sender<Notice>,
    pub(super) notice: Option<(bool, String)>,
}

impl Default for Actions {
    fn default() -> Self {
        let (out, incoming) = codenomad_client::bounded(8);
        Self {
            rows: HashMap::new(),
            menu: Default::default(),
            open: None,
            focus: None,
            owner: Arc::new(()),
            incoming,
            out,
            notice: None,
        }
    }
}

impl Actions {
    pub(in crate::files) fn is_menu_open(&self) -> bool {
        self.open.is_some()
    }
    pub(in crate::files) fn revoke(&mut self) {
        *self = Self::default();
    }
    pub(in crate::files) fn retain_rows(&mut self, rows: &[Row]) {
        let visible: std::collections::HashSet<_> =
            rows.iter().map(|row| row.entry.path.as_str()).collect();
        self.rows.retain(|key, _| {
            key.strip_prefix("workspace-actions:")
                .is_some_and(|path| visible.contains(path))
        });
    }
}

fn menu_at(s: &mut State) -> Option<&mut action_menu::State<State>> {
    Some(&mut s.files.as_mut()?.actions.menu)
}

fn row_at<'a>(s: &'a mut State, key: &str) -> Option<&'a mut controls::State> {
    s.files.as_mut()?.actions.rows.get_mut(key)
}

fn key(path: &str) -> String {
    format!("workspace-actions:{path}")
}

pub(in crate::files) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(ui) = s.files.as_mut() else {
        return false;
    };
    let visible = ui.tree_visible();
    let gone = ui
        .actions
        .open
        .as_ref()
        .filter(|key| {
            !visible
                || !ui.rows.iter().any(|row| {
                    key.strip_prefix("workspace-actions:") == Some(row.entry.path.as_str())
                })
        })
        .cloned();
    let mut changed = false;
    let focused = visible
        .then(|| tx.focused().map(str::to_owned))
        .flatten()
        .filter(|key| key.starts_with("workspace-actions:") || key.starts_with("file-row-"));
    if ui.actions.focus != focused {
        ui.actions.focus = focused;
        changed = true;
    }
    if let Some(gone) = gone {
        action_menu::clear(s, menu_at, &gone, tx);
        if let Some(ui) = &mut s.files {
            ui.actions.open = None;
        }
        changed = true;
    }
    changed | action_menu::poll(s, menu_at, tx)
}

pub(in crate::files) fn poll_notices(s: &mut State) -> bool {
    let Some(ui) = s.files.as_mut() else {
        return false;
    };
    let mut notices = Vec::new();
    while let Ok((category, success, message)) = ui.actions.incoming.try_recv() {
        ui.actions.notice = Some((success, message.clone()));
        notices.push((category, success, message));
    }
    let changed = !notices.is_empty();
    for (category, success, message) in notices {
        emit_outcome(s, category, None, message, !success);
    }
    changed
}

fn item(
    key: &str,
    label: &str,
    glyph: workspace_tree::ActionGlyph,
    on_select: impl Fn(&mut State, &mut Tx) + 'static,
) -> Item<State> {
    let mut item = Item::new(key, label, on_select);
    item.icon = Some(Rc::new(move || workspace_tree::action_glyph(glyph)));
    item.select_before_close = true; // Clipboard writes must stay in the browser gesture.
    item
}

pub(super) fn row(s: &State, ui: &Ui, row: &Row, width: f32, touch: bool) -> (El, Option<El>) {
    use controls::icons::{COPY, EXTERNAL_LINK, EYE, TERMINAL_SQUARE};
    use workspace_tree::icons::FOLDER_OPEN;
    let path = &row.entry.path;
    let directory = ui.tree.directory();
    let row_key = key(path);
    let folder = row.expanded.is_some();
    let ready = ui.actions_ready();
    let scope = &s.input_scope;
    let mut items = Vec::new();
    if !folder {
        let run = screen::action_tx(scope, {
            let (directory, path) = (directory.to_owned(), path.clone());
            move |s, tx| {
                if !has_session(s) {
                    return;
                }
                let opened = s
                    .files
                    .as_mut()
                    .filter(|ui| owns(ui, &directory, &path))
                    .and_then(|ui| ui.toggle_preview(&directory, &path));
                if opened.is_some() {
                    s.notifications.supersede_navigation();
                }
                match opened {
                    Some(true) => {
                        #[cfg(target_arch = "wasm32")]
                        super::refresh_browser_file_wrap(s);
                        crate::git::close_preview(s);
                        crate::workspace::close_mission_reader(s);
                    }
                    Some(false) => crate::chat::reading::restore_position(s, tx),
                    None => {}
                }
            }
        });
        let mut preview = item(
            "preview",
            &format!("{} · {path}", t("filesPanel.viewer")),
            &EYE,
            run,
        );
        preview.disabled = !ready || !has_session(s);
        preview.checked = Some(ui.previews(path));
        items.push(Rc::new(preview));
    }
    if ready
        && ui.local
        && workspace_open::AVAILABLE
        && let Some(slug) = crate::git::files_checkout(s, directory)
    {
        let default_label = if folder {
            "openFolder"
        } else {
            match workspace_open::windows_default_mode(path) {
                DefaultMode::Open => "openDefault",
                DefaultMode::Edit => "editDefault",
                DefaultMode::Choose => "chooseApplication",
            }
        };
        let specs = if folder {
            [
                ("open-folder", default_label, &FOLDER_OPEN, Target::Default),
                (
                    "open-terminal",
                    "openTerminal",
                    &TERMINAL_SQUARE,
                    Target::Terminal,
                ),
            ]
        } else {
            [
                (
                    "open-default",
                    default_label,
                    &EXTERNAL_LINK,
                    Target::Default,
                ),
                (
                    "show-in-folder",
                    "showInFolder",
                    &FOLDER_OPEN,
                    Target::Reveal,
                ),
            ]
        };
        for (key, label, glyph, target) in specs {
            let (directory, path, slug) = (directory.to_owned(), path.clone(), slug.clone());
            items.push(Rc::new(item(
                key,
                t(&format!("instanceShell.filesShell.actions.{label}")),
                glyph,
                screen::action_tx(scope, move |s, _| {
                    launch(s, &directory, &path, &slug, target)
                }),
            )));
        }
    }
    let (copy_directory, copy_path) = (directory.to_owned(), path.clone());
    items.push(Rc::new(item(
        "copy-path",
        t("instanceShell.filesShell.actions.copyPath"),
        &COPY,
        screen::action_tx(scope, move |s, tx| {
            if let Some(ui) = s
                .files
                .as_mut()
                .filter(|ui| ui.tree_visible() && ui.tree.directory() == copy_directory)
            {
                platform::workspace_open::copy_path(
                    &copy_path,
                    ui.actions.out.clone(),
                    ui.wake.clone(),
                    tx,
                );
            }
        }),
    )));
    let mut menu = Menu::new(
        &row_key,
        &catalogue::format(
            locale(),
            "instanceShell.filesShell.actions.more",
            &[("name", &row.entry.name)],
        ),
        items,
    );
    let open_key = row_key.clone();
    menu.on_open_change = Some(Rc::new(move |s: &mut State, open, _| {
        if let Some(ui) = &mut s.files {
            ui.actions.open = open.then(|| open_key.clone());
        }
    }));
    let actions = Rc::new(controls::Actions::new(menu));
    let required = workspace_tree::action_budget(
        &row.entry.name,
        row.depth,
        row.busy,
        controls::natural_width(&actions),
    );
    let empty = controls::State::default();
    let focus_within = ui.actions.focus.as_ref().is_some_and(|focus| {
        *focus == format!("file-row-{path}") || focus.starts_with(&format!("{row_key}:"))
    });
    let reveal_at_rest = touch
        || cfg!(any(target_os = "android", target_os = "ios"))
        || s.shell.has_floating()
        || (s.shell.width() > 0.0 && s.shell.width() < 768.0);
    let (buttons, popup) = controls::view(
        ui.actions.rows.get(&row_key).unwrap_or(&empty),
        row_at,
        &ui.actions.menu,
        menu_at,
        actions.clone(),
        controls::Visibility {
            coarse_pointer: reveal_at_rest,
            focus_within,
        },
        width,
    );
    let directory = directory.to_owned();
    let scope = scope.clone();
    (
        buttons.on_layout_tx(move |s: &mut State, _, tx| {
            if s.current_scope(&scope)
                && let Some(ui) = s
                    .files
                    .as_mut()
                    .filter(|ui| ui.tree.directory() == directory)
            {
                let open = ui.actions.menu.is_open(&row_key);
                let state = ui.actions.rows.entry(row_key.clone()).or_default();
                if !controls::sync(
                    state,
                    &actions,
                    open,
                    controls::Budget {
                        available: width,
                        required,
                    },
                    tx,
                ) {
                    tx.live_only();
                }
            }
        }),
        popup,
    )
}

fn owns(ui: &Ui, directory: &str, path: &str) -> bool {
    ui.actions_ready()
        && ui.tree.directory() == directory
        && ui.rows.iter().any(|row| row.entry.path == path)
}

pub(super) fn has_session(s: &State) -> bool {
    !s.screen.is_launcher()
        && crate::workspace::active_session(s).is_some_and(|id| !matches!(id, "" | "info"))
        && !s
            .git
            .owner
            .as_ref()
            .is_some_and(|owner| owner.session_checkout_removed())
}

fn launch(s: &mut State, directory: &str, path: &str, slug: &str, target: Target) {
    if !workspace_open::AVAILABLE
        || crate::git::files_checkout(s, directory).as_deref() != Some(slug)
    {
        return;
    }
    let Some(ui) = s
        .files
        .as_mut()
        .filter(|ui| ui.local && owns(ui, directory, path))
    else {
        return;
    };
    let (backend, owner, out, wake) = (
        ui.backend.clone(),
        Arc::downgrade(&ui.actions.owner),
        ui.actions.out.clone(),
        ui.wake.clone(),
    );
    let (slug, directory, path, language) = (
        slug.to_owned(),
        directory.to_owned(),
        path.to_owned(),
        locale().to_owned(),
    );
    platform::spawn(async move {
        if let Err(error) =
            workspace_open::open(backend, slug, directory, path, target, owner).await
        {
            let detail = error.localized(&language);
            let message = catalogue::format(
                &language,
                "instanceShell.filesShell.toast.openError",
                &[("message", &detail)],
            );
            if out.try_send((Category::Files, false, message)).is_ok() {
                wake();
            }
        }
    });
}
