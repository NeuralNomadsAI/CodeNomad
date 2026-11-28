use crate::{
    State,
    components::button_tx,
    launcher::{self, recent},
    screen, settings,
    shell::{self, tab_rename, temporary},
    strings::t,
    workspace,
};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    Space, action_menu, field_kit, git_panel, launcher as theme,
    layout::{self, Layout, literal_field},
    shell::icons,
};
use std::rc::Rc;

#[cfg(test)]
mod tests;

const GITHUB_URL: &str = "https://github.com/NeuralNomadsAI/CodeNomad";
const DISCORD_URL: &str =
    "https://discord.com/channels/1391832426048651334/1458412028325793887/1464701235683917945";

fn build_recent_menu(s: &State, entry: &recent::RecentEntry, disabled: bool) -> (El, Option<El>) {
    let Some(l) = s.screen.launcher() else {
        return (rune::el(), None);
    };
    let scope = s.input_scope.clone();
    let key = recent::path_menu_key(&entry.path);
    let label = format!(
        "{} · {}",
        t("folderSelection.recent.actions"),
        entry.display_name
    );
    let trigger_key = format!("{key}:trigger");

    let rename_path = entry.path.clone();
    let rename_tab_key = entry.open_tab_key.clone();
    let rename_seed = entry.display_name.clone();
    let rename_return = trigger_key.clone();
    let mut rename_item = action_menu::Item::new(
        "rename",
        t("folderSelection.recent.rename"),
        screen::action_tx(&scope, move |s: &mut State, tx: &mut Tx| {
            if let Some(tab_key) = rename_tab_key.as_deref()
                && workspace::tab_rename_seed(s, tab_key).is_some()
            {
                tab_rename::open_for_tab_with_return_focus(
                    s,
                    tab_key,
                    Some(rename_return.clone()),
                    tx,
                );
            } else {
                tab_rename::open_for_folder(
                    s,
                    &rename_path,
                    &rename_seed,
                    Some(rename_return.clone()),
                    tx,
                );
            }
        }),
    );
    rename_item.icon = Some(Rc::new(|| theme::menu_icon(&icons::PENCIL)));
    rename_item.disabled = disabled;

    let remove_path = entry.path.clone();
    let mut remove_item = action_menu::Item::new(
        "remove",
        t("folderSelection.recent.remove"),
        screen::action_tx(&scope, move |s: &mut State, tx: &mut Tx| {
            launcher::remove_recent(s, &remove_path, tx);
        }),
    );
    remove_item.icon = Some(Rc::new(|| theme::menu_icon(&theme::TRASH)));
    remove_item.disabled = disabled;

    let mut menu = action_menu::Menu::new(
        &key,
        &label,
        vec![Rc::new(rename_item), Rc::new(remove_item)],
    );
    let open_key = key.clone();
    let open_scope = scope;
    menu.on_open_change = Some(Rc::new(move |s: &mut State, open, _| {
        if s.current_scope(&open_scope)
            && let Some(l) = s.screen.launcher_mut()
        {
            if open {
                l.open_recent_menu = Some(open_key.clone());
            } else if l.open_recent_menu.as_deref() == Some(open_key.as_str()) {
                l.open_recent_menu = None;
            }
        }
    }));
    action_menu::view(
        &l.recent_menu,
        launcher::recent_menu_state,
        Rc::new(menu),
        git_panel::overflow_trigger(&label),
        theme::menu_viewport_width(s.shell.width()),
    )
}

fn connect_form(s: &State, l: &launcher::Launcher, busy: bool) -> El {
    let scope = s.input_scope.clone();
    #[cfg(target_arch = "wasm32")]
    let password = !crate::platform::pairing::available();
    #[cfg(not(target_arch = "wasm32"))]
    let password = true;

    let mut form = col()
        .full_width()
        .separate(Space::Sm)
        .child(text(t("rune.server")))
        .child(
            literal_field(&l.address)
                .disabled(l.authentication_required)
                .label(t("rune.server"))
                .input_mode(rune::InputMode::Url)
                .on_edit(screen::edit(&scope, screen::Editor::Address))
                .build(&field_kit(layout::dark()))
                .key("server-address"),
        );
    if password {
        form = form.child(text(t("authRecovery.password"))).child(
            literal_field(&l.password)
                .label(t("authRecovery.password"))
                .secure()
                .autofill(rune::Autofill::CurrentPassword)
                .on_edit(screen::edit(&scope, screen::Editor::Password))
                .on_submit(screen::action_tx(&scope, launcher::connect))
                .build(&field_kit(layout::dark()))
                .key("server-password"),
        );
    }
    let actions = layout::action_row().separate(Space::Sm).child(button_tx(
        "connect",
        t("folderSelection.servers.dialog.connect"),
        busy,
        screen::action_tx(&scope, launcher::connect),
    ));
    form = form.child(actions);
    theme::section_padding(form)
}

