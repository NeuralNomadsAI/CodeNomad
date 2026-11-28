use super::{Picker, WebSearch};
use crate::{settings::providers::attach_picker_keys, strings::t};
use codenomad_client::settings::websearch::{
    self, Scope, SearchConnection, SearchIntegration, Selection,
};
use rune::{El, Key, TextEdit, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

pub(in crate::settings::providers) fn view<S: 'static>(
    state_rc: &Rc<RefCell<WebSearch>>,
    available: bool,
    external_key: Option<&TextEdit>,
    edit_key: Option<fn(&mut S) -> &mut TextEdit>,
) -> El {
    let state = state_rc.borrow();
    let expanded = state.expanded;
    let busy = state.busy();
    let locked = state.mutations_disabled();
    let connections_writable = state
        .snapshot
        .as_ref()
        .is_some_and(|s| s.defaults.is_some());
    let mut body = col().full_width().separate(Space::Sm);

    if expanded {
        if !available {
            body = body.child(text(t("settings.providers.empty.noInstance")).role("status"));
        } else {
            if state.error {
                body = body.child(text(t("settings.websearch.error")).wrap().role("alert"));
            }
            if state.snapshot.is_none() && busy {
                body = body.child(text(t("settings.providers.loading")).role("status"));
            }

            body = body.child(connections_bar(
                &state,
                state_rc,
                busy,
                locked,
                connections_writable,
                edit_key,
            ));

            if let (Some(active), Some(key_ref), Some(edit)) =
                (state.active_integration(), external_key, edit_key)
                && connections_writable
            {
                body = body.child(connect_panel(active, state_rc, locked, key_ref, edit));
            }

            body = body.child(configured_list::<S>(
                &state,
                state_rc,
                locked || !connections_writable,
            ));

            if let Some(defaults) = state.snapshot.as_ref().and_then(|s| s.defaults.as_ref()) {
                body = body.child(defaults_section::<S>(&state, defaults, state_rc, locked));
            }
        }
    }
    drop(state);

    let toggle_rc = state_rc.clone();
    chrome::card(chrome::disclosure(
        t("settings.websearch.title"),
        expanded,
        body,
        move |_: &mut S| toggle_rc.borrow_mut().toggle(),
    ))
}

