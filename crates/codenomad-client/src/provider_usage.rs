//! Read-only quota snapshots for the selected conversation's provider and model.
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

/// Per-conversation SSE authority, updated before recovery can queue any work.
#[derive(Clone, Debug, Default)]
pub struct Watch(Arc<Mutex<Authority>>);

#[derive(Debug, Default)]
struct Authority {
    generation: u64,
    model_generation: u64,
    online: bool,
    backpressure: bool,
    upstream: Option<(u64, bool)>,
}

impl Watch {
    pub fn current(&self) -> (u64, bool, u64) {
        let authority = self.0.lock().unwrap();
        (
            authority.generation,
            authority.online
                && !authority.backpressure
                && authority.upstream.is_none_or(|(_, connected)| connected),
            authority.model_generation,
        )
    }

    pub(crate) fn transport(&self, online: bool) -> bool {
        let mut authority = self.0.lock().unwrap();
        if authority.online == online {
            return false;
        }
        authority.online = online;
        authority.backpressure = false;
        authority.upstream = None;
        authority.generation += 1;
        true
    }

    fn observe(&self, hint: Hint) -> bool {
        let mut authority = self.0.lock().unwrap();
        match hint {
            Hint::Revoke => {}
            Hint::Model => authority.model_generation += 1,
            Hint::Upstream {
                generation,
                connected,
            } => {
                let status = Some((generation, connected));
                if authority.upstream == status {
                    return false;
                }
                authority.upstream = status;
            }
        }
        authority.generation += 1;
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Hint {
    Revoke,
    Model,
    Upstream { generation: u64, connected: bool },
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(rename = "instanceId")]
    workspace: Option<&'a str>,
    status: Option<&'a str>,
    generation: Option<u64>,
    #[serde(borrow)]
    event: Option<NativeEvent<'a>>,
}

#[derive(Deserialize)]
struct NativeEvent<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(borrow)]
    data: Option<ModelEvent<'a>>,
}

#[derive(Deserialize)]
struct ModelEvent<'a> {
    #[serde(rename = "sessionID")]
    session: Option<&'a str>,
}

#[derive(Clone)]
pub(crate) struct Ingress {
    watch: Watch,
    wake: crate::Wake,
    workspace: String,
    session: String,
}

impl Ingress {
    pub fn new(watch: Watch, wake: crate::Wake, workspace: String, session: String) -> Self {
        Self {
            watch,
            wake,
            workspace,
            session,
        }
    }

    pub fn transport(&self, online: bool) {
        if self.watch.transport(online) {
            (self.wake)();
        }
    }

    pub fn frame(&self, data: &str) {
        // Ignore native payloads in the authority observer; the router decodes them separately.
        let Ok(frame) = serde_json::from_str::<Envelope<'_>>(data) else {
            return;
        };
        if frame.workspace != Some(self.workspace.as_str()) {
            return;
        }
        let change = match frame.kind {
            "instance.eventStatus" => frame.generation.map(|generation| Hint::Upstream {
                generation,
                connected: frame.status == Some("connected"),
            }),
            "instance.event" => frame.event.and_then(|event| match event.kind {
                "credential.updated"
                | "credential.switched"
                | "integration.updated"
                | "config.updated"
                | "server.connected" => Some(Hint::Revoke),
                "session.model.selected"
                    if event.data.and_then(|data| data.session) == Some(self.session.as_str()) =>
                {
                    Some(Hint::Model)
                }
                _ => None,
            }),
            _ => None,
        };
        if let Some(change) = change
            && self.watch.observe(change)
        {
            (self.wake)();
        }
    }

    pub fn skipped(&self) {
        self.watch.observe(Hint::Revoke);
        (self.wake)();
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
    pub reset_at: Option<f64>,
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
    pub reset_at: f64,
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
            // Console can return 1,000 rows with two 256-unit model identifiers each.
            read_json_limited(response, 4 * 1024 * 1024).await?,
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
            .is_some_and(|console| console.models.len() > 1000 || console.budgets.items.len() > 128)
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
        "windows": {"5h": {"usedPercent": 42.5, "resetAt": 1800000000000.0}, "7d":{"resetAt":null}},
    });
    let usage = snapshot(body.clone(), "codex", "example").unwrap();
    assert_eq!(usage.windows["5h"].used_percent, Some(42.5));
    assert_eq!(usage.windows["5h"].reset_at, Some(1800000000000.0));
    assert_eq!(usage.windows["7d"].reset_at, None);
    assert!(snapshot(body.clone(), "openai", "example").is_err());
    assert!(snapshot(body, "codex", "other").is_err());
}

