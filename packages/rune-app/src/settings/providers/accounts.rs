//! Per-provider account management card (active account selector, add/rename/remove, auto-select).
use super::{
    Catalog,
    manager::{AccountAction, PickerId},
};
use crate::strings::t;
use codenomad_client::settings::provider_auth::{Connection, ListedProvider};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};

pub(super) const RENAME_AUTOFILL: rune::Autofill = rune::Autofill::Off;

pub(super) fn card<S: 'static>(
    catalog: &Catalog,
    provider: &ListedProvider,
    disabled: bool,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    let mgr = &catalog.manager;
    let busy = disabled || mgr.any_account_busy() || mgr.modal_open();
    let provider_id = provider.id.clone();

    let summary = provider_summary(provider);
    let info_key = format!("provider:{}", provider.id);
    let info_key_toggle = info_key.clone();
    let info_btn = chrome::info_tip(
        &provider.name,
        &summary,
        mgr.open_info_key.as_deref() == Some(info_key.as_str()),
        move |s: &mut S| access(s).manager.toggle_info(info_key_toggle.clone()),
    )
    .key(format!("provider-info-{}", provider.id));

    let mut body = col().full_width().separate(Space::Sm).child(
        layout::action_row()
            .child(
                text(&provider.name)
                    .wrap_anywhere()
                    .text_role(TextRole::Title)
                    .role("heading"),
            )
            .child(info_btn),
    );

    if let Some(err) = mgr.account_errors.get(&provider.id) {
        body = body.child(text(err.as_str()).wrap().role("alert"));
    }

    if !provider.connections.is_empty() || provider.can_connect {
        body = body.child(accounts_controls(catalog, provider, busy, layers, access));
    }

    chrome::card(body).key(format!("provider-{}", provider_id))
}