fn connections_bar<S: 'static>(
    state: &WebSearch,
    state_rc: &Rc<RefCell<WebSearch>>,
    busy: bool,
    locked: bool,
    connections_writable: bool,
    edit_key: Option<fn(&mut S) -> &mut TextEdit>,
) -> El {
    let selected = state.selected_integration();
    let trigger_label = selected
        .map(|item| format!("{} ({})", item.name, item.id))
        .unwrap_or_else(|| t("settings.providers.selectProvider").to_owned());
    let picker_open = state.open_picker == Some(Picker::Provider);
    let can_connect = edit_key.is_some()
        && connections_writable
        && selected.is_some_and(|item| item.supports_key);
    let has_options = state
        .snapshot
        .as_ref()
        .is_some_and(|s| !s.integrations.is_empty());
    let first_focus = selected.map(|item| format!("websearch-provider-opt-{}", item.id));

    let picker_rc = state_rc.clone();
    let connect_rc = state_rc.clone();
    let refresh_rc = state_rc.clone();

    let mut group = col().full_width().separate(Space::Xs).child(
        layout::action_row()
            .child(
                layout::button_tx(
                    &trigger_label,
                    locked || !has_options,
                    move |_: &mut S, tx| {
                        let mut ws = picker_rc.borrow_mut();
                        if ws.open_picker == Some(Picker::Provider) {
                            ws.open_picker = None;
                        } else {
                            ws.open_picker = Some(Picker::Provider);
                            if let Some(key) = &first_focus {
                                tx.focus(key.clone(), true);
                            }
                        }
                    },
                )
                .label(format!(
                    "{}: {trigger_label}",
                    t("toolCall.websearch.provider")
                ))
                .expanded(picker_open)
                .key("websearch-provider-picker"),
            )
            .child(
                chrome::primary_action(
                    t("settings.providers.actions.connect"),
                    locked || !can_connect,
                    move |s: &mut S| {
                        let Some(edit) = edit_key else {
                            return;
                        };
                        let mut ws = connect_rc.borrow_mut();
                        if let Some(id) = ws.selected_integration().map(|i| i.id.clone()) {
                            ws.active_id = id;
                            ws.open_picker = None;
                            *edit(s) = TextEdit::new("");
                        }
                    },
                )
                .key("websearch-connect-open"),
            )
            .child(
                layout::button(t("settings.providers.refresh"), busy, move |_: &mut S| {
                    refresh_rc.borrow_mut().request_refresh();
                })
                .key("websearch-refresh"),
            ),
    );

    if picker_open
        && !locked
        && let Some(snapshot) = &state.snapshot
    {
        let mut option_keys = Vec::with_capacity(snapshot.integrations.len());
        let mut list = col()
            .full_width()
            .separate(Space::Xs)
            .role("listbox")
            .label(t("toolCall.websearch.provider"));
        for item in &snapshot.integrations {
            let item_id = item.id.clone();
            let chosen = selected.is_some_and(|s| s.id == item.id);
            let opt_key = format!("websearch-provider-opt-{}", item.id);
            option_keys.push(opt_key.clone());
            let pick_rc = state_rc.clone();
            list = list.child(
                layout::button_tx(
                    &format!("{} · {}", item.name, item.id),
                    false,
                    move |_: &mut S, tx| {
                        let mut ws = pick_rc.borrow_mut();
                        ws.selected_id = item_id.clone();
                        ws.open_picker = None;
                        tx.focus("websearch-provider-picker", true);
                    },
                )
                .role("option")
                .checked(chosen)
                .focus_selected(chosen)
                .key(opt_key),
            );
        }
        let close_rc = state_rc.clone();
        group = group.child(attach_picker_keys(
            list,
            "websearch-provider-picker".into(),
            option_keys,
            move |_: &mut S| close_rc.borrow_mut().open_picker = None,
        ));
        let esc_rc = state_rc.clone();
        group = group.on_key(move |_: &mut S, event, tx| {
            if event.key == Key::Escape && event.mods == rune::Mods::default() {
                esc_rc.borrow_mut().open_picker = None;
                tx.focus("websearch-provider-picker", true);
                return true;
            }
            false
        });
    }
    group
}

fn connect_panel<S: 'static>(
    active: &SearchIntegration,
    state_rc: &Rc<RefCell<WebSearch>>,
    locked: bool,
    key_ref: &TextEdit,
    edit_key: fn(&mut S) -> &mut TextEdit,
) -> El {
    let key_ready = !key_ref.text.trim().is_empty();
    let title = t("settings.providers.auth.title").replace("{provider}", &active.name);
    let close_rc = state_rc.clone();
    let submit_rc = state_rc.clone();
    let submit_id = active.id.clone();
    let enter_rc = state_rc.clone();
    let enter_id = active.id.clone();

    let input = layout::hinted_field(key_ref, t("settings.providers.apiKey.placeholder"))
        .label(t("settings.providers.apiKey.label"))
        .secure()
        .disabled(locked)
        .on_edit(edit_key)
        .on_submit(move |s: &mut S, _| {
            let value = edit_key(s).text.clone();
            enter_rc.borrow_mut().connect(enter_id.clone(), value);
        });

    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .child(
                layout::action_row()
                    .child(text(&title).text_role(TextRole::Title).role("heading"))
                    .child(
                        layout::button(
                            t("settings.providers.actions.close"),
                            locked,
                            move |s: &mut S| {
                                close_rc.borrow_mut().active_id.clear();
                                *edit_key(s) = TextEdit::new("");
                            },
                        )
                        .key("websearch-connect-close"),
                    ),
            )
            .child(text(t("settings.providers.apiKey.label")))
            .child(
                input
                    .build(&field_kit(layout::dark()))
                    .literal_direction()
                    .key("websearch-api-key"),
            )
            .child(
                chrome::primary_action(
                    t("settings.providers.actions.connect"),
                    locked || !key_ready,
                    move |s: &mut S| {
                        let value = edit_key(s).text.clone();
                        submit_rc.borrow_mut().connect(submit_id.clone(), value);
                    },
                )
                .key("websearch-connect-submit"),
            ),
    )
}