fn hero_section(s: &State) -> El {
    let scope = s.input_scope.clone();
    let links = vec![
        theme::link_button(
            "launcher-link-sponsor",
            &theme::HEART,
            Some(t("newTab.sponsor")),
            t("newTab.sponsor"),
            screen::action_tx(&scope, shell::open_sponsor_page),
        ),
        theme::link_button(
            "launcher-link-github",
            &theme::GITHUB,
            None,
            t("folderSelection.links.github"),
            screen::action_tx(&scope, |_, tx| {
                let _ = tx.open_url_then(GITHUB_URL, |_: &mut State, _, _| {});
            }),
        ),
        theme::link_button(
            "launcher-link-stars",
            &theme::STAR,
            None,
            t("folderSelection.links.githubStars"),
            screen::action_tx(&scope, |_, tx| {
                let _ = tx.open_url_then(GITHUB_URL, |_: &mut State, _, _| {});
            }),
        ),
        theme::link_button(
            "launcher-link-discord",
            &theme::DISCORD,
            None,
            t("folderSelection.links.discord"),
            screen::action_tx(&scope, |_, tx| {
                let _ = tx.open_url_then(DISCORD_URL, |_: &mut State, _, _| {});
            }),
        ),
    ];
    theme::hero(t("folderSelection.logoAlt"), t("window.title.main"), links)
}

