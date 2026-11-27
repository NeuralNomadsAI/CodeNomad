//! OpenCode integrations RPC contract validation (`opencode/integrations/contract.ts`,
//! `docs-url.ts`, `status.ts:looksLikePath`).
//!
//! Every integration RPC output is read through these strict validators before any value is used;
//! unknown fields are dropped on open outputs (preventing host secrets from crossing HTTP
//! boundaries), while `bindingRead.output` is closed at every level.

use std::{collections::HashSet, sync::LazyLock};

use regex::Regex;
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

use crate::plugin_controls::catalog::{valid_integration_id, valid_range};

pub(crate) const INTEGRATION_SPEC_VERSION: u64 = 0;
pub(crate) const INTEGRATION_CONTRACT_VERSION: u64 = 1;
pub(crate) const INTEGRATION_MAX_OFFERS: usize = 16;
pub(crate) const INTEGRATION_ATTACHMENT_METADATA_KEY: &str = "codenomad.integrationAttachment";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

static DRIVE_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^\p{L}\p{N}])\p{L}:").expect("valid drive regex"));
static HOME_PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[\s\u{feff}])~").expect("valid home regex"));
static SEMVER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")
        .expect("valid semver regex")
});

/// Display strings that resemble a filesystem path (separator, drive letter or home `~`).
pub(crate) fn looks_like_path(value: &str) -> bool {
    value.contains('/') || value.contains('\\') || DRIVE_PATH_RE.is_match(value) || HOME_PATH_RE.is_match(value)
}