fn configured_list<S: 'static>(
    state: &WebSearch,
    state_rc: &Rc<RefCell<WebSearch>>,
    disconnect_disabled: bool,
) -> El {
    let mut list = col().full_width().separate(Space::Xs);
    let Some(snapshot) = &state.snapshot else {
        return list;
    };
    let configured: Vec<&SearchIntegration> = snapshot
        .integrations
        .iter()
        .filter(|item| !item.connections.is_empty())
        .collect();

    if snapshot.catalog_available && configured.is_empty() {
        return list
            .child(text(t("settings.providers.empty.noConfiguredProviders")).role("status"));
    }

    let disconnect_label = t("settings.providers.actions.disconnect");
    let remove_label = t("settings.providers.actions.remove");
    for item in configured {
        let sources: Vec<String> = item
            .connections
            .iter()
            .map(|conn| match conn {
                SearchConnection::Env { name } => {
                    t("settings.websearch.environment").replace("{name}", name)
                }
                SearchConnection::Credential { label, .. } => label.clone(),
            })
            .collect();
        let summary = format!("{} • {}", item.id, sources.join(" • "));
        let mut actions = layout::action_row();
        let mut has_credentials = false;
        for conn in &item.connections {
            if let SearchConnection::Credential { id, label } = conn {
                has_credentials = true;
                let cred_id = id.clone();
                let rem_rc = state_rc.clone();
                actions = actions.child(
                    layout::button(disconnect_label, disconnect_disabled, move |_: &mut S| {
                        rem_rc.borrow_mut().remove(cred_id.clone());
                    })
                    .label(format!("{remove_label}: {} — {label}", item.name))
                    .key(format!("websearch-disconnect-{id}")),
                );
            }
        }
        let mut card = col()
            .full_width()
            .separate(Space::Xs)
            .child(
                text(&item.name)
                    .text_role(TextRole::Title)
                    .role("heading")
                    .wrap_anywhere(),
            )
            .child(text(&summary).wrap());
        if has_credentials {
            card = card.child(actions);
        }
        list = list.child(chrome::card(card).key(format!("websearch-configured-{}", item.id)));
    }
    list
}

fn scope_options(
    entry: &websearch::ScopeEntry,
    providers: &[websearch::SearchProvider],
) -> Vec<(Selection, String, String)> {
    let mut options = vec![
        (
            Selection::Default,
            t("settings.websearch.default").to_owned(),
            "default".to_owned(),
        ),
        (
            Selection::Off,
            t("settings.websearch.off").to_owned(),
            "off".to_owned(),
        ),
        (
            Selection::Provider("random".into()),
            t("settings.websearch.random").to_owned(),
            "random".to_owned(),
        ),
    ];
    for provider in providers {
        options.push((
            Selection::Provider(provider.id.clone()),
            provider.name.clone(),
            format!("provider-{}", provider.id),
        ));
    }
    if let Selection::Provider(saved) = &entry.selection
        && saved != "random"
        && !providers.iter().any(|p| p.id == *saved)
    {
        options.push((
            Selection::Provider(saved.clone()),
            saved.clone(),
            format!("provider-{saved}"),
        ));
    }
    options
}

