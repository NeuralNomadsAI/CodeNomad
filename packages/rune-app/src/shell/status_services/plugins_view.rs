//! Right-panel Status: Plugins section view (switches, row actions, pending install state).
use super::{
    plugins::PluginsPanel,
    plugins_cards::{add_source_panel, remove_confirm_card, system_attention_block},
};
use crate::{State, screen, strings::t};
use codenomad_client::plugins::{
    ActivationControl, ConfigScope, RemovalTarget, RuntimeEntry, RuntimeSource, RuntimeState,
    Scope, ScopeRuleState, Snapshot,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings, shell,
};

pub(super) fn view(s: &State) -> Option<El> {
    let panel = &s.status_services.plugins;
    panel.backend.as_ref()?;
    let mut body = col().full_width().separate(Space::Sm);
    if panel.expanded {
        let reading = panel.reading();
        let locked = panel.mutations_locked();
        let controls_available = panel
            .snapshot
            .as_ref()
            .is_some_and(|snap| snap.controls_available);

        body = body.child(header_row(s, panel, reading, locked, controls_available));

        if let Some(err) = &panel.feedback_error {
            body = body.child(text(err).wrap().role("alert"));
        }
        if panel.failed && panel.snapshot.is_some() {
            body = body.child(
                text(t("instanceServiceStatus.plugins.errors.refresh"))
                    .wrap()
                    .role("alert"),
            );
        }

        if let Some(snap) = &panel.snapshot
            && let Some(attention) = system_attention_block(s, panel, snap)
        {
            body = body.child(attention);
        }

        if panel.add_open && controls_available {
            body = body.child(add_source_panel(s, panel, locked));
        }

        if let Some(confirm) = &panel.confirm_remove {
            body = body.child(remove_confirm_card(
                s,
                &confirm.removal,
                locked,
                panel.remove_ready(),
            ));
        }

        if panel.snapshot.is_none() {
            let status_key = if panel.unsupported {
                "instanceServiceStatus.plugins.empty"
            } else if panel.failed && !reading {
                "instanceServiceStatus.plugins.errors.load"
            } else {
                "instanceServiceStatus.plugins.loading"
            };
            body = body.child(text(t(status_key)).wrap().role("status"));
        } else if let Some(snap) = &panel.snapshot {
            body = body.child(rows_list(s, panel, snap, locked));
        }
    }
    Some(
        settings::disclosure(
            t("instanceServiceStatus.sections.plugins"),
            panel.expanded,
            body,
            screen::action(&s.input_scope, |s| {
                s.status_services.plugins.toggle_section();
            }),
        )
        .key("status-plugins"),
    )
}

fn header_row(
    s: &State,
    panel: &PluginsPanel,
    reading: bool,
    locked: bool,
    controls_available: bool,
) -> El {
    let mut actions = layout::action_row().child(
        layout::button(
            t("instanceServiceStatus.plugins.refresh"),
            !panel.online || reading || panel.write_active,
            screen::action(&s.input_scope, |s| {
                s.status_services.plugins.request_refresh();
            }),
        )
        .key("plugins-refresh"),
    );
    if controls_available {
        actions = actions.child(
            layout::button(
                t("instanceServiceStatus.plugins.sources.add"),
                locked,
                screen::action(&s.input_scope, |s| {
                    s.status_services.plugins.open_add();
                }),
            )
            .expanded(panel.add_open)
            .key("plugins-add-toggle"),
        );
    }
    let mut header = col().full_width().separate(Space::Xs).child(actions);
    if controls_available
        && panel
            .snapshot
            .as_ref()
            .is_some_and(|snap| snap.visible_controls().next().is_some())
    {
        let project_available = panel
            .snapshot
            .as_ref()
            .is_some_and(Snapshot::project_available);
        let mut project_label = text(t(Scope::Project.i18n_key())).text_role(TextRole::Small);
        if !project_available {
            let reason = t("instanceServiceStatus.plugins.scope.unavailable");
            project_label = project_label.help(reason).description(reason);
        }
        header = header.child(shell::service_header([
            text(t(Scope::Global.i18n_key())).text_role(TextRole::Small),
            project_label,
        ]));
    }
    header
}