/// Reviewed documentation link of an integration (`docs-url.ts`).
pub(crate) fn is_integration_docs_url(value: &str, integration: Option<&str>) -> bool {
    const TREE: &str = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/";
    const BLOB: &str = "https://github.com/NeuralNomadsAI/opencode-integrations/blob/main/integrations/";
    const README: &str = "/plugin/README.md";

    let matched = if let Some(id) = value.strip_prefix(TREE) {
        Some((id, format!("/NeuralNomadsAI/opencode-integrations/tree/main/integrations/{id}")))
    } else if let Some(rest) = value.strip_prefix(BLOB) {
        rest.strip_suffix(README)
            .map(|id| (id, format!("/NeuralNomadsAI/opencode-integrations/blob/main/integrations/{id}{README}")))
    } else {
        None
    };

    let Some((id, expected_path)) = matched else {
        return false;
    };
    if !valid_integration_id(id) || integration.is_some_and(|expected| expected != id) {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == expected_path
        && url.as_str() == value
}

pub(crate) fn valid_offer_id(value: &str) -> bool {
    (8..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn valid_session_id_pattern(value: &str) -> bool {
    (1..=128).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub(crate) fn valid_native_session_id(value: &str) -> bool {
    value.starts_with("ses") && valid_session_id_pattern(value)
}

fn valid_semver(value: &str) -> bool {
    value.chars().count() <= 64 && SEMVER_RE.is_match(value)
}

fn valid_display(value: &str, max_code_points: usize) -> bool {
    let cp = value.chars().count();
    (1..=max_code_points).contains(&cp) && !value.chars().any(|c| c == '/' || c == '\\' || c.is_control())
}

fn valid_notice(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..].iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

fn parse_u64_range(value: &Value, min: u64, max: u64) -> Option<u64> {
    let n = value.as_f64()?;
    if !n.is_finite() || n.fract() != 0.0 || n < (min as f64) || n > (max as f64) {
        return None;
    }
    Some(n as u64)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationStatusHost {
    pub(crate) state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) part_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expected_range: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IntegrationStatusConnection {
    pub(crate) state: String,
    pub(crate) offers: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IntegrationStatusOutput {
    pub(crate) id: String,
    pub(crate) version: String,
    pub(crate) family: String,
    pub(crate) host: Option<IntegrationStatusHost>,
    pub(crate) connection: Option<IntegrationStatusConnection>,
    pub(crate) notices: Option<Vec<String>>,
}

pub(crate) fn parse_status_output(value: &Value) -> Option<IntegrationStatusOutput> {
    let obj = value.as_object()?;
    if parse_u64_range(obj.get("contract")?, INTEGRATION_CONTRACT_VERSION, INTEGRATION_CONTRACT_VERSION).is_none() {
        return None;
    }
    let integration = obj.get("integration")?.as_object()?;
    let id = integration.get("id")?.as_str().filter(|s| valid_integration_id(s))?.to_owned();
    let version = integration.get("version")?.as_str().filter(|s| valid_semver(s))?.to_owned();
    let family =
        integration.get("family")?.as_str().filter(|s| matches!(*s, "native" | "vendor-mcp" | "api"))?.to_owned();
    if parse_u64_range(integration.get("spec")?, INTEGRATION_SPEC_VERSION, INTEGRATION_SPEC_VERSION).is_none() {
        return None;
    }

    let host = match obj.get("host") {
        None => None,
        Some(raw) => {
            let h = raw.as_object()?;
            let state = h
                .get("state")?
                .as_str()
                .filter(|s| matches!(*s, "absent" | "incompatible" | "outdated" | "ok" | "unknown" | "unsupported"))?
                .to_owned();
            let part_version = match h.get("partVersion") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| valid_semver(s))?.to_owned()),
            };
            let expected_range = match h.get("expectedRange") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| valid_range(s))?.to_owned()),
            };
            let app_version = match h.get("appVersion") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| valid_display(s, 64))?.to_owned()),
            };
            let action = match h.get("action") {
                None => None,
                Some(v) => Some(v.as_str().filter(|s| matches!(*s, "install" | "update"))?.to_owned()),
            };
            Some(IntegrationStatusHost { state, part_version, expected_range, app_version, action })
        }
    };

    let connection = match obj.get("connection") {
        None => None,
        Some(raw) => {
            let c = raw.as_object()?;
            let state = c
                .get("state")?
                .as_str()
                .filter(|s| matches!(*s, "none" | "available" | "attached" | "connected" | "signed_out" | "error"))?
                .to_owned();
            let offers = match c.get("offers") {
                None => None,
                Some(v) => Some(parse_u64_range(v, 0, INTEGRATION_MAX_OFFERS as u64)?),
            };
            if let Some(attached) = c.get("attachedSessions") {
                parse_u64_range(attached, 0, 10_000)?;
            }
            Some(IntegrationStatusConnection { state, offers })
        }
    };

    let notices = match obj.get("notices") {
        None => None,
        Some(raw) => {
            let arr = raw.as_array()?;
            if arr.len() > 8 {
                return None;
            }
            let mut seen = HashSet::with_capacity(arr.len());
            let mut list = Vec::with_capacity(arr.len());
            for item in arr {
                let s = item.as_str().filter(|n| valid_notice(n))?;
                if !seen.insert(s) {
                    return None;
                }
                list.push(s.to_owned());
            }
            Some(list)
        }
    };

    Some(IntegrationStatusOutput { id, version, family, host, connection, notices })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntegrationHostOffer {
    #[serde(rename = "offerID")]
    pub(crate) offer_id: String,
    pub(crate) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) document: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_version: Option<String>,
    pub(crate) protocol: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct IntegrationHostsOutput {
    pub(crate) offers: Vec<IntegrationHostOffer>,
}

