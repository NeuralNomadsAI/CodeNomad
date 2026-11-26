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
    publication_waiting: bool,
    upstream: Option<(u64, bool)>,
}

impl Watch {
    pub fn current(&self) -> (u64, bool, u64) {
        self.0.lock().unwrap().stamp()
    }

    /// Publish without racing a newly received invalidation or congestion. The callback
    /// must be synchronous and must not reenter this watch.
    pub fn publish_if_current<T>(
        &self,
        expected: (u64, bool, u64),
        publish: impl FnOnce() -> T,
    ) -> Option<T> {
        let mut authority = self.0.lock().unwrap();
        if !expected.1 || authority.stamp() != expected {
            return None;
        }
        (!authority.wait_for_ingress()).then(publish)
    }

    pub fn backpressured(&self) -> bool {
        self.0.lock().unwrap().wait_for_ingress()
    }

    pub(crate) fn transport(&self, online: bool) -> bool {
        self.0.lock().unwrap().transport(online)
    }

    fn apply_hint(authority: &mut Authority, hint: Hint) -> bool {
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
                authority.model_generation += 1;
            }
        }
        authority.generation += 1;
        true
    }

    fn observe(&self, hint: Hint) -> bool {
        let mut authority = self.0.lock().unwrap();
        Self::apply_hint(&mut authority, hint)
    }
}

impl Authority {
    fn transport(&mut self, online: bool) -> bool {
        if self.online == online {
            return false;
        }
        self.online = online;
        self.backpressure = false;
        self.publication_waiting = false;
        self.upstream = None;
        self.generation += 1;
        if !online {
            self.model_generation += 1;
        }
        true
    }

    fn wait_for_ingress(&mut self) -> bool {
        self.publication_waiting |= self.backpressure;
        self.backpressure
    }

    fn stamp(&self) -> (u64, bool, u64) {
        (
            self.generation,
            self.online && self.upstream.is_none_or(|(_, connected)| connected),
            self.model_generation,
        )
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn congestion_parks_a_ready_quota_reply_without_changing_its_authority() {
    use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
    let watch = Watch::default();
    let wakes = Arc::new(AtomicUsize::new(0));
    let observed = wakes.clone();
    let ingress = Ingress::new(
        watch.clone(),
        Arc::new(move || {
            observed.fetch_add(1, Relaxed);
        }),
        "project".into(),
        "session".into(),
    );
    ingress.transport(true);
    let before = wakes.load(Relaxed);
    let stamp = watch.current();
    let (send, reply) = crate::bounded(1);
    send.try_send(42).unwrap();
    let chunk = ingress.chunk();
    assert_eq!(
        watch.publish_if_current(stamp, || reply.try_recv().unwrap()),
        None
    );
    assert!(!reply.is_empty());
    chunk.finish();
    assert_eq!(wakes.load(Relaxed), before + 1);
    assert_eq!(
        watch.publish_if_current(stamp, || reply.try_recv().unwrap()),
        Some(42)
    );
    ingress.skipped();
    assert_eq!(watch.publish_if_current(stamp, || 42), None);
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

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn abandoning_a_received_chunk_revokes_quota_authority_before_waking() {
    use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
    let watch = Watch::default();
    assert!(watch.transport(true));
    let stamp = watch.current();
    let saw_revocation = Arc::new(AtomicBool::new(false));
    let observed = saw_revocation.clone();
    let during_wake = watch.clone();
    let ingress = Ingress::new(
        watch.clone(),
        Arc::new(move || {
            assert!(!during_wake.current().1);
            assert_eq!(during_wake.publish_if_current(stamp, || 42), None);
            observed.store(true, Relaxed);
        }),
        "project".into(),
        "session".into(),
    );
    let chunk = ingress.chunk();
    assert_eq!(watch.publish_if_current(stamp, || 42), None);
    drop(chunk);
    assert!(saw_revocation.load(Relaxed));
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) struct Chunk<'a>(Option<&'a Ingress>);

#[cfg(all(test, not(target_arch = "wasm32")))]
impl Chunk<'_> {
    pub fn finish(mut self) {
        if let Some(ingress) = self.0.take() {
            let wake = {
                let mut authority = ingress.watch.0.lock().unwrap();
                authority.backpressure = false;
                std::mem::take(&mut authority.publication_waiting)
            };
            if wake {
                (ingress.wake)();
            }
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
impl Drop for Chunk<'_> {
    fn drop(&mut self) {
        if let Some(ingress) = self.0 {
            ingress.transport(false);
        }
    }
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
        if self.transport_quiet(online) {
            self.wake();
        }
    }

    pub(crate) fn transport_quiet(&self, online: bool) -> bool {
        self.watch.transport(online)
    }

    pub(crate) fn wake(&self) {
        (self.wake)();
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub fn chunk(&self) -> Chunk<'_> {
        self.begin_chunk();
        Chunk(Some(self))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn begin_chunk(&self) {
        self.watch.0.lock().unwrap().backpressure = true;
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn finish_chunk_quiet(&self) -> bool {
        let mut authority = self.watch.0.lock().unwrap();
        authority.backpressure = false;
        std::mem::take(&mut authority.publication_waiting)
    }

    #[cfg(test)]
    pub fn frame(&self, data: &str) {
        if self.frame_quiet(data) {
            self.wake();
        }
    }

    fn parse_hint(&self, data: &str) -> Option<Hint> {
        // Ignore native payloads in the authority observer; the router decodes them separately.
        let frame = serde_json::from_str::<Envelope<'_>>(data).ok()?;
        if frame.workspace != Some(self.workspace.as_str()) {
            return None;
        }
        match frame.kind {
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
        }
    }

    pub(crate) fn attach_open_quiet(
        &self,
        replays: &[Arc<(String, String)>],
        overflowed: bool,
        #[cfg_attr(target_arch = "wasm32", allow(unused_variables))] chunk_active: bool,
    ) -> bool {
        let mut authority = self.watch.0.lock().unwrap();
        let mut changed = authority.transport(true);
        for frame in replays {
            if (frame.0.is_empty() || frame.0 == "message")
                && let Some(hint) = self.parse_hint(&frame.1)
            {
                changed |= Watch::apply_hint(&mut authority, hint);
            }
        }
        if overflowed {
            changed |= Watch::apply_hint(&mut authority, Hint::Revoke);
        }
        #[cfg(not(target_arch = "wasm32"))]
        if chunk_active {
            authority.backpressure = true;
        }
        changed
    }

    pub(crate) fn frame_quiet(&self, data: &str) -> bool {
        self.parse_hint(data)
            .is_some_and(|change| self.watch.observe(change))
    }

    #[cfg(test)]
    pub fn skipped(&self) {
        if self.skipped_quiet() {
            self.wake();
        }
    }

    pub(crate) fn skipped_quiet(&self) -> bool {
        self.watch.observe(Hint::Revoke)
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
    assert_eq!(watch.current(), (current.0 + 1, true, current.2 + 1));
    assert!(watch.transport(false));
    assert!(!watch.current().1);
    let closed = watch.current();
    assert!(watch.observe(Hint::Upstream {
        generation: 9,
        connected: true
    }));
    assert_eq!(watch.current(), (closed.0 + 1, false, closed.2 + 1));
}
