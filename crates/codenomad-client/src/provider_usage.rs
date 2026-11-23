//! Read-only quota snapshots for the selected conversation's provider and model.
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Deserialize;
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hint {
    Refresh(Option<String>),
    Revoke,
    Upstream { generation: u64, connected: bool },
}

pub(crate) fn hint(event: &serde_json::Value) -> Option<Hint> {
    match event["type"].as_str()? {
        "instance.eventStatus" => Some(Hint::Upstream {
            generation: event["generation"].as_u64()?,
            connected: event["status"] == "connected",
        }),
        "instance.event" => {
            let native = &event["event"];
            match native["type"].as_str()? {
                "provider.updated" => Some(Hint::Refresh(
                    native["location"]["directory"].as_str().map(str::to_owned),
                )),
                "credential.updated"
                | "credential.switched"
                | "integration.updated"
                | "config.updated"
                | "server.connected" => Some(Hint::Revoke),
                _ => None,
            }
        }
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    requested_provider_id: String,
    model_id: Option<String>,
    pub provider_name: String,
    pub supported: bool,
    pub configured: bool,
    pub ok: bool,
    pub copilot_plan: Option<String>,
    pub windows: BTreeMap<String, Window>,
    pub unavailable_reason: Option<String>,
    pub provider_error_code: Option<String>,
    pub unavailable_action: Option<String>,
    pub free_estimate: Option<Estimate>,
    pub console: Option<Console>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub used_percent: Option<f64>,
    pub reset_at: Option<u64>,
    pub value_label: Option<String>,
    #[serde(rename = "limitUSD")]
    pub limit_usd: Option<f64>,
    #[serde(rename = "balanceUSD")]
    pub balance_usd: Option<Balance>,
    pub consumption: Option<Consumption>,
}

#[derive(Deserialize)]
pub struct Balance {
    pub remaining: f64,
    pub total: Option<f64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Consumption {
    Count {
        used: f64,
        limit: Option<f64>,
    },
    Credits {
        #[serde(rename = "creditsUsed")]
        used: f64,
    },
    Unlimited {
        unlimited: bool,
    },
}

#[derive(Deserialize)]
pub struct Estimate {
    pub requests: Option<u64>,
    pub reference: u64,
}

#[derive(Deserialize)]
pub struct Console {
    pub requests: BTreeMap<String, u64>,
    pub models: Vec<ModelRequests>,
    pub budgets: Budgets,
}

#[derive(Deserialize)]
pub struct ModelRequests {
    pub provider: String,
    pub model: String,
    pub requests: u64,
}

#[derive(Deserialize)]
pub struct Budgets {
    pub status: String,
    pub items: Vec<Budget>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    pub name: String,
    pub spent_usd: f64,
    pub limit_usd: f64,
    pub reset_at: u64,
}

impl Backend {
    pub async fn provider_usage(&self, provider: &str, model: &str) -> Result<Usage> {
        let provider = provider.trim();
        let model = model.trim();
        if !valid_id(&self.workspace)
            || !valid_id(&self.session)
            || matches!(provider, "" | "." | "..")
            || provider.chars().count() > 256
            || model.chars().count() > 256
            || provider.chars().any(char::is_control)
            || model.chars().any(char::is_control)
        {
            return Err("invalid provider usage target".into());
        }
        let mut url = reqwest::Url::parse(&format!("{}api/usage", self.base))?;
        url.path_segments_mut()
            .map_err(|_| "invalid provider usage URL")?
            .push(provider);
        url.query_pairs_mut()
            .append_pair("instanceId", &self.workspace)
            .append_pair("sessionId", &self.session);
        if !model.is_empty() {
            url.query_pairs_mut().append_pair("modelId", model);
        }
        let response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(35))
            .send()
            .await?
            .error_for_status()?;
        snapshot(
            read_json_limited(response, 1024 * 1024).await?,
            provider,
            model,
        )
    }
}

fn snapshot(body: serde_json::Value, provider: &str, model: &str) -> Result<Usage> {
    let usage: Usage = serde_json::from_value(body)?;
    if usage.requested_provider_id != provider
        || usage.model_id.as_deref().unwrap_or_default() != model
        || usage.windows.len() > 128
        || usage
            .console
            .as_ref()
            .is_some_and(|console| console.models.len() > 512 || console.budgets.items.len() > 128)
    {
        return Err("invalid provider usage snapshot".into());
    }
    Ok(usage)
}

#[cfg(test)]
#[test]
fn checks_requested_provider_and_model_even_when_the_provider_alias_is_canonicalized() {
    let body = serde_json::json!({
        "requestedProviderId": "codex", "providerId": "openai", "modelId": "example",
        "providerName": "Fixture", "supported": true, "configured": true, "ok": true,
        "windows": {"5h": {"usedPercent": 42.5, "resetAt": 1800000000000u64}},
    });
    let usage = snapshot(body.clone(), "codex", "example").unwrap();
    assert_eq!(usage.windows["5h"].used_percent, Some(42.5));
    assert!(snapshot(body.clone(), "openai", "example").is_err());
    assert!(snapshot(body, "codex", "other").is_err());
}

#[cfg(test)]
#[test]
fn only_catalogue_churn_is_a_passive_quota_refresh() {
    let native = |kind| {
        serde_json::json!({
            "type": "instance.event",
            "event": {"type": kind, "location": {"directory": "/fixture/checkout"}},
        })
    };
    assert_eq!(
        hint(&native("provider.updated")),
        Some(Hint::Refresh(Some("/fixture/checkout".into())))
    );
    assert_eq!(hint(&native("model.updated")), None);
    for kind in [
        "credential.updated",
        "credential.switched",
        "integration.updated",
        "config.updated",
        "server.connected",
    ] {
        assert_eq!(hint(&native(kind)), Some(Hint::Revoke));
    }
    assert_eq!(
        hint(
            &serde_json::json!({"type":"instance.eventStatus","generation":3,"status":"connected"})
        ),
        Some(Hint::Upstream {
            generation: 3,
            connected: true
        })
    );
}