pub(crate) fn parse_hosts_output(value: &Value) -> Option<IntegrationHostsOutput> {
    let obj = value.as_object()?;
    let raw_offers = obj.get("offers")?.as_array()?;
    if raw_offers.len() > INTEGRATION_MAX_OFFERS {
        return None;
    }
    let mut offers = Vec::with_capacity(raw_offers.len());
    for raw in raw_offers {
        let item = raw.as_object()?;
        let offer_id = item.get("offerID")?.as_str().filter(|s| valid_offer_id(s))?.to_owned();
        let label = item.get("label")?.as_str().filter(|s| valid_display(s, 120))?.to_owned();
        let document = match item.get("document") {
            None => None,
            Some(v) => Some(v.as_str().filter(|s| valid_display(s, 120))?.to_owned()),
        };
        let app_version = match item.get("appVersion") {
            None => None,
            Some(v) => Some(v.as_str().filter(|s| valid_display(s, 64))?.to_owned()),
        };
        let protocol = item.get("protocol")?.as_str().filter(|s| matches!(*s, "ok" | "incompatible"))?.to_owned();
        offers.push(IntegrationHostOffer { offer_id, label, document, app_version, protocol });
    }
    Some(IntegrationHostsOutput { offers })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InstallHostOutput {
    pub(crate) outcome: String,
    pub(crate) detail: Option<String>,
}

pub(crate) fn parse_install_host_output(value: &Value) -> Option<InstallHostOutput> {
    let obj = value.as_object()?;
    let outcome = obj
        .get("outcome")?
        .as_str()
        .filter(|s| matches!(*s, "installed" | "updated" | "unchanged" | "refused" | "failed"))?
        .to_owned();
    let detail = match obj.get("detail") {
        None => None,
        Some(v) => Some(v.as_str().filter(|s| valid_display(s, 300))?.to_owned()),
    };
    Some(InstallHostOutput { outcome, detail })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct OutcomeOutput {
    pub(crate) outcome: &'static str,
}

pub(crate) fn parse_attach_host_output(value: &Value) -> Option<OutcomeOutput> {
    let obj = value.as_object()?;
    let outcome = match obj.get("outcome")?.as_str()? {
        "attached" => "attached",
        "busy" => "busy",
        "gone" => "gone",
        "refused" => "refused",
        _ => return None,
    };
    Some(OutcomeOutput { outcome })
}

pub(crate) fn parse_detach_host_output(value: &Value) -> Option<OutcomeOutput> {
    let obj = value.as_object()?;
    let outcome = match obj.get("outcome")?.as_str()? {
        "detached" => "detached",
        "none" => "none",
        _ => return None,
    };
    Some(OutcomeOutput { outcome })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum BindingReadOutput {
    Attached { label: String },
    None,
    Unknown,
}

fn validate_binding_authority(value: &Value) -> bool {
    let Some(obj) = value.as_object() else { return false };
    if obj.len() != 3 {
        return false;
    }
    let Some(service_gen) = obj.get("serviceGeneration").and_then(Value::as_str) else { return false };
    let Some(registry_gen) = obj.get("registryGeneration").and_then(Value::as_str) else { return false };
    let Some(rev) = obj.get("revision") else { return false };
    valid_session_id_pattern(service_gen)
        && valid_session_id_pattern(registry_gen)
        && parse_u64_range(rev, 0, MAX_SAFE_INTEGER).is_some()
}

/// Strict closed parser for `bindingRead.output` (`rpc.schema.json`).
pub(crate) fn parse_binding_read_output(value: &Value) -> Option<BindingReadOutput> {
    let obj = value.as_object()?;
    match obj.get("state")?.as_str()? {
        "attached" => {
            if obj.len() != 3 {
                return None;
            }
            if !validate_binding_authority(obj.get("authority")?) {
                return None;
            }
            let binding = obj.get("binding")?.as_object()?;
            if binding.len() != 2 {
                return None;
            }
            let _offer_id = binding.get("offerID")?.as_str().filter(|s| valid_offer_id(s))?;
            let label = binding.get("label")?.as_str().filter(|s| valid_display(s, 120))?.to_owned();
            Some(BindingReadOutput::Attached { label })
        }
        "none" => {
            if obj.len() != 2 || !validate_binding_authority(obj.get("authority")?) {
                return None;
            }
            Some(BindingReadOutput::None)
        }
        "unknown" => match obj.len() {
            1 => Some(BindingReadOutput::Unknown),
            2 => {
                if !validate_binding_authority(obj.get("authority")?) {
                    return None;
                }
                Some(BindingReadOutput::Unknown)
            }
            _ => None,
        },
        _ => None,
    }
}