fn rows_list(s: &State, panel: &PluginsPanel, snap: &Snapshot, locked: bool) -> El {
    let controls: Vec<&ActivationControl> = snap.visible_controls().collect();
    let unmatched_rt: Vec<&RuntimeEntry> = snap.unmatched_runtime().collect();
    let mut pending_targets: Vec<&str> = snap
        .unmatched_sources()
        .into_iter()
        .map(|src| src.target.as_str())
        .collect();
    for spec in panel.pending_specs_for(snap) {
        if !pending_targets.contains(&spec) {
            pending_targets.push(spec);
        }
    }
    if controls.is_empty() && unmatched_rt.is_empty() && pending_targets.is_empty() {
        return text(t("instanceServiceStatus.plugins.empty"))
            .wrap()
            .role("status");
    }
    let mut list = col().full_width().separate(Space::Xs);
    for control in controls {
        list = list.child(control_row(s, panel, snap, control, locked));
    }
    for entry in unmatched_rt {
        list = list.child(runtime_row(s, panel, snap, entry, locked));
    }
    for target in pending_targets {
        let installing = panel.is_install_pending(&snap.directory, target);
        let removals = snap.removable_for_target(target);
        let details = t("instanceServiceStatus.plugins.source.package").replace("{source}", target);
        let status_key = if installing {
            "instanceServiceStatus.plugins.sources.pendingLabel"
        } else {
            "instanceServiceStatus.plugins.sources.unconfirmedLabel"
        };
        let mut trailing = vec![
            text(t(status_key))
                .text_role(TextRole::Small)
                .role("status"),
        ];
        if !installing {
            trailing.push(
                layout::button(
                    t("settings.providers.refresh"),
                    !panel.online || panel.reading() || panel.write_active,
                    screen::action(&s.input_scope, |s| {
                        s.status_services.plugins.request_refresh();
                    }),
                )
                .key(format!("plugin-src-refresh-{target}")),
            );
        }
        let mut item = col()
            .full_width()
            .separate(Space::Xs)
            .role("group")
            .label(target)
            .help(&details)
            .description(&details)
            .child(shell::service_row(None, target, trailing));
        if snap.controls_available && !removals.is_empty() {
            item = item.child(row_actions(s, panel, None, &removals, locked));
        }
        list = list.child(item.key(format!("plugin-src-{target}")));
    }
    list
}

fn control_row(
    s: &State,
    panel: &PluginsPanel,
    snap: &Snapshot,
    control: &ActivationControl,
    locked: bool,
) -> El {
    let details = control_details(control, snap);
    let version = control
        .runtime
        .as_ref()
        .and_then(RuntimeEntry::display_version);
    let failed = control
        .runtime
        .as_ref()
        .is_some_and(|r| matches!(r.state, RuntimeState::Failed { .. }));

    let info_key = format!("ctrl:{}", control.id);
    let info_key_toggle = info_key.clone();
    let info_label =
        t("instanceServiceStatus.plugins.system.details").replace("{name}", &control.id);
    let mut trailing = vec![
        settings::info_tip(
            &info_label,
            &details,
            panel.open_info_key.as_deref() == Some(info_key.as_str()),
            screen::action(&s.input_scope, move |s| {
                s.status_services
                    .plugins
                    .toggle_info(info_key_toggle.clone());
            }),
        )
        .key(format!("plugin-info-{}", control.id)),
    ];
    if let Some(ver) = &version {
        trailing.push(text(ver).text_role(TextRole::Small));
    }
    if failed {
        trailing.push(
            text(t("instanceServiceStatus.plugins.runtime.failed"))
                .text_role(TextRole::Small)
                .role("status"),
        );
    }
    if !control.orphan {
        trailing.push(scope_switch(s, snap, control, Scope::Global, locked));
        trailing.push(scope_switch(s, snap, control, Scope::Project, locked));
    }
    let header = shell::service_row(None, &control.id, trailing);

    let mut row_el = col()
        .full_width()
        .separate(Space::Xs)
        .role("group")
        .label(&control.id)
        .help(&details)
        .description(&details)
        .child(header);
    let removals = snap.removable_for_control(control);
    let pkg = control.runtime.as_ref().map(|r| &r.source);
    if snap.controls_available
        && (matches!(pkg, Some(RuntimeSource::Package { .. })) || !removals.is_empty())
    {
        row_el = row_el.child(row_actions(s, panel, pkg, &removals, locked));
    }
    row_el.key(format!("plugin-row-{}", control.id))
}

