use super::{
    Panel, RowAction, catalog_date, connection_text, family_label, format_template,
    host_action_key, localized_summary, offer_document,
    state::{LoadState, PendingConfirm},
    state_line,
};
use crate::strings::{locale, t};
use codenomad_client::settings::integrations::{
    CatalogState, IntegrationFamily, IntegrationScope, IntegrationView,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};

pub(in crate::settings) fn view<S: 'static>(
    panel: &Panel,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> Option<&mut Panel>,
) -> El {
    let mut body = col().full_width().separate(Space::Sm);
    let busy = panel.busy();
    let can_act = panel.fresh() && !busy;
    let header_status = match &panel.load {
        _ if !panel.available() => {
            Some((t("settings.providers.empty.noInstance").to_owned(), false))
        }
        LoadState::Idle | LoadState::Loading => Some((t("rune.loading").to_owned(), false)),
        LoadState::Unsupported => {
            Some((t("integrations.connection.unsupported").to_owned(), false))
        }
        LoadState::Error => Some((t("integrations.catalogUnavailable").to_owned(), true)),
        LoadState::Ready(snapshot) => match snapshot.catalog_state {
            CatalogState::Unavailable => {
                Some((t("integrations.catalogUnavailable").to_owned(), true))
            }
            CatalogState::Stale => Some((
                catalog_date(snapshot.fetched_at.as_deref()).map_or_else(
                    || t("integrations.catalogUnavailable").to_owned(),
                    |date| format_template("integrations.catalogStale", &[("date", date)]),
                ),
                false,
            )),
            CatalogState::Fresh if panel.refresh_error => {
                Some((t("integrations.error.retry").to_owned(), true))
            }
            CatalogState::Fresh if panel.reading() || panel.stale => {
                Some((t("rune.loading").to_owned(), false))
            }
            CatalogState::Fresh => None,
        },
    };
    body = body.child(chrome::card(
        layout::action_row()
            .child(
                layout::button(
                    t("integrations.refresh"),
                    !panel.available() || panel.reading() || busy,
                    move |s: &mut S| {
                        if let Some(panel) = access(s) {
                            panel.refresh();
                        }
                    },
                )
                .key("integrations-refresh"),
            )
            .children(header_status.map(|(label, alert)| {
                if alert {
                    chrome::palette::save_error(&label)
                } else {
                    text(label).text_role(TextRole::Small).wrap().role("status")
                }
            })),
    ));

    if let Some(notice) = &panel.notice {
        body = body.child(
            if notice.error {
                chrome::palette::save_error(&notice.text)
            } else {
                text(&notice.text)
                    .text_role(TextRole::Small)
                    .wrap()
                    .role("status")
            }
            .key("integrations-notice"),
        );
    }
    if panel.docs_link.failed() {
        body = body.child(chrome::palette::save_error(t("rune.connect_error")));
    }

    if let LoadState::Ready(snapshot) = &panel.load
        && panel.available()
    {
        let current_locale = locale();
        let recognized: Vec<_> = snapshot
            .integrations
            .iter()
            .filter(|entry| entry.recognized())
            .collect();
        let installable: Vec<_> = snapshot
            .integrations
            .iter()
            .filter(|entry| entry.installable())
            .collect();

        for entry in recognized {
            body = body.child(recognized_card(
                panel,
                entry,
                current_locale,
                !can_act,
                access,
            ));
        }

        let mut catalog_col = col().full_width().separate(Space::Sm).child(
            text(t("integrations.catalog.title"))
                .text_role(TextRole::Title)
                .role("heading"),
        );
        if installable.is_empty() {
            if snapshot.catalog_state != CatalogState::Unavailable {
                catalog_col = catalog_col.child(
                    text(t("integrations.catalog.allInstalled"))
                        .text_role(TextRole::Small)
                        .role("status"),
                );
            }
        } else {
            for entry in installable {
                catalog_col = catalog_col.child(installable_card(
                    panel,
                    entry,
                    current_locale,
                    !can_act,
                    access,
                ));
            }
        }
        body = body.child(chrome::card(catalog_col));
    }

    if let Some(pending) = &panel.confirm {
        layers.push(confirmation_layer(pending, access));
    }

    body
}

