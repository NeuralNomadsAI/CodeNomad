//! Right-panel Status: Plugins section view (switches, row actions, add-source form).
use super::plugins::PluginsPanel;
use crate::{State, screen, strings::t};
use codenomad_client::plugins::{
    ActivationControl, RemovalTarget, RuntimeEntry, RuntimeSource, RuntimeState, Scope, Snapshot,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
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

        if panel.add_open && controls_available {
            body = body.child(add_source_panel(s, panel, locked));
        }

        if let Some(confirm) = &panel.confirm_remove {
            body = body.child(remove_confirm_card(s, confirm, locked));
        }

        if panel.snapshot.is_none() {
            let status_key = if panel.unsupported {
                "instanceServiceStatus.plugins.empty"
            } else if panel.failed && !reading {
                "instanceServiceStatus.plugins.errors.load"
            } else {
                "instanceServiceStatus.plugins.loading"
            };
            let el = text(t(status_key)).wrap();
            body = body.child(if panel.failed && !reading && !panel.unsupported {
                el.role("alert")
            } else {
                el.role("status")
            });
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
            reading || panel.write_active || !panel.online,
            screen::action(&s.input_scope, |s| {
                s.status_services.plugins.request_refresh();
            }),
        )
        .key("plugins-refresh"),
    );
    if controls_available {
        actions = actions.child(
            layout::button(
                t("instanceServiceStatus.plugins.sources.addPlugin"),
                locked,
                screen::action(&s.input_scope, |s| {
                    s.status_services.plugins.open_add();
                }),
            )
            .expanded(panel.add_open)
            .key("plugins-add-open"),
        );
    }
    let mut header = col().full_width().separate(Space::Xs).child(actions);
    if controls_available {
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

fn add_source_panel(s: &State, panel: &PluginsPanel, locked: bool) -> El {
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
                .build(field_kit(layout::dark()))
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

fn remove_confirm_card(s: &State, removal: &RemovalTarget, locked: bool) -> El {
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
    settings::card(
        col()
            .full_width()
            .separate(Space::Xs)
            .role("group")
            .label(&action)
            .child(text(&action).text_role(TextRole::Button).role("heading"))
            .child(text(&detail).wrap())
            .child(
                layout::action_row()
                    .child(
                        settings::primary_action(
                            &action,
                            locked,
                            screen::action(&s.input_scope, |s| {
                                let wake = s.wake.clone();
                                s.status_services.plugins.confirm_and_remove(&wake);
                            }),
                        )
                        .key("plugins-remove-confirm"),
                    )
                    .child(
                        layout::button(
                            t("settings.providers.actions.close"),
                            locked,
                            screen::action(&s.input_scope, |s| {
                                s.status_services.plugins.cancel_remove_confirm();
                            }),
                        )
                        .key("plugins-remove-cancel"),
                    ),
            ),
    )
    .key("plugins-remove-dialog")
}

fn rows_list(s: &State, panel: &PluginsPanel, snap: &Snapshot, locked: bool) -> El {
    let controls: Vec<&ActivationControl> = snap.visible_controls().collect();
    let unmatched_rt: Vec<&RuntimeEntry> = snap.unmatched_runtime().collect();
    let unmatched_src = snap.unmatched_sources();
    if controls.is_empty() && unmatched_rt.is_empty() && unmatched_src.is_empty() {
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
    for source in unmatched_src {
        let removals = snap.removable_for_target(&source.target);
        let details =
            t("instanceServiceStatus.plugins.source.package").replace("{source}", &source.target);
        let mut item = col()
            .full_width()
            .separate(Space::Xs)
            .role("group")
            .label(&source.target)
            .help(&details)
            .description(&details)
            .child(shell::service_row(
                None,
                &source.target,
                [
                    text(t("instanceServiceStatus.plugins.sources.unconfirmedLabel"))
                        .text_role(TextRole::Small)
                        .role("status"),
                ],
            ));
        if snap.controls_available && !removals.is_empty() {
            item = item.child(row_actions(s, panel, None, &removals, locked));
        }
        list = list.child(item.key(format!("plugin-src-{}", source.target)));
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

    let mut trailing = Vec::new();
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
    let mut trailing = Vec::new();
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
    shell::compact_switch(
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
    .key(format!("plugin-switch-{}-{}", control.id, scope.as_str()))
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
        let busy = locked || *updating || panel.package_busy(target);
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
            .key(format!(
                "plugin-pkg-{}-{target}",
                if is_update { "update" } else { "check" }
            )),
        );
    }
    for removal in removals {
        let scope_label = t(removal.scope.i18n_key());
        let label =
            t("instanceServiceStatus.plugins.sources.remove").replace("{scope}", scope_label);
        let target = removal.clone();
        actions = actions.child(
            layout::button(
                &label,
                locked,
                screen::action(&s.input_scope, move |s| {
                    s.status_services
                        .plugins
                        .request_remove_confirm(target.clone());
                }),
            )
            .key(format!(
                "plugin-remove-{}-{}",
                removal.scope.as_str(),
                removal.target
            )),
        );
    }
    actions
}

fn control_details(control: &ActivationControl, snap: &Snapshot) -> String {
    let mut lines =
        vec![t("instanceServiceStatus.plugins.kind.plugin").replace("{id}", &control.id)];
    if let Some(rt) = &control.runtime {
        lines.push(runtime_details(rt));
    }
    if control.project != codenomad_client::plugins::ScopeRuleState::Default {
        lines.push(t("instanceServiceStatus.plugins.globalOverridden").to_owned());
    }
    for target in &snap.targets {
        lines.push(format!("{} — {}", t(target.scope.i18n_key()), target.path));
    }
    if !snap.project_available() {
        lines.push(t("instanceServiceStatus.plugins.scope.unavailable").to_owned());
    }
    lines.join("\n")
}

fn runtime_details(entry: &RuntimeEntry) -> String {
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
            if let Some(v) = version {
                lines.push(
                    t("instanceServiceStatus.plugins.sources.version").replace("{version}", v),
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
    if entry.gui_feature {
        lines.push(t("instanceServiceStatus.plugins.sources.guiGlobalOnly").to_owned());
    }
    if let RuntimeState::Failed { error, error_ref } = &entry.state {
        lines.push(error.clone());
        if let Some(r) = error_ref {
            lines.push(t("instanceServiceStatus.plugins.sources.failureRef").replace("{ref}", r));
        }
    }
    lines.join("\n")
}