fn runtime_row(
    s: &State,
    panel: &PluginsPanel,
    snap: &Snapshot,
    entry: &RuntimeEntry,
    locked: bool,
) -> El {
    let title = entry.id.as_deref().unwrap_or(&entry.key);
    let details = runtime_details(entry);
    let info_key = format!("rt:{}", entry.key);
    let info_key_toggle = info_key.clone();
    let info_label = t("instanceServiceStatus.plugins.system.details").replace("{name}", title);
    let mut trailing = vec![
        settings::info_tip(
            &info_label,
            &details,
            panel.open_info_key.as_deref() == Some(info_key.as_str()),
            screen::action(&s.input_scope, move |s| {
                s.status_services
                    .plugins
                    .toggle_info(info_key_toggle.clone());
            }),
        )
        .key(format!("plugin-rt-info-{}", entry.key)),
    ];
    if let Some(ver) = entry.display_version() {
        trailing.push(text(&ver).text_role(TextRole::Small));
    }
    if matches!(entry.state, RuntimeState::Failed { .. }) {
        trailing.push(
            text(t("instanceServiceStatus.plugins.runtime.failed"))
                .text_role(TextRole::Small)
                .role("status"),
        );
    }
    let header = shell::service_row(None, title, trailing);
    let mut row_el = col()
        .full_width()
        .separate(Space::Xs)
        .role("group")
        .label(title)
        .help(&details)
        .description(&details)
        .child(header);
    if snap.controls_available {
        let removals = match &entry.source {
            RuntimeSource::Package { target, .. } => snap.removable_for_target(target),
            _ => Vec::new(),
        };
        if matches!(entry.source, RuntimeSource::Package { .. }) || !removals.is_empty() {
            row_el = row_el.child(row_actions(
                s,
                panel,
                Some(&entry.source),
                &removals,
                locked,
            ));
        }
    }
    row_el.key(format!("plugin-rt-{}", entry.key))
}

fn scope_switch(
    s: &State,
    snap: &Snapshot,
    control: &ActivationControl,
    scope: Scope,
    locked: bool,
) -> El {
    let available = snap.scope_available(scope);
    let checked = control.checked(scope);
    let next_enabled = !checked;
    let plugin_id = control.id.clone();
    let managed = control.managed_by_codenomad;
    let aria = t("instanceServiceStatus.plugins.toggleAriaLabel").replace(
        "{name}",
        &format!("{} — {}", control.id, t(scope.i18n_key())),
    );
    let mut sw = shell::compact_switch(
        &aria,
        checked,
        locked || !available,
        screen::action(&s.input_scope, move |s| {
            let wake = s.wake.clone();
            s.status_services.plugins.toggle_activation(
                plugin_id.clone(),
                scope,
                next_enabled,
                managed,
                &wake,
            );
        }),
    )
    .key(format!("plugin-switch-{}-{}", control.id, scope.as_str()));
    if scope == Scope::Global && control.project != ScopeRuleState::Default {
        let hint = t("instanceServiceStatus.plugins.globalOverridden");
        sw = sw.help(hint).description(hint);
    }
    sw
}