pub fn view(s: &State) -> El {
    let Some(l) = s.screen.launcher() else {
        return rune::el();
    };
    #[cfg(target_arch = "wasm32")]
    if l.connection.is_none() && crate::platform::pairing::required(s) {
        return rune::el();
    }
    let scope = s.input_scope.clone();
    let waiting = !workspace::input_ready(s);
    let busy = l.pending || l.managed_renewal.is_some();
    let stacked = theme::is_stacked(s.shell.width());
    let hero = hero_section(s);

    let status = if busy || l.error.is_some() {
        let mut block = col().full_width().separate(Space::Xs);
        if busy {
            block = block.child(theme::status_text(t("rune.loading")));
        }
        if let Some(error) = l.error {
            block = block.child(theme::error_text(t(error)));
        }
        Some(block)
    } else {
        None
    };

    let version_footer = l
        .version_meta
        .as_ref()
        .and_then(recent::format_version_pill)
        .map(|label| theme::version_pill(&label));

    if l.connection.is_none() || l.authentication_required {
        let card = theme::card(
            "launcher-connect-card",
            t("folderSelection.servers.dialog.title"),
            t("folderSelection.servers.dialog.title"),
            None,
            None,
            connect_form(s, l, busy),
            None,
            false,
        );
        return theme::shell(
            stacked,
            None,
            hero,
            theme::single_column(card),
            status,
            version_footer,
        );
    }

    let top_actions = if temporary::host_supports_temporary(s) {
        let temp = theme::top_action_button(
            "new-temporary-tab",
            &icons::HOURGLASS,
            t("newTab.temporary"),
            settings::with_shortcut_label(
                s,
                t("folderSelection.temporary.description"),
                "new-temporary-instance",
            ),
            !temporary::can_create(s),
            screen::action_tx(&scope, |s, tx| {
                temporary::create(s, tx);
            }),
        );
        Some(theme::top_actions(Some(temp), None))
    } else {
        None
    };

    // Left card: Browse (This computer + direct folder input).
    let browse_count = recent::format_item_count(1);
    let browse_help = crate::platform::folder_picker_available().then(|| {
        settings::with_shortcut_label(
            s,
            t("folderSelection.browseMenu.thisComputer"),
            "browse-folder",
        )
    });
    let folder_input = theme::hinted_literal_field(&l.folder, t("instanceInfo.labels.folder"))
        .disabled(waiting)
        .label(t("instanceInfo.labels.folder"))
        .on_edit(screen::edit(&scope, screen::Editor::Folder))
        .on_submit(screen::action_tx(&scope, launcher::open))
        .build(&field_kit(layout::dark()))
        .key("folder-path");
    let open_btn = button_tx(
        "open-folder",
        t("directoryBrowser.openCurrent"),
        l.pending || waiting || l.folder.text.trim().is_empty(),
        screen::action_tx(&scope, launcher::open),
    );
    let folder_rows = launcher::folders::rows(l, &scope, l.pending || waiting);
    let mut direct_block = col()
        .full_width()
        .separate(Space::Sm)
        .child(theme::inline_row(folder_input, open_btn));
    if !folder_rows.is_empty() {
        direct_block = direct_block.children(folder_rows);
    }
    let browse_body = col()
        .full_width()
        .child(theme::browse_row(
            "browse",
            &theme::LAPTOP,
            t("folderSelection.browseMenu.thisComputer"),
            None,
            browse_help,
            l.pending || waiting,
            screen::action_tx(&scope, launcher::browse),
        ))
        .child(theme::section_padding(direct_block));

    let browse_card = theme::card(
        "launcher-browse-card",
        t("folderSelection.browseMenu.title"),
        t("folderSelection.browseMenu.title"),
        Some(browse_count),
        None,
        browse_body,
        None,
        !stacked,
    );

    // Right card: Recent tabs.
    let recents = recent::collect_recent_entries(s);
    let recent_count = recent::format_item_count(recents.len());
    let now_ms = recent::now_epoch_ms();
    let local_source_prefix = format!("{} ·", t("folderSelection.browseMenu.thisComputer"));
    let retry = l.projects_stale.then(|| {
        theme::subtle_button(
            "refresh-projects",
            t("sessionList.loadError.retry"),
            l.pending || l.projects_refresh.is_some() || waiting,
            screen::action_tx(&scope, |s: &mut State, _| {
                launcher::refresh_projects(s);
            }),
        )
    });
    let recent_header_right = Some(theme::recent_header_right(
        retry,
        t("folderSelection.browseMenu.thisComputer"),
    ));

    let recent_body = if recents.is_empty() {
        theme::empty_state(t("newInstanceLauncher.empty"))
    } else {
        let mut list = col().full_width().role("list");
        for entry in &recents {
            let primary_key = match &entry.project_id {
                Some(id) => format!("project-{id}"),
                None => recent::recent_row_key(&entry.path),
            };
            let glyph = if entry.temporary {
                &icons::HOURGLASS
            } else {
                &theme::FOLDER
            };
            let rel = entry
                .last_accessed
                .map(|ts| recent::format_relative_time(ts, now_ms));
            let a11y_label = format!("{} · {}", entry.display_name, entry.display_path);
            let open_badge = entry.open_tab_key.as_ref().map(|tab_key| {
                let target = tab_key.clone();
                let badge_a11y = format!(
                    "{} · {}",
                    t("folderSelection.recent.switchToOpenProject"),
                    entry.display_name
                );
                theme::open_badge_button(
                    &recent::open_badge_key(&entry.path),
                    t("folderSelection.recent.openBadge"),
                    &badge_a11y,
                    t("folderSelection.recent.switchToOpenProject"),
                    l.pending || waiting,
                    screen::action_tx(&scope, move |s: &mut State, tx: &mut Tx| {
                        workspace::select(s, &target, tx);
                    }),
                )
            });
            let (trigger, _popover) = build_recent_menu(s, entry, l.pending || waiting);
            let open_path = entry.path.clone();
            let open_tab = entry.open_tab_key.clone();
            list = list.child(theme::recent_row(
                &primary_key,
                glyph,
                &entry.display_name,
                Some(&local_source_prefix),
                &entry.display_path,
                rel.as_deref(),
                open_badge,
                trigger,
                &a11y_label,
                l.pending || waiting,
                screen::action_tx(&scope, move |s: &mut State, tx: &mut Tx| {
                    if let Some(tab_key) = open_tab.as_deref()
                        && workspace::open_tab_for_folder(s, &open_path).as_deref() == Some(tab_key)
                    {
                        workspace::select(s, tab_key, tx);
                    } else {
                        launcher::choose_project(s, &open_path, tx);
                    }
                }),
            ));
        }
        list
    };

    let recent_card = theme::card(
        "launcher-recent-card",
        t("newInstanceLauncher.recentTitle"),
        t("newInstanceLauncher.recentTitle"),
        Some(recent_count),
        recent_header_right,
        recent_body,
        None,
        true,
    );

    theme::shell(
        stacked,
        top_actions,
        hero,
        theme::columns(stacked, browse_card, recent_card),
        status,
        version_footer,
    )
}

pub fn overlays(s: &State, layer: &mut Vec<El>) {
    let Some(l) = s.screen.launcher() else {
        return;
    };
    if l.connection.is_none() || l.authentication_required || l.open_recent_menu.is_none() {
        return;
    }
    let waiting = !workspace::input_ready(s);
    let recents = recent::collect_recent_entries(s);
    for entry in &recents {
        let key = recent::path_menu_key(&entry.path);
        if l.open_recent_menu.as_deref() == Some(key.as_str()) {
            let (_trigger, popover) = build_recent_menu(s, entry, l.pending || waiting);
            layer.extend(popover);
            break;
        }
    }
}