fn accounts_controls<S: 'static>(
    catalog: &Catalog,
    provider: &ListedProvider,
    busy: bool,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    let mgr = &catalog.manager;
    let has_credentials = provider.credential_count() > 0;
    let picker_id = PickerId::Account(provider.id.clone());
    let raw_labels: Vec<String> = provider
        .connections
        .iter()
        .map(|conn| provider.connection_display_label(conn).to_owned())
        .collect();
    let stable_keys: Vec<String> = provider
        .connections
        .iter()
        .map(Connection::identity_key)
        .collect();
    let display_labels = super::manager::unique_labels_stable(&raw_labels, &stable_keys);
    let option_entries: Vec<(String, Option<String>)> = provider
        .connections
        .iter()
        .zip(display_labels)
        .map(|(conn, display)| (display, conn.credential_id().map(str::to_owned)))
        .collect();
    let option_labels: Vec<&str> = option_entries.iter().map(|(l, _)| l.as_str()).collect();
    let current_label = option_entries.first().map(|(l, _)| l.as_str());
    let active_cred_id = provider
        .active_connection()
        .and_then(Connection::credential_id)
        .map(str::to_owned);

    let pid_toggle = picker_id.clone();
    let pid_choose = picker_id.clone();
    let prov_id_pick = provider.id.clone();
    let pick_entries = option_entries.clone();
    let select_disabled = busy || !has_credentials;
    let select = chrome::picker(
        &format!("provider-account-select-{}", provider.id),
        t("settings.accounts.current"),
        &option_labels,
    )
    .current(current_label)
    .disabled(select_disabled)
    .open(mgr.open_picker.as_ref() == Some(&picker_id))
    .on_toggle(move |s: &mut S| access(s).manager.toggle_picker(pid_toggle.clone()))
    .on_close(move |s: &mut S| access(s).manager.close_picker())
    .on_choose(move |s: &mut S, chosen, _| {
        let mgr = &mut access(s).manager;
        if mgr.open_picker.as_ref() != Some(&pid_choose) {
            return;
        }
        mgr.close_picker();
        if let Some((_, Some(cred_id))) = pick_entries.iter().find(|(lbl, _)| lbl == chosen)
            && active_cred_id.as_deref() != Some(cred_id.as_str())
        {
            mgr.queue_account_action(AccountAction::Activate {
                integration_id: prov_id_pick.clone(),
                credential_id: cred_id.clone(),
            });
        }
    });

    let trigger = chrome::build_picker(select, layers).help(t("settings.accounts.global"));
    let mut section = col()
        .full_width()
        .separate(Space::Xs)
        .role("group")
        .label(t("settings.accounts.title"))
        .child(chrome::setting_row(t("settings.accounts.current"), trigger));

    let mut actions = layout::action_row();
    let mut has_actions = false;
    if provider.can_connect {
        let prov_id = provider.id.clone();
        let trigger_key = format!("provider-account-add-{}", provider.id);
        let return_key = trigger_key.clone();
        actions = actions.child(
            layout::button_tx(t("settings.accounts.add"), busy, move |s: &mut S, tx| {
                access(s)
                    .manager
                    .open_connect_modal(prov_id.clone(), Some(return_key.clone()), tx);
            })
            .label(t("settings.accounts.add"))
            .key(trigger_key),
        );
        has_actions = true;
    }

    match provider.active_connection() {
        Some(Connection::Credential { id, label, .. }) => {
            let rename_prov = provider.id.clone();
            let rename_cred = id.clone();
            let rename_initial = label.clone();
            let remove_prov = provider.id.clone();
            let remove_cred = id.clone();
            let rename_input_key = format!("provider-account-rename-input-{}", provider.id);
            actions = actions
                .child(
                    layout::button_tx(t("settings.accounts.rename"), busy, move |s: &mut S, tx| {
                        access(s)
                            .manager
                            .start_rename(&rename_prov, &rename_cred, &rename_initial);
                        tx.focus_when_shown(rename_input_key.clone(), true);
                    })
                    .label(t("settings.accounts.rename"))
                    .key(format!("provider-account-rename-{}", provider.id)),
                )
                .child(
                    layout::button(t("settings.accounts.remove"), busy, move |s: &mut S| {
                        access(s)
                            .manager
                            .queue_account_action(AccountAction::Remove {
                                integration_id: remove_prov.clone(),
                                credential_id: remove_cred.clone(),
                            });
                    })
                    .label(t("settings.accounts.remove"))
                    .key(format!("provider-account-remove-{}", provider.id)),
                );
            has_actions = true;
        }
        Some(Connection::Env { .. }) => {
            let env_key = format!("env:{}", provider.id);
            let env_key_toggle = env_key.clone();
            actions = actions.child(
                chrome::info_tip(
                    t("settings.providers.source.env"),
                    t("settings.providers.source.env"),
                    mgr.open_info_key.as_deref() == Some(env_key.as_str()),
                    move |s: &mut S| access(s).manager.toggle_info(env_key_toggle.clone()),
                )
                .key(format!("provider-account-env-{}", provider.id)),
            );
            has_actions = true;
        }
        None => {}
    }

    if has_actions {
        section = section.child(actions);
    }

    if let Some(Connection::Credential { id, .. }) = provider.active_connection()
        && let Some(draft) = mgr.rename_draft(&provider.id, id)
        && draft.editing
    {
        let prov_edit = provider.id.clone();
        let cred_edit = id.clone();
        let prov_save = provider.id.clone();
        let cred_save = id.clone();
        let prov_submit = provider.id.clone();
        let cred_submit = id.clone();
        let prov_cancel = provider.id.clone();
        let cred_cancel = id.clone();
        let trimmed = draft.text.text.trim();
        let can_save =
            !busy && draft.dirty && !trimmed.is_empty() && trimmed.chars().take(257).count() <= 256;
        let input = layout::literal_field(&draft.text)
            .label(t("settings.accounts.label"))
            .autofill(RENAME_AUTOFILL)
            .disabled(busy)
            .on_edit(move |s: &mut S| access(s).manager.rename_text_mut(&prov_edit, &cred_edit))
            .on_submit(move |s: &mut S, _| {
                access(s).manager.submit_rename(&prov_submit, &cred_submit);
            })
            .build(&field_kit(layout::dark()))
            .key(format!("provider-account-rename-input-{}", provider.id));
        section = section.child(
            col().full_width().separate(Space::Xs).child(input).child(
                layout::action_row()
                    .child(
                        layout::button(
                            t("settings.configFiles.actions.save"),
                            !can_save,
                            move |s: &mut S| {
                                access(s).manager.submit_rename(&prov_save, &cred_save);
                            },
                        )
                        .key(format!("provider-account-rename-save-{}", provider.id)),
                    )
                    .child(
                        layout::button(t("alertDialog.actions.cancel"), busy, move |s: &mut S| {
                            access(s).manager.cancel_rename(&prov_cancel, &cred_cancel);
                        })
                        .key(format!("provider-account-rename-cancel-{}", provider.id)),
                    ),
            ),
        );
    }

    if provider.account_selection.supported && provider.credential_count() > 1 {
        let enabled = provider.account_selection.enabled;
        let prov_auto = provider.id.clone();
        let info_auto_key = format!("auto:{}", provider.id);
        let info_auto_toggle = info_auto_key.clone();
        let auto_info = chrome::info_tip(
            t("settings.accounts.autoSelect"),
            t("settings.accounts.autoSelectHint"),
            mgr.open_info_key.as_deref() == Some(info_auto_key.as_str()),
            move |s: &mut S| access(s).manager.toggle_info(info_auto_toggle.clone()),
        )
        .key(format!("provider-account-auto-info-{}", provider.id));
        let switch = chrome::setting_switch(
            t("settings.accounts.autoSelect"),
            enabled,
            busy,
            move |s: &mut S| {
                access(s)
                    .manager
                    .queue_account_action(AccountAction::AutoSelect {
                        integration_id: prov_auto.clone(),
                        enabled: !enabled,
                    });
            },
        )
        .key(format!("provider-account-auto-{}", provider.id));
        section = section.child(chrome::setting_row_with_info(
            t("settings.accounts.autoSelect"),
            Some(auto_info),
            switch,
        ));
    }

    section
}

fn provider_summary(provider: &ListedProvider) -> String {
    let models = if provider.model_count == 1 {
        t("settings.providers.models.one")
    } else {
        t("settings.providers.models.other")
    }
    .replace("{count}", &provider.model_count.to_string());
    let mut parts = Vec::new();
    for part in [
        t(provider.method_summary_key()),
        t(provider.source.i18n_key()),
        models.as_str(),
    ] {
        if !part.is_empty() && !parts.contains(&part) {
            parts.push(part);
        }
    }
    parts.join(" • ")
}
