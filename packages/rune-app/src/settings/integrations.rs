//! Preferences -> Integrations: catalog, host installation and per-session document attachment.
mod state;
#[cfg(test)]
mod tests;
mod view;

pub(super) use state::Panel;
pub(super) use view::view;

use crate::strings::t;
use codenomad_client::settings::integrations::{
    BindingState, ConnectionState, HostAction, HostOffer, HostState, IntegrationFamily,
    IntegrationView, RuntimeState,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum RowAction {
    InstallHost,
    UpdateHost,
    Attach(Option<String>),
    Detach,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct StateLine {
    pub text: String,
    pub warning: bool,
    pub action: Option<RowAction>,
}

pub(super) fn format_template(key: &'static str, vars: &[(&str, &str)]) -> String {
    let mut out = t(key).to_owned();
    for (name, value) in vars {
        let placeholder = format!("{{{name}}}");
        out = out.replace(&placeholder, value);
    }
    out
}

pub(super) fn localized_summary<'a>(entry: &'a IntegrationView, locale: &str) -> &'a str {
    if let Some(text) = entry.summary.get(locale) {
        return text;
    }
    if let Some((base, _)) = locale.split_once('-')
        && let Some(text) = entry.summary.get(base)
    {
        return text;
    }
    entry
        .summary
        .get("en")
        .or_else(|| entry.summary.values().next())
        .map_or("", String::as_str)
}

pub(super) fn offer_document(offer: &HostOffer) -> &str {
    offer.document.as_deref().unwrap_or(&offer.label)
}

pub(super) fn host_action_key(entry: &IntegrationView) -> Option<&'static str> {
    if entry.family != IntegrationFamily::Native || entry.state != RuntimeState::Ok {
        return None;
    }
    let status = entry.status.as_ref()?;
    let host = status.host.as_ref()?;
    if host.state == HostState::Unsupported || status.version.is_empty() {
        return None;
    }
    Some(match host.action {
        Some(HostAction::Install) => "integrations.installHost.install",
        Some(HostAction::Update) => "integrations.installHost.update",
        None => "integrations.installHost.reinstall",
    })
}

pub(super) fn family_label(family: IntegrationFamily) -> &'static str {
    t(match family {
        IntegrationFamily::Native => "integrations.catalog.family.native",
        IntegrationFamily::VendorMcp => "integrations.catalog.family.vendor-mcp",
        IntegrationFamily::Api => "integrations.catalog.family.api",
    })
}

pub(super) fn connection_text(entry: &IntegrationView) -> String {
    let app = entry.app.name.as_str();
    if entry.state != RuntimeState::Ok {
        return t("integrations.connection.unknown").to_owned();
    }
    let connection = entry.status.as_ref().and_then(|s| s.connection.as_ref());
    match entry.family {
        IntegrationFamily::Native => {
            let host = entry
                .status
                .as_ref()
                .and_then(|s| s.host.as_ref())
                .map(|h| h.state);
            if host == Some(HostState::Unsupported) {
                return t("integrations.connection.unsupported").to_owned();
            }
            let offers = connection.and_then(|c| c.offers).unwrap_or(0);
            if offers == 1 {
                format_template("integrations.connection.offers.one", &[("app", app)])
            } else if offers > 1 {
                let count = offers.to_string();
                format_template(
                    "integrations.connection.offers.other",
                    &[("app", app), ("count", &count)],
                )
            } else if host == Some(HostState::Unknown) {
                format_template("integrations.connection.hostClosed", &[("app", app)])
            } else {
                format_template("integrations.connection.noOffer", &[("app", app)])
            }
        }
        IntegrationFamily::VendorMcp => {
            if connection.and_then(|c| c.state) == Some(ConnectionState::Connected) {
                t("integrations.connection.detected").to_owned()
            } else {
                t("integrations.connection.absent").to_owned()
            }
        }
        IntegrationFamily::Api => {
            if connection.and_then(|c| c.state) == Some(ConnectionState::Connected) {
                t("integrations.connection.connected").to_owned()
            } else {
                t("integrations.connection.disconnected").to_owned()
            }
        }
    }
}

