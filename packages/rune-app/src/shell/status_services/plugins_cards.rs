//! Right-panel Status: Plugins add-source form, removal confirmation, and system attention cards.
use super::plugins::PluginsPanel;
use crate::{State, screen, strings::t};
use codenomad_client::plugins::{
    ConfigScope, RemovalTarget, RuntimeSource, RuntimeState, Scope, Snapshot, SystemAttentionEntry,
    SystemAttentionKind,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings, shell,
};

pub(super) fn system_attention_block(
    s: &State,
    panel: &PluginsPanel,
    snap: &Snapshot,
) -> Option<El> {
    let entries = snap.system_attention_entries(&panel.runtime_unconfirmed);
    if entries.is_empty() {
        return None;
    }
    let locked = panel.mutations_locked();
    let mut box_el = col()
        .full_width()
        .separate(Space::Xs)
        .role("status")
        .label(t("instanceServiceStatus.plugins.system.attention"))
        .child(
            text(t("instanceServiceStatus.plugins.system.attention"))
                .text_role(TextRole::Button)
                .role("heading"),
        );
    for entry in entries {
        box_el = box_el.child(system_attention_row(s, panel, &entry, locked));
    }
    Some(settings::card(box_el).key("plugins-system-attention"))
}

fn system_attention_row(
    s: &State,
    panel: &PluginsPanel,
    entry: &SystemAttentionEntry,
    locked: bool,
) -> El {
    let scope_name = scope_label(entry.controlling_scope);
    let status_key = match entry.kind {
        SystemAttentionKind::Disabled => "instanceServiceStatus.plugins.system.disabled",
        SystemAttentionKind::Failed => "instanceServiceStatus.plugins.system.failed",
        SystemAttentionKind::Unconfirmed => "instanceServiceStatus.plugins.system.unconfirmed",
    };
    let label = t(status_key)
        .replace("{name}", &entry.name)
        .replace("{scope}", scope_name);
    let details = system_attention_details(entry);
    let info_key = format!("sys:{}", entry.key);
    let info_key_toggle = info_key.clone();
    let info_label =
        t("instanceServiceStatus.plugins.system.details").replace("{name}", &entry.name);
    let info = settings::info_tip(
        &info_label,
        &details,
        panel.open_info_key.as_deref() == Some(info_key.as_str()),
        screen::action(&s.input_scope, move |s| {
            s.status_services
                .plugins
                .toggle_info(info_key_toggle.clone());
        }),
    )
    .key(format!("plugin-sys-info-{}", entry.key));

    let mut trailing = vec![info];
    if let (Some(control_id), Some(target_scope)) = (&entry.control_id, entry.reenable_scope) {
        let plugin_id = control_id.clone();
        let target_label = t(target_scope.i18n_key());
        let aria = t("instanceServiceStatus.plugins.system.reenableAriaLabel")
            .replace("{name}", &entry.name)
            .replace("{scope}", target_label);
        let btn_label = if panel.write_active {
            t("instanceServiceStatus.plugins.system.reenabling")
        } else {
            t("instanceServiceStatus.plugins.system.reenable")
        };
        trailing.push(
            layout::button(
                btn_label,
                locked,
                screen::action(&s.input_scope, move |s| {
                    let wake = s.wake.clone();
                    s.status_services.plugins.toggle_activation(
                        plugin_id.clone(),
                        target_scope,
                        true,
                        true,
                        &wake,
                    );
                }),
            )
            .label(&aria)
            .key(format!("plugin-sys-reenable-{}", entry.key)),
        );
    }

    shell::service_row(None, &label, trailing).key(format!("plugin-sys-{}", entry.key))
}

fn system_attention_details(entry: &SystemAttentionEntry) -> String {
    let mut lines = vec![entry.name.clone()];
    if let Some(rt) = &entry.runtime {
        match &rt.source {
            RuntimeSource::Package { target, .. } => lines.push(
                t("instanceServiceStatus.plugins.source.package").replace("{source}", target),
            ),
            RuntimeSource::Local { path } => lines
                .push(t("instanceServiceStatus.plugins.source.local").replace("{source}", path)),
            _ => {}
        }
        if let RuntimeState::Failed { error, error_ref } = &rt.state {
            lines.push(
                error
                    .as_deref()
                    .unwrap_or_else(|| t("instanceServiceStatus.plugins.runtime.failed"))
                    .to_owned(),
            );
            if let Some(reference) = error_ref {
                lines.push(
                    t("instanceServiceStatus.plugins.sources.failureRef")
                        .replace("{ref}", reference),
                );
            }
        }
    }
    for (scope, path) in &entry.scopes {
        let scope_text = scope_label(Some(*scope));
        if let Some(p) = path {
            lines.push(format!("{scope_text} — {p}"));
        } else {
            lines.push(scope_text.to_owned());
        }
    }
    lines.join("\n")
}

fn scope_label(scope: Option<ConfigScope>) -> &'static str {
    match scope {
        Some(ConfigScope::Global) => t("instanceServiceStatus.plugins.scope.global"),
        Some(ConfigScope::Project) | None => t("instanceServiceStatus.plugins.scope.project"),
        Some(ConfigScope::Other) => t("instanceServiceStatus.plugins.scope.other"),
        Some(ConfigScope::Virtual) => t("instanceServiceStatus.plugins.scope.virtual"),
    }
}