fn recognized_card<S: 'static>(
    panel: &Panel,
    entry: &IntegrationView,
    current_locale: &str,
    busy: bool,
    access: fn(&mut S) -> Option<&mut Panel>,
) -> El {
    let id = entry.id.clone();
    let host_key = host_action_key(entry);
    let binding = panel.bindings.get(&entry.id);
    let offers = panel.offers.get(&entry.id).map(Vec::as_slice);
    let line = state_line(
        entry,
        binding,
        offers,
        panel.has_session(),
        host_key.is_some() && !busy,
    );
    let binding_ready = binding.is_some();
    let header = entry_header(panel, entry, current_locale, access);
    let mut card = col().full_width().separate(Space::Sm).child(header);

    let line_el = match line.action {
        Some(RowAction::InstallHost | RowAction::UpdateHost) => {
            let target_id = id.clone();
            layout::button(&line.text, busy, move |s: &mut S| {
                if let Some(panel) = access(s) {
                    panel.request_host_install(&target_id);
                }
            })
            .key(format!("integration-line-action-{id}"))
        }
        Some(RowAction::Attach(expected)) => {
            let target_id = id.clone();
            layout::button(&line.text, busy || !binding_ready, move |s: &mut S| {
                if let Some(panel) = access(s) {
                    panel.request_attach(&target_id, expected.clone());
                }
            })
            .key(format!("integration-attach-{id}"))
        }
        Some(RowAction::Detach) => {
            let target_id = id.clone();
            layout::action_row()
                .child(
                    text(&line.text)
                        .text_role(TextRole::Small)
                        .wrap()
                        .role("status"),
                )
                .child(
                    layout::button(
                        t("integrations.detachConversation"),
                        busy || !binding_ready,
                        move |s: &mut S| {
                            if let Some(panel) = access(s) {
                                panel.request_detach(&target_id);
                            }
                        },
                    )
                    .key(format!("integration-detach-{id}")),
                )
        }
        None if line.warning => chrome::palette::save_error(&line.text),
        None => text(&line.text)
            .text_role(TextRole::Small)
            .wrap()
            .role("status"),
    };
    card = card.child(line_el);
    let connection = connection_text(entry);
    if connection != line.text {
        card = card.child(text(connection).text_role(TextRole::Small).wrap());
    }

    if let Some(part_version) = entry
        .status
        .as_ref()
        .and_then(|s| s.host.as_ref())
        .and_then(|h| h.part_version.as_deref())
    {
        card = card.child(
            text(format_template(
                "integrations.partVersion",
                &[("app", &entry.app.name), ("version", part_version)],
            ))
            .text_role(TextRole::Small)
            .wrap(),
        );
    }

    if let Some(action_key) = host_key {
        let target_id = id.clone();
        card = card.child(
            layout::action_row().child(
                layout::button(t(action_key), busy, move |s: &mut S| {
                    if let Some(panel) = access(s) {
                        panel.request_host_install(&target_id);
                    }
                })
                .key(format!("integration-host-install-{id}")),
            ),
        );
    }

    if let Some(chooser) = &panel.chooser
        && chooser.id == entry.id
    {
        let mut choices = col()
            .full_width()
            .separate(Space::Xs)
            .child(text(t("integrations.attachChoose")).role("heading"));
        for offer in &chooser.offers {
            let offer_id = offer.offer_id.clone();
            let doc = offer_document(offer);
            choices = choices.child(
                layout::button(doc, busy, move |s: &mut S| {
                    if let Some(panel) = access(s) {
                        panel.choose_offer(&offer_id);
                    }
                })
                .key(format!("integration-offer-{}", offer.offer_id)),
            );
        }
        choices = choices.child(
            layout::button(t("alertDialog.actions.cancel"), false, move |s: &mut S| {
                if let Some(panel) = access(s) {
                    panel.dismiss_overlay();
                }
            })
            .key(format!("integration-offer-cancel-{id}")),
        );
        card = card.child(chrome::card(choices));
    }

    chrome::card(card).key(format!("integration-row-{}", entry.id))
}