fn defaults_section<S: 'static>(
    state: &WebSearch,
    defaults: &websearch::DefaultsSnapshot,
    state_rc: &Rc<RefCell<WebSearch>>,
    locked: bool,
) -> El {
    let mut section = col().full_width().separate(Space::Sm);
    let providers = state
        .snapshot
        .as_ref()
        .map(|s| s.providers.as_slice())
        .unwrap_or(&[]);

    for entry in &defaults.scopes {
        let scope = entry.scope;
        let current_label = state.selection_label(&entry.selection);
        let picker_open = state.open_picker == Some(Picker::Scope(scope));
        let trigger_key = format!("websearch-scope-{}", scope.as_str());
        let options = scope_options(entry, providers);
        let first_focus = options
            .iter()
            .find(|(choice, _, _)| *choice == entry.selection)
            .or_else(|| options.first())
            .map(|(_, _, suffix)| format!("websearch-scope-{}-{suffix}", scope.as_str()));

        let info = (scope == Scope::Global).then(|| {
            let info_rc = state_rc.clone();
            chrome::info_tip(
                t("settings.websearch.global"),
                t("settings.websearch.defaultHint"),
                state.global_info_open,
                move |_: &mut S| {
                    let mut ws = info_rc.borrow_mut();
                    ws.global_info_open = !ws.global_info_open;
                },
            )
            .key("websearch-global-info")
        });

        let trigger_rc = state_rc.clone();
        let mut trigger = layout::button_tx(&current_label, locked, move |_: &mut S, tx| {
            let mut ws = trigger_rc.borrow_mut();
            if ws.open_picker == Some(Picker::Scope(scope)) {
                ws.open_picker = None;
            } else {
                ws.open_picker = Some(Picker::Scope(scope));
                if let Some(key) = &first_focus {
                    tx.focus(key.clone(), true);
                }
            }
        })
        .label(format!("{}: {current_label}", t(scope.i18n_key())))
        .expanded(picker_open)
        .key(trigger_key.clone());

        if scope == Scope::Project {
            let effective = state.selection_label(&defaults.effective);
            let effective_help =
                t("settings.websearch.effective").replace("{provider}", &effective);
            trigger = trigger.help(&effective_help).description(effective_help);
        }

        let mut setting_row = chrome::setting_row_with_info(t(scope.i18n_key()), info, trigger)
            .role("group")
            .label(t(scope.i18n_key()));
        if !entry.path.is_empty() {
            setting_row = setting_row.help(&entry.path).description(&entry.path);
        }

        let mut row = col().full_width().separate(Space::Xs).child(setting_row);

        if picker_open && !locked {
            let mut option_keys = Vec::with_capacity(options.len());
            let mut list = col()
                .full_width()
                .separate(Space::Xs)
                .role("listbox")
                .label(t(scope.i18n_key()));
            for (choice, label, suffix) in options {
                let selected = entry.selection == choice;
                let opt_key = format!("websearch-scope-{}-{suffix}", scope.as_str());
                option_keys.push(opt_key.clone());
                let save_rc = state_rc.clone();
                let focus_back = trigger_key.clone();
                list = list.child(
                    layout::button_tx(&label, false, move |_: &mut S, tx| {
                        if selected {
                            save_rc.borrow_mut().open_picker = None;
                        } else {
                            save_rc.borrow_mut().save_scope(scope, choice.clone());
                        }
                        tx.focus(focus_back.clone(), true);
                    })
                    .role("option")
                    .checked(selected)
                    .focus_selected(selected)
                    .key(opt_key),
                );
            }
            let close_rc = state_rc.clone();
            let esc_rc = state_rc.clone();
            let esc_trigger = trigger_key.clone();
            row = row
                .child(attach_picker_keys(
                    list,
                    trigger_key,
                    option_keys,
                    move |_: &mut S| close_rc.borrow_mut().open_picker = None,
                ))
                .on_key(move |_: &mut S, event, tx| {
                    if event.key == Key::Escape && event.mods == rune::Mods::default() {
                        esc_rc.borrow_mut().open_picker = None;
                        tx.focus(esc_trigger.clone(), true);
                        return true;
                    }
                    false
                });
        }
        section = section.child(row);
    }
    section
}