pub(super) fn state_line(
    entry: &IntegrationView,
    binding: Option<&BindingState>,
    offers: Option<&[HostOffer]>,
    has_session: bool,
    can_install_host: bool,
) -> StateLine {
    let app = entry.app.name.as_str();
    if entry.state != RuntimeState::Ok {
        let (key, warning) = match entry.state {
            RuntimeState::Inactive => ("integrations.line.inactive", false),
            RuntimeState::Failed => ("integrations.line.failed", true),
            RuntimeState::NonConforming => ("integrations.state.nonConforming", true),
            RuntimeState::Unsupported => ("integrations.line.unsupported", false),
            RuntimeState::Absent | RuntimeState::Unknown | RuntimeState::Ok => {
                ("integrations.line.unknown", false)
            }
        };
        return StateLine {
            text: t(key).to_owned(),
            warning,
            action: None,
        };
    }
    if entry.family != IntegrationFamily::Native {
        return StateLine {
            text: connection_text(entry),
            warning: false,
            action: None,
        };
    }
    let host = entry
        .status
        .as_ref()
        .and_then(|s| s.host.as_ref())
        .map(|h| h.state);
    match host {
        Some(HostState::Unsupported) => {
            return StateLine {
                text: t("integrations.line.unsupported").to_owned(),
                warning: false,
                action: None,
            };
        }
        Some(HostState::Absent) => {
            return if can_install_host {
                StateLine {
                    text: format_template("integrations.line.install", &[("app", app)]),
                    warning: false,
                    action: Some(RowAction::InstallHost),
                }
            } else {
                StateLine {
                    text: format_template("integrations.attention.hostAbsent", &[("app", app)]),
                    warning: false,
                    action: None,
                }
            };
        }
        Some(HostState::Outdated) => {
            return if can_install_host {
                StateLine {
                    text: format_template("integrations.line.update", &[("app", app)]),
                    warning: false,
                    action: Some(RowAction::UpdateHost),
                }
            } else {
                StateLine {
                    text: format_template("integrations.attention.hostOutdated", &[("app", app)]),
                    warning: false,
                    action: None,
                }
            };
        }
        Some(HostState::Incompatible) => {
            return StateLine {
                text: format_template("integrations.attention.incompatible", &[("app", app)]),
                warning: true,
                action: None,
            };
        }
        _ => {}
    }
    if let Some(BindingState::Attached(label)) = binding {
        let document = offers
            .and_then(|list| list.iter().find(|item| item.label == *label))
            .map_or(label.as_str(), offer_document);
        return StateLine {
            text: format_template("integrations.line.attached", &[("document", document)]),
            warning: false,
            action: Some(RowAction::Detach),
        };
    }
    if host == Some(HostState::Unknown) {
        return StateLine {
            text: format_template("integrations.connection.hostClosed", &[("app", app)]),
            warning: false,
            action: None,
        };
    }
    let offer_count = entry
        .status
        .as_ref()
        .and_then(|s| s.connection.as_ref())
        .and_then(|c| c.offers)
        .unwrap_or(0);
    if offer_count == 0 {
        return StateLine {
            text: format_template("integrations.connection.noOffer", &[("app", app)]),
            warning: false,
            action: None,
        };
    }
    if !has_session {
        return StateLine {
            text: t("integrations.link.noConversation").to_owned(),
            warning: false,
            action: None,
        };
    }
    if let Some(list) = offers {
        let compatible: Vec<_> = list.iter().filter(|item| item.protocol_ok).collect();
        if compatible.is_empty() {
            return StateLine {
                text: format_template("integrations.connection.noOffer", &[("app", app)]),
                warning: false,
                action: None,
            };
        }
        if compatible.len() == 1 {
            let only = compatible[0];
            return StateLine {
                text: format_template(
                    "integrations.line.attachOne",
                    &[("document", offer_document(only))],
                ),
                warning: false,
                action: Some(RowAction::Attach(Some(only.offer_id.clone()))),
            };
        }
    }
    StateLine {
        text: t("integrations.line.attachMany").to_owned(),
        warning: false,
        action: Some(RowAction::Attach(None)),
    }
}

pub(super) fn catalog_date(fetched_at: Option<&str>) -> Option<&str> {
    let raw = fetched_at?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.split_once('T').map_or(raw, |(date, _)| date))
}