fn installable_card<S: 'static>(
    panel: &Panel,
    entry: &IntegrationView,
    current_locale: &str,
    busy: bool,
    access: fn(&mut S) -> Option<&mut Panel>,
) -> El {
    let id = entry.id.clone();
    let header = entry_header(panel, entry, current_locale, access);
    let scope_control = if entry.family == IntegrationFamily::Native {
        chrome::setting_row(
            t("integrations.catalog.scope"),
            text(t("integrations.section.scopeGlobalOnly")),
        )
    } else {
        let selected = match panel.selected_scope(entry) {
            IntegrationScope::Global => 0,
            IntegrationScope::Project => 1,
        };
        let target_id = id.clone();
        chrome::setting_row(
            t("integrations.catalog.scope"),
            chrome::segments(
                t("integrations.catalog.scope"),
                &[
                    t("instanceServiceStatus.plugins.scope.global"),
                    t("instanceServiceStatus.plugins.scope.project"),
                ],
                Some(selected),
                busy,
                move |s: &mut S, index| {
                    if let Some(panel) = access(s) {
                        let scope = if index == 1 {
                            IntegrationScope::Project
                        } else {
                            IntegrationScope::Global
                        };
                        panel.set_scope(&target_id, scope);
                    }
                },
            ),
        )
    };
    let target_id = id.clone();
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .child(header)
            .child(text(family_label(entry.family)).text_role(TextRole::Small))
            .child(scope_control)
            .child(
                layout::action_row().child(
                    chrome::primary_action(
                        t("integrations.catalog.install"),
                        busy,
                        move |s: &mut S| {
                            if let Some(panel) = access(s) {
                                panel.request_catalog_install(&target_id);
                            }
                        },
                    )
                    .key(format!("integration-install-{id}")),
                ),
            ),
    )
    .key(format!("integration-catalog-{}", entry.id))
}

fn entry_header<S: 'static>(
    panel: &Panel,
    entry: &IntegrationView,
    current_locale: &str,
    access: fn(&mut S) -> Option<&mut Panel>,
) -> El {
    let id = entry.id.clone();
    let about_label = format_template("integrations.info", &[("name", &entry.display_name)]);
    let summary = localized_summary(entry, current_locale);
    let info = (!summary.is_empty()).then(|| {
        let info_id = id.clone();
        chrome::info_tip(
            &about_label,
            summary,
            panel.open_info.as_deref() == Some(entry.id.as_str()),
            move |s: &mut S| {
                if let Some(panel) = access(s) {
                    panel.toggle_info(&info_id);
                }
            },
        )
        .key(format!("integration-info-{id}"))
    });
    let docs = entry.docs.clone().map_or_else(rune::el, |docs| {
        layout::button_tx(t("integrations.docs"), false, move |s: &mut S, tx| {
            if let Some(panel) = access(s) {
                panel.docs_link.open(&docs, tx, move |s| {
                    access(s).map(|panel| &mut panel.docs_link)
                });
            }
        })
        .key(format!("integration-docs-{id}"))
    });
    chrome::setting_row_with_info(&entry.display_name, info, docs)
}

fn confirmation_layer<S: 'static>(
    pending: &PendingConfirm,
    access: fn(&mut S) -> Option<&mut Panel>,
) -> El {
    let (message, confirm_label) = match pending {
        PendingConfirm::CatalogInstall {
            display_name,
            scope,
            ..
        } => {
            let scope_label = t(match scope {
                IntegrationScope::Global => "instanceServiceStatus.plugins.scope.global",
                IntegrationScope::Project => "instanceServiceStatus.plugins.scope.project",
            });
            let mut msg = format_template(
                "integrations.install.confirm",
                &[("name", display_name), ("scope", scope_label)],
            );
            if *scope == IntegrationScope::Project {
                msg.push(' ');
                msg.push_str(t("instanceServiceStatus.plugins.sources.projectWarning"));
            }
            (msg, t("integrations.catalog.install"))
        }
        PendingConfirm::HostInstall {
            display_name,
            app_name,
            version,
            action_key,
            ..
        } => (
            format_template(
                "integrations.installHost.warning",
                &[
                    ("app", app_name),
                    ("name", display_name),
                    ("version", version),
                ],
            ),
            t(action_key),
        ),
    };
    rune_theme_codenomad::document_reader::editor::confirmation(
        layout::dark(),
        &message,
        t("alertDialog.actions.cancel"),
        confirm_label,
        move |s: &mut S, accept, _| {
            if let Some(panel) = access(s) {
                panel.decide_confirm(accept);
            }
        },
    )
}