fn row_actions(
    s: &State,
    panel: &PluginsPanel,
    source: Option<&RuntimeSource>,
    removals: &[RemovalTarget],
    locked: bool,
) -> El {
    let mut actions = layout::action_row();
    if let Some(RuntimeSource::Package {
        target,
        outdated,
        updating,
        ..
    }) = source
    {
        let busy =
            locked || *updating || panel.package_busy(target) || panel.package_unconfirmed(target);
        let key_name = if *outdated {
            "settings.pluginPackages.update"
        } else {
            "settings.pluginPackages.check"
        };
        let label = t(key_name).replace("{target}", target);
        let target_id = target.clone();
        let is_update = *outdated;
        let help = t("settings.pluginPackages.shared");
        actions = actions.child(
            layout::button(
                &label,
                busy,
                screen::action(&s.input_scope, move |s| {
                    let wake = s.wake.clone();
                    s.status_services
                        .plugins
                        .run_package(target_id.clone(), is_update, &wake);
                }),
            )
            .help(help)
            .description(help)
            .key(format!("plugin-pkg-{target}")),
        );
    }
    for removal in removals {
        let scope_label = t(removal.scope.i18n_key());
        let label =
            t("instanceServiceStatus.plugins.sources.remove").replace("{scope}", scope_label);
        let item = removal.clone();
        let trigger_key = format!(
            "plugin-remove-{}-{}",
            removal.scope.as_str(),
            removal.target
        );
        let trigger_key_for_action = trigger_key.clone();
        actions = actions.child(
            layout::button_tx(
                &label,
                locked,
                screen::action_tx(&s.input_scope, move |s, tx| {
                    s.status_services.plugins.request_remove_confirm(
                        item.clone(),
                        trigger_key_for_action.clone(),
                        tx,
                    );
                }),
            )
            .key(trigger_key),
        );
    }
    actions
}

fn control_details(control: &ActivationControl, snap: &Snapshot) -> String {
    let mut lines =
        vec![t("instanceServiceStatus.plugins.kind.plugin").replace("{id}", &control.id)];
    if let Some(rt) = &control.runtime {
        lines.extend(runtime_detail_lines(rt));
        if rt.gui_feature {
            let non_global = snap.configured_sources.iter().any(|src| {
                src.scope != ConfigScope::Global
                    && (src.plugin_id.as_deref() == Some(control.id.as_str())
                        || matches!(&rt.source, RuntimeSource::Package { target, .. } if target == &src.target))
            });
            if non_global {
                lines.push(t("instanceServiceStatus.plugins.sources.guiGlobalOnly").to_owned());
            }
        }
    }
    if control.project != ScopeRuleState::Default {
        lines.push(t("instanceServiceStatus.plugins.globalOverridden").to_owned());
    }
    lines.join("\n")
}

fn runtime_details(entry: &RuntimeEntry) -> String {
    let mut lines = Vec::new();
    if let Some(id) = &entry.id {
        lines.push(t("instanceServiceStatus.plugins.kind.plugin").replace("{id}", id));
    }
    lines.extend(runtime_detail_lines(entry));
    lines.join("\n")
}

fn runtime_detail_lines(entry: &RuntimeEntry) -> Vec<String> {
    let mut lines = Vec::new();
    match &entry.source {
        RuntimeSource::Package {
            target,
            version,
            revision,
            outdated,
            ..
        } => {
            lines.push(
                t("instanceServiceStatus.plugins.source.package").replace("{source}", target),
            );
            if let Some(ver) = version {
                lines.push(
                    t("instanceServiceStatus.plugins.sources.version").replace("{version}", ver),
                );
            }
            if let Some(rev) = revision {
                lines.push(
                    t("instanceServiceStatus.plugins.sources.commit").replace("{commit}", rev),
                );
            }
            if *outdated {
                lines.push(t("instanceServiceStatus.plugins.sources.outdated").to_owned());
            }
        }
        RuntimeSource::Local { path } => {
            lines.push(t("instanceServiceStatus.plugins.source.local").replace("{source}", path));
        }
        RuntimeSource::Builtin => {
            lines.push(t("instanceServiceStatus.plugins.source.builtin").to_owned());
        }
        RuntimeSource::Sdk => {
            lines.push(t("instanceServiceStatus.plugins.source.sdk").to_owned());
        }
    }
    if let RuntimeState::Failed { error, error_ref } = &entry.state {
        let failed = t("instanceServiceStatus.plugins.runtime.failed");
        if let Some(detail) = error {
            lines.push(format!("{failed} — {detail}"));
        } else {
            lines.push(failed.to_owned());
        }
        if let Some(reference) = error_ref {
            lines.push(
                t("instanceServiceStatus.plugins.sources.failureRef").replace("{ref}", reference),
            );
        }
    }
    lines
}