pub(super) fn add_source_panel(s: &State, panel: &PluginsPanel, locked: bool) -> El {
    let project_available = panel
        .snapshot
        .as_ref()
        .is_some_and(Snapshot::project_available);
    let can_submit = !locked && !panel.add_spec.text.trim().is_empty();
    let scope_help = if panel.add_scope == Scope::Project {
        format!(
            "{}\n{}",
            t("instanceServiceStatus.plugins.sources.trust"),
            t("instanceServiceStatus.plugins.sources.projectWarning")
        )
    } else {
        t("instanceServiceStatus.plugins.sources.trust").to_owned()
    };
    let info = settings::info_tip(
        t("instanceServiceStatus.plugins.sources.addTitle"),
        &scope_help,
        panel.add_info_open,
        screen::action(&s.input_scope, |s| {
            s.status_services.plugins.add_info_open = !s.status_services.plugins.add_info_open;
        }),
    )
    .key("plugins-add-info");

    let edit_scope = s.input_scope.clone();
    let input = layout::hinted_field(
        &panel.add_spec,
        t("instanceServiceStatus.plugins.sources.specPlaceholder"),
    )
    .label(t("instanceServiceStatus.plugins.sources.spec"))
    .disabled(locked)
    .on_edit(move |s: &mut State| {
        if s.current_scope(&edit_scope) {
            &mut s.status_services.plugins.add_spec
        } else {
            s.rejected_edit = rune::TextEdit::new("");
            &mut s.rejected_edit
        }
    })
    .on_submit(screen::action_tx(&s.input_scope, |s, _| {
        let wake = s.wake.clone();
        s.status_services.plugins.submit_add(&wake);
    }));

    let mut form = col()
        .full_width()
        .separate(Space::Xs)
        .child(shell::service_heading_row(
            t("instanceServiceStatus.plugins.sources.addTitle"),
            [
                info,
                layout::button(
                    t("settings.providers.actions.close"),
                    locked,
                    screen::action(&s.input_scope, |s| {
                        s.status_services.plugins.open_add();
                    }),
                )
                .key("plugins-add-close"),
            ],
        ))
        .child(
            input
                .build(&field_kit(layout::dark()))
                .literal_direction()
                .key("plugins-add-spec"),
        )
        .child(
            layout::action_row()
                .child(
                    layout::button(
                        t(Scope::Global.i18n_key()),
                        locked,
                        screen::action(&s.input_scope, |s| {
                            s.status_services.plugins.set_add_scope(Scope::Global);
                        }),
                    )
                    .checked(panel.add_scope == Scope::Global)
                    .key("plugins-add-scope-global"),
                )
                .child(
                    layout::button(
                        t(Scope::Project.i18n_key()),
                        locked || !project_available,
                        screen::action(&s.input_scope, |s| {
                            s.status_services.plugins.set_add_scope(Scope::Project);
                        }),
                    )
                    .checked(panel.add_scope == Scope::Project)
                    .key("plugins-add-scope-project"),
                ),
        );
    if let Some(err) = &panel.add_error {
        form = form.child(text(err).wrap().role("alert"));
    }
    let submit_label = if panel.write_active {
        t("instanceServiceStatus.plugins.sources.adding")
    } else {
        t("instanceServiceStatus.plugins.sources.submit")
    };
    form = form.child(
        settings::primary_action(
            submit_label,
            !can_submit,
            screen::action(&s.input_scope, |s| {
                let wake = s.wake.clone();
                s.status_services.plugins.submit_add(&wake);
            }),
        )
        .key("plugins-add-submit"),
    );
    settings::card(form)
}

pub(super) fn remove_confirm_card(
    s: &State,
    removal: &RemovalTarget,
    locked: bool,
    ready: bool,
) -> El {
    let scope_label = t(removal.scope.i18n_key());
    let action = t("instanceServiceStatus.plugins.sources.remove").replace("{scope}", scope_label);
    let mut detail = format!(
        "{}\n{}",
        removal.target,
        t("instanceServiceStatus.plugins.sources.removeWarning")
    );
    if removal.scope == Scope::Global {
        detail.push('\n');
        detail.push_str(t(
            "instanceServiceStatus.plugins.sources.removeGlobalWarning",
        ));
    }
    detail.push('\n');
    detail.push_str(t("instanceServiceStatus.plugins.sources.removeRecovery"));
    let escape_scope = s.input_scope.clone();
    let modal_scope = s.input_scope.clone();
    settings::card(
        col()
            .key("plugins-remove-dialog")
            .full_width()
            .separate(Space::Xs)
            .role("alertdialog")
            .label(&action)
            .description(&detail)
            .modal_tx(true, move |s: &mut State, tx| {
                if s.input_scope == modal_scope {
                    s.status_services.plugins.cancel_remove_confirm(tx);
                }
            })
            .child(text(&action).text_role(TextRole::Button).role("heading"))
            .child(text(&detail).wrap())
            .child(
                layout::action_row()
                    .child(
                        layout::button_tx(
                            t("settings.providers.actions.close"),
                            false,
                            screen::action_tx(&s.input_scope, |s, tx| {
                                s.status_services.plugins.cancel_remove_confirm(tx);
                            }),
                        )
                        .key("plugins-remove-cancel")
                        .autofocus(),
                    )
                    .child(
                        settings::primary_action(
                            &action,
                            locked || !ready,
                            screen::action(&s.input_scope, |s| {
                                let wake = s.wake.clone();
                                s.status_services.plugins.confirm_and_remove(&wake);
                            }),
                        )
                        .key("plugins-remove-confirm"),
                    ),
            )
            .on_key(move |s: &mut State, key, tx| {
                if s.input_scope == escape_scope
                    && !tx.key_repeat()
                    && key.mods == rune::Mods::default()
                    && key.key == rune::Key::Escape
                {
                    s.status_services.plugins.cancel_remove_confirm(tx)
                } else {
                    false
                }
            }),
    )
}