#[cfg(test)]
#[test]
fn console_preserves_counts_at_the_server_model_limit() {
    let body = serde_json::json!({
        "requestedProviderId":"opencode-console", "providerName":"Fixture",
        "supported":true, "configured":true, "ok":true, "windows":{},
        "console": {
            "requests":{"30d":1000},
            "models":vec![serde_json::json!({"provider":"test","model":"example","requests":1}); 1000],
            "budgets":{"status":"unavailable","items":[]}
        }
    });
    let console = snapshot(body, "opencode-console", "")
        .unwrap()
        .console
        .unwrap();
    assert_eq!(console.requests["30d"], 1000);
    assert_eq!(console.models.len(), 1000);
}

#[cfg(test)]
#[test]
fn only_catalogue_churn_is_a_passive_quota_refresh() {
    let watch = Watch::default();
    let ingress = Ingress::new(
        watch.clone(),
        Arc::new(|| {}),
        "project".into(),
        "session".into(),
    );
    ingress.transport(true);
    let native = |workspace, kind| {
        serde_json::json!({
            "type": "instance.event",
            "instanceId": workspace,
            "event": {"type": kind, "location": {"directory": "/fixture/checkout"}},
        })
        .to_string()
    };
    let current = watch.current();
    ingress.frame(&native("project", "provider.updated"));
    ingress.frame(&native("project", "model.updated"));
    ingress.frame(&native("unrelated", "credential.switched"));
    assert_eq!(watch.current(), current);
    for kind in [
        "credential.updated",
        "credential.switched",
        "integration.updated",
        "config.updated",
        "server.connected",
    ] {
        let before = watch.current();
        ingress.frame(&native("project", kind));
        assert_eq!(watch.current(), (before.0 + 1, true, before.2));
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn backpressure(&self, blocked: bool) {
        let mut authority = self.watch.0.lock().unwrap();
        if authority.backpressure != blocked {
            authority.backpressure = blocked;
            authority.generation += 1;
            drop(authority);
            (self.wake)();
        }
    }
    for (session, delta) in [("other", 0), ("session", 1)] {
        let before = watch.current();
        ingress.frame(
            &serde_json::json!({
                "type":"instance.event", "instanceId":"project",
                "event":{"type":"session.model.selected","data":{"sessionID":session}}
            })
            .to_string(),
        );
        assert_eq!(watch.current(), (before.0 + delta, true, before.2 + delta));
    }
}

#[cfg(test)]
#[test]
fn identical_native_status_preserves_authority_but_new_generations_revoke_it() {
    let watch = Watch::default();
    assert!(watch.transport(true));
    let first = Hint::Upstream {
        generation: 7,
        connected: true,
    };
    assert!(watch.observe(first.clone()));
    let current = watch.current();
    assert!(!watch.observe(first));
    assert_eq!(watch.current(), current);
    assert!(watch.observe(Hint::Upstream {
        generation: 8,
        connected: true
    }));
    assert_eq!(watch.current(), (current.0 + 1, true, current.2));
    assert!(watch.transport(false));
    assert!(!watch.current().1);
    let closed = watch.current();
    assert!(watch.observe(Hint::Upstream {
        generation: 9,
        connected: true
    }));
    assert_eq!(watch.current(), (closed.0 + 1, false, closed.2));
}
