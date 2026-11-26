//! Bounded native control contracts. Credentials and model configuration never enter display models.
use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::{Value, json};
use std::time::Duration;

const CONTROL_READ_BUDGET: Duration = Duration::from_secs(15);
#[derive(Clone, PartialEq)]
pub struct Model {
    pub reference: Value,
    pub label: String,
    pub included: bool,
}
#[derive(Clone)]
pub struct Permission {
    pub id: String,
    pub action: String,
    pub resources: Vec<String>,
    pub message: String,
    pub supported: bool,
    pub tool: Option<ToolSource>,
}
#[derive(Clone)]
pub struct Form {
    pub id: String,
    pub title: String,
    pub fields: Vec<Value>,
    pub tool: Option<ToolSource>,
    pub infer_websearch: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ToolSource {
    pub message: String,
    pub call: String,
}

fn target(message: &Value, call: &Value) -> Option<ToolSource> {
    let id = |value: &Value| value.as_str().filter(|id| valid_id(id)).map(str::to_owned);
    Some(ToolSource {
        message: id(message)?,
        call: id(call)?,
    })
}

fn tool_source(row: &Value) -> Option<ToolSource> {
    let source = &row["source"];
    if source["type"] != "tool" {
        return None;
    }
    let (message, call) = (source["messageID"].as_str()?, source["id"].as_str()?);
    if !valid_id(message) || call.is_empty() || call.len() > 512 {
        return None;
    }
    Some(ToolSource {
        message: message.into(),
        call: call.into(),
    })
}
pub struct Snapshot {
    pub models: Option<Vec<Model>>,
    pub current: Option<Value>,
    pub directory: Option<String>,
    pub session_known: bool,
    pub usage: Option<crate::content::Usage>,
    pub running: bool,
    pub root_directory: Option<String>,
    pub permissions: Option<Vec<Permission>>,
    pub forms: Option<Vec<Form>>,
}

/// Metadata from the session read already made by the interruption dock.
fn root_directory(session: &Value, id: &str) -> Option<String> {
    let row = &session["data"];
    if row["id"] != id || !row["parentID"].is_null() {
        return None;
    }
    row["location"]["directory"]
        .as_str()
        .filter(|path| {
            crate::absolute_server_path(path) && row["location"]["workspaceID"].is_null()
        })
        .map(str::to_owned)
}
pub enum Action {
    Model(Value),
    Permission(String, String, String),
    Answer(String, Value, Vec<Value>),
    Cancel(String),
}
impl Backend {
    pub async fn notification_label(&self) -> Option<String> {
        if !valid_id(&self.session) || self.session.starts_with("ses_cn_schedule_") {
            return None;
        }
        let project = self
            .projects()
            .await
            .ok()?
            .into_iter()
            .find(|project| project.id == self.workspace)?;
        let session = self.bind_root_session(&project, &self.session).await.ok()?;
        let title = session.title.trim();
        Some(
            if title.is_empty() {
                self.session.as_str()
            } else {
                title
            }
            .chars()
            .take(256)
            .collect(),
        )
    }

    pub async fn notification_session(&self, pending: Option<(bool, &str)>) -> Option<String> {
        self.notification_session_within(pending, CONTROL_READ_BUDGET)
            .await
    }

    async fn notification_session_within(
        &self,
        pending: Option<(bool, &str)>,
        budget: Duration,
    ) -> Option<String> {
        if !valid_id(&self.session) || self.session.starts_with("ses_cn_schedule_") {
            return None;
        }
        let deadline = crate::runtime::Instant::now() + budget;
        let path = format!("session/{}", self.session);
        let record = self.control_get_within(&path, budget).await.ok()?;
        let directory = root_directory(&record, &self.session)?;
        let remaining = deadline.saturating_duration_since(crate::runtime::Instant::now());
        let present = match pending {
            Some((true, id)) => forms(
                &self
                    .control_get_within(&format!("{path}/form"), remaining)
                    .await
                    .ok()?,
                &self.session,
            )
            .ok()?
            .iter()
            .any(|form| form.id == id),
            Some((false, id)) => permissions(
                &self
                    .control_get_within(&format!("{path}/permission"), remaining)
                    .await
                    .ok()?,
                &self.session,
            )
            .ok()?
            .iter()
            .any(|permission| permission.id == id),
            None => self.session_inactive_at_within(&directory, remaining).await,
        };
        present.then(|| {
            record["data"]["title"]
                .as_str()
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(&self.session)
                .chars()
                .take(256)
                .collect()
        })
    }

    fn control_url(&self, path: &str) -> String {
        format!(
            "{}workspaces/{}/instance/api/{path}",
            self.base, self.workspace
        )
    }
    async fn control_get_within(&self, path: &str, timeout: Duration) -> Result<Value> {
        if timeout.is_zero() {
            return Err("control read timed out".into());
        }
        read_json(
            self.client
                .get(self.control_url(path))
                .timeout(timeout)
                .send()
                .await?
                .error_for_status()?,
        )
        .await
    }
    pub async fn control_get(&self, path: &str) -> Result<Value> {
        self.control_get_within(path, CONTROL_READ_BUDGET).await
    }
    pub async fn session_inactive_at(&self, directory: &str) -> bool {
        self.session_inactive_at_within(directory, CONTROL_READ_BUDGET)
            .await
    }
    async fn session_inactive_at_within(&self, directory: &str, budget: Duration) -> bool {
        if !crate::absolute_server_path(directory) {
            return false;
        }
        let deadline = crate::runtime::Instant::now() + budget;
        let Ok(response) = self
            .client
            .get(self.control_url("session/active"))
            .query(&[("directory", directory)])
            .timeout(budget)
            .send()
            .await
            .and_then(|r| r.error_for_status())
        else {
            return false;
        };
        if !read_json(response).await.ok().is_some_and(|value| {
            value["data"]
                .as_object()
                .is_some_and(|active| !active.contains_key(&self.session))
        }) {
            return false;
        }
        // The relay can omit a member it could not scope during the active-list read.
        let remaining = deadline.saturating_duration_since(crate::runtime::Instant::now());
        let Ok(record) = self
            .control_get_within(&format!("session/{}", self.session), remaining)
            .await
        else {
            return false;
        };
        let time = &record["data"]["time"];
        root_directory(&record, &self.session)
            .as_deref()
            .is_some_and(|current| crate::same_server_path(current, directory))
            && matches!((time["busy"].as_u64(), time["idle"].as_u64()), (Some(busy), Some(idle)) if busy <= idle)
    }
    async fn control_post(&self, path: &str, input: Value) -> Result<()> {
        self.client
            .post(self.control_url(path))
            .json(&input)
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
    pub async fn model_catalog(&self, directory: &str) -> Option<Vec<Model>> {
        self.model_catalog_within(directory, CONTROL_READ_BUDGET)
            .await
    }
    async fn model_catalog_within(&self, directory: &str, timeout: Duration) -> Option<Vec<Model>> {
        if timeout.is_zero() {
            return None;
        }
        let response = self
            .client
            .get(self.control_url("model"))
            .query(&[("location[directory]", directory)])
            .timeout(timeout)
            .send()
            .await;
        match response.and_then(|r| r.error_for_status()) {
            Ok(response) => read_json(response).await.ok().and_then(|v| models(&v).ok()),
            Err(_) => None,
        }
    }
    fn decode_session_snapshot(
        &self,
        session: &Result<Value>,
        models: Option<Vec<Model>>,
        permissions: Option<Vec<Permission>>,
        forms: Option<Vec<Form>>,
    ) -> (Snapshot, Option<String>) {
        let current = session
            .as_ref()
            .ok()
            .map(|v| v["data"]["model"].clone())
            .filter(|v| !v.is_null());
        let raw_directory = session
            .as_ref()
            .ok()
            .and_then(|v| v["data"]["location"]["directory"].as_str())
            .map(str::to_owned);
        let running = session.as_ref().ok().is_some_and(|v| {
            v["data"]["time"]["busy"].as_f64().unwrap_or(0.0)
                > v["data"]["time"]["idle"].as_f64().unwrap_or(0.0)
        });
        let snapshot = Snapshot {
            models,
            current,
            directory: raw_directory
                .as_deref()
                .filter(|directory| crate::absolute_server_path(directory))
                .map(str::to_owned),
            session_known: session.is_ok(),
            usage: session
                .as_ref()
                .ok()
                .and_then(|v| crate::content::Usage::decode(&v["data"])),
            running,
            root_directory: session
                .as_ref()
                .ok()
                .and_then(|row| root_directory(row, &self.session)),
            permissions,
            forms,
        };
        (snapshot, raw_directory)
    }
    pub async fn session_snapshot(&self) -> (Snapshot, Option<String>) {
        let session = self.control_get(&format!("session/{}", self.session)).await;
        self.decode_session_snapshot(&session, None, None, None)
    }
    pub async fn permissions_snapshot(&self) -> Option<Vec<Permission>> {
        self.control_get(&format!("session/{}/permission", self.session))
            .await
            .and_then(|v| permissions(&v, &self.session))
            .ok()
    }
    pub async fn forms_snapshot(&self) -> Option<Vec<Form>> {
        self.control_get(&format!("session/{}/form", self.session))
            .await
            .and_then(|v| forms(&v, &self.session))
            .ok()
    }
    async fn action_model_within(
        &self,
        reference: &Value,
        budget: Duration,
    ) -> Result<(Snapshot, Option<String>)> {
        let path = format!("session/{}", self.session);
        let deadline = crate::runtime::Instant::now() + budget;
        let session = self
            .control_get_within(&path, budget)
            .await
            .map_err(|_| "model catalogue changed")?;
        let directory = session["data"]["location"]["directory"]
            .as_str()
            .ok_or("model catalogue changed")?;
        let remaining = deadline.saturating_duration_since(crate::runtime::Instant::now());
        let rows = self
            .model_catalog_within(directory, remaining)
            .await
            .ok_or("model catalogue changed")?;
        if !rows.iter().any(|m| m.reference == *reference) {
            return Err("model catalogue changed".into());
        }
        self.control_post(&format!("{path}/model"), json!({"model":reference}))
            .await?;
        let fresh = self.control_get(&path).await?;
        if fresh["data"]["model"] != *reference {
            return Err("model change is unconfirmed".into());
        }
        Ok(self.decode_session_snapshot(&Ok(fresh), None, None, None))
    }
    pub async fn apply_model(&self, reference: &Value) -> Result<(Snapshot, Option<String>)> {
        self.action_model_within(reference, CONTROL_READ_BUDGET)
            .await
    }
    pub async fn agent_action(&self, action: &Action) -> Result<()> {
        let path = format!("session/{}", self.session);
        match action {
            Action::Model(reference) => self.apply_model(reference).await.map(|_| ()),
            Action::Permission(id, decision, message) => {
                let pending = permissions(
                    &self.control_get(&format!("{path}/permission")).await?,
                    &self.session,
                )?;
                if !pending.iter().any(|p| p.id == *id) {
                    return Err("permission is no longer pending".into());
                }
                if !matches!(decision.as_str(), "once" | "always" | "reject")
                    || message.encode_utf16().count() > 4096
                {
                    return Err("invalid permission reply".into());
                }
                self.control_post(
                    &format!("{path}/permission/{id}/reply"),
                    json!({"decision":decision,"message":message}),
                )
                .await
            }
            Action::Answer(id, answer, fields) => {
                let pending = forms(
                    &self.control_get(&format!("{path}/form")).await?,
                    &self.session,
                )?;
                if !pending.iter().any(|f| f.id == *id && f.fields == *fields) {
                    return Err("question changed".into());
                }
                self.control_post(&format!("{path}/form/{id}/reply"), json!({"answer":answer}))
                    .await
            }
            Action::Cancel(id) => {
                let pending = forms(
                    &self.control_get(&format!("{path}/form")).await?,
                    &self.session,
                )?;
                if !pending.iter().any(|f| f.id == *id) {
                    return Err("question is no longer pending".into());
                }
                self.client
                    .delete(self.control_url(&format!("{path}/form/{id}")))
                    .timeout(Duration::from_secs(10))
                    .send()
                    .await?
                    .error_for_status()?;
                Ok(())
            }
        }
    }
    pub async fn interrupt(&self) -> Result<()> {
        self.control_post(
            &format!("session/{}/interrupt", self.session),
            json!({"resume":false}),
        )
        .await
    }
}
fn string(value: &Value, max: usize) -> Result<String> {
    value
        .as_str()
        .filter(|s| s.len() <= max)
        .map(str::to_string)
        .ok_or_else(|| "invalid control string".into())
}
pub fn models(value: &Value) -> Result<Vec<Model>> {
    let rows = value["data"]
        .as_array()
        .filter(|v| v.len() <= 2048)
        .ok_or("invalid model catalogue")?;
    let mut out = vec![];
    for row in rows.iter().filter(|r| r["enabled"] == true) {
        let id = string(&row["id"], 512)?;
        let provider = string(&row["providerID"], 256)?;
        let name = string(&row["name"], 512)?;
        if id.is_empty() || provider.is_empty() {
            return Err("empty model identity".into());
        }
        let cost = &row["cost"][0];
        let included = cost["input"].as_f64() == Some(0.0) && cost["output"].as_f64() == Some(0.0);
        out.push(Model {
            reference: json!({"id":id,"providerID":provider}),
            label: format!("{provider} · {name}"),
            included,
        });
        if let Some(variants) = row["variants"].as_array().filter(|v| v.len() <= 32) {
            for variant in variants {
                let v = string(&variant["id"], 256)?;
                out.push(Model {
                    reference: json!({"id":id,"providerID":provider,"variant":v}),
                    label: format!("{provider} · {name} · {v}"),
                    included,
                });
            }
        }
        if out.len() > 4096 {
            return Err("model catalogue bound reached".into());
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|m| seen.insert(m.reference.to_string()));
    Ok(out)
}
fn rows(value: &Value) -> Result<&Vec<Value>> {
    value["data"]
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or_else(|| "pending request bound reached".into())
}
pub fn permissions(value: &Value, session: &str) -> Result<Vec<Permission>> {
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for row in rows(value)? {
        if row["sessionID"] != session {
            return Err("foreign permission".into());
        }
        let id = string(&row["id"], 256)?;
        if !valid_id(&id) || !seen.insert(id.clone()) {
            return Err("invalid permission identity".into());
        }
        let resources = row["resources"]
            .as_array()
            .ok_or("invalid permission resources")?;
        out.push(Permission {
            id,
            action: string(&row["action"], 4096)?,
            resources: resources
                .iter()
                .take(64)
                .map(|v| string(v, 4096))
                .collect::<Result<Vec<_>>>()?,
            message: row["message"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .take(4096)
                .collect(),
            supported: resources.len() <= 64,
            tool: target(
                &row["source"]["messageID"],
                row.get("partID")
                    .or_else(|| row.get("partId"))
                    .or_else(|| row["metadata"].get("partID"))
                    .or_else(|| row["metadata"].get("partId"))
                    .unwrap_or(&row["source"]["id"]),
            )
            .or_else(|| tool_source(row)),
        });
    }
    Ok(out)
}
pub fn forms(value: &Value, session: &str) -> Result<Vec<Form>> {
    let mut out = vec![];
    let mut seen = std::collections::HashSet::new();
    for row in rows(value)? {
        if row["sessionID"] != session {
            return Err("foreign question".into());
        }
        let id = string(&row["id"], 256)?;
        if !valid_id(&id) || !seen.insert(id.clone()) {
            return Err("invalid question identity".into());
        }
        let fields = row["fields"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 32)
            .ok_or("invalid question fields")?
            .clone();
        let metadata = &row["metadata"];
        let source = metadata
            .get("tool")
            .filter(|v| v.is_object())
            .or_else(|| metadata.get("source").filter(|v| v.is_object()))
            .unwrap_or(&Value::Null);
        let explicit = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| source.get(*key))
                .or_else(|| {
                    keys.iter()
                        .filter(|key| **key != "id")
                        .find_map(|key| metadata.get(*key))
                })
                .unwrap_or(&Value::Null)
        };
        let tool = target(
            explicit(&["messageID", "messageId"]),
            explicit(&["id", "callID", "callId"]),
        )
        .or_else(|| tool_source(row));
        out.push(Form {
            id,
            title: string(&row["title"], 4096)?,
            fields,
            infer_websearch: tool.is_none() && metadata["kind"] == "websearch.provider",
            tool,
        });
    }
    Ok(out)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    fn test_backend(addr: std::net::SocketAddr, session: &str) -> Backend {
        let mut backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
        backend.workspace = "ws1".into();
        backend.session = session.into();
        backend.session_directory = Some("/repo".into());
        backend
    }

    struct StopGate {
        stopped: Mutex<bool>,
        changed: Condvar,
    }

    impl StopGate {
        fn new() -> Self {
            Self {
                stopped: Mutex::new(false),
                changed: Condvar::new(),
            }
        }
        fn wait(&self, timeout: Duration) {
            let guard = self.stopped.lock().unwrap();
            if !*guard {
                let _ = self.changed.wait_timeout_while(guard, timeout, |s| !*s);
            }
        }
        fn stop(&self) {
            *self.stopped.lock().unwrap() = true;
            self.changed.notify_all();
        }
    }

    fn read_http_request_line(stream: &mut TcpStream) -> Option<String> {
        let mut bytes = Vec::with_capacity(512);
        let mut chunk = [0u8; 512];
        while !bytes.windows(4).any(|w| w == b"\r\n\r\n") && bytes.len() < 16_384 {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => bytes.extend_from_slice(&chunk[..n]),
            }
        }
        if bytes.is_empty() {
            return None;
        }
        String::from_utf8_lossy(&bytes)
            .lines()
            .next()
            .map(str::to_owned)
    }

    struct TestServer {
        addr: std::net::SocketAddr,
        stop: Arc<AtomicBool>,
        gate: Arc<StopGate>,
        accept_thread: Option<std::thread::JoinHandle<()>>,
        workers: Arc<Mutex<Vec<std::thread::JoinHandle<()>>>>,
    }

    impl TestServer {
        fn spawn(handler: impl Fn(String, &StopGate) -> String + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let stop_accept = stop.clone();
            let gate = Arc::new(StopGate::new());
            let gate_accept = gate.clone();
            let handler = Arc::new(handler);
            let workers = Arc::new(Mutex::new(Vec::new()));
            let workers_accept = workers.clone();
            let accept_thread = std::thread::spawn(move || {
                while !stop_accept.load(Ordering::SeqCst) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        break;
                    };
                    if stop_accept.load(Ordering::SeqCst) {
                        break;
                    }
                    let handler = handler.clone();
                    let gate = gate_accept.clone();
                    let worker = std::thread::spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let Some(line) = read_http_request_line(&mut stream) else {
                            return;
                        };
                        let body = handler(line, &gate);
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                    });
                    workers_accept.lock().unwrap().push(worker);
                }
            });
            Self {
                addr,
                stop,
                gate,
                accept_thread: Some(accept_thread),
                workers,
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.gate.stop();
            let _ = TcpStream::connect(self.addr);
            if let Some(handle) = self.accept_thread.take() {
                let _ = handle.join();
            }
            let workers = std::mem::take(&mut *self.workers.lock().unwrap());
            for worker in workers {
                let _ = worker.join();
            }
        }
    }

    #[test]
    fn session_inactive_at_enforces_shared_budget_across_active_and_session_reads() {
        let session_requested = Arc::new(AtomicBool::new(false));
        let session_requested_srv = session_requested.clone();
        let server = TestServer::spawn(move |line, gate| {
            if line.contains("/session/active?") {
                // Consume more than half of the 900 ms shared budget.
                gate.wait(Duration::from_millis(500));
                r#"{"data":{}}"#.into()
            } else if line.contains("/session/ses_idle HTTP") {
                session_requested_srv.store(true, Ordering::SeqCst);
                // Reply with a valid idle root session after 700 ms: longer than the remaining
                // ~400 ms shared budget, but shorter than a fresh 900 ms budget.
                gate.wait(Duration::from_millis(700));
                r#"{"data":{"id":"ses_idle","location":{"directory":"/repo"},"time":{"busy":1,"idle":2}}}"#.into()
            } else {
                r#"{"data":{}}"#.into()
            }
        });
        let backend = test_backend(server.addr, "ses_idle");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let inactive =
            rt.block_on(backend.session_inactive_at_within("/repo", Duration::from_millis(900)));
        assert!(
            session_requested.load(Ordering::SeqCst),
            "GET /session/{{id}} must be dispatched after GET /session/active"
        );
        assert!(
            !inactive,
            "session verification exceeding the remaining shared deadline must time out instead of receiving a fresh budget"
        );
    }

    #[test]
    fn model_action_enforces_shared_budget_across_session_and_catalog() {
        let model_requested = Arc::new(AtomicBool::new(false));
        let post_requested = Arc::new(AtomicBool::new(false));
        let current_model = Arc::new(Mutex::new("m0".to_owned()));
        let session_reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let model_requested_srv = model_requested.clone();
        let post_requested_srv = post_requested.clone();
        let current_model_srv = current_model.clone();
        let session_reads_srv = session_reads.clone();
        let server = TestServer::spawn(move |line, gate| {
            if line.starts_with("GET ") && line.contains("/session/ses_m_budget HTTP") {
                if session_reads_srv.fetch_add(1, Ordering::SeqCst) == 0 {
                    gate.wait(Duration::from_millis(500));
                }
                let model = current_model_srv.lock().unwrap().clone();
                format!(
                    r#"{{"data":{{"id":"ses_m_budget","location":{{"directory":"/repo"}},"model":{{"id":"{model}","providerID":"p1"}},"time":{{"busy":0,"idle":1}}}}}}"#
                )
            } else if line.starts_with("GET ") && line.contains("/api/model?") {
                model_requested_srv.store(true, Ordering::SeqCst);
                // Reply with a matching model after 700 ms: exceeds the remaining ~400 ms shared
                // deadline under a 900 ms budget, but succeeds under a fresh 900 ms or 2000 ms budget.
                gate.wait(Duration::from_millis(700));
                r#"{"data":[{"id":"m1","providerID":"p1","name":"Model 1","enabled":true,"cost":[{"input":0,"output":0}]}]}"#.into()
            } else if line.starts_with("POST ") && line.contains("/session/ses_m_budget/model HTTP")
            {
                post_requested_srv.store(true, Ordering::SeqCst);
                *current_model_srv.lock().unwrap() = "m1".into();
                r#"{"ok":true}"#.into()
            } else {
                r#"{"ok":true}"#.into()
            }
        });
        let backend = test_backend(server.addr, "ses_m_budget");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(backend.action_model_within(
            &json!({"id":"m1","providerID":"p1"}),
            Duration::from_millis(900),
        ));
        assert!(
            model_requested.load(Ordering::SeqCst),
            "GET /api/model must be dispatched during Action::Model precondition check"
        );
        assert!(
            !post_requested.load(Ordering::SeqCst),
            "POST /model must never be dispatched when GET /api/model exceeds the shared deadline"
        );
        assert!(
            result.is_err(),
            "model catalog exceeding the remaining shared deadline must fail Action::Model"
        );

        // Positive control with the exact same server delays (500 ms + 700 ms = 1200 ms) under a
        // sufficient 2000 ms shared budget: proves POST + confirmation succeed when budget suffices.
        model_requested.store(false, Ordering::SeqCst);
        session_reads.store(0, Ordering::SeqCst);
        let (confirmed, _) = rt
            .block_on(backend.action_model_within(
                &json!({"id":"m1","providerID":"p1"}),
                Duration::from_millis(2000),
            ))
            .expect("Action::Model must succeed when the shared budget covers session + catalog");
        assert!(model_requested.load(Ordering::SeqCst));
        assert!(post_requested.load(Ordering::SeqCst));
        assert_eq!(*current_model.lock().unwrap(), "m1");
        assert_eq!(
            confirmed.current,
            Some(json!({"id":"m1","providerID":"p1"}))
        );
    }

    #[test]
    fn notification_session_enforces_shared_budget_across_session_and_pending_read() {
        let form_requested = Arc::new(AtomicBool::new(false));
        let form_requested_srv = form_requested.clone();
        let server = TestServer::spawn(move |line, gate| {
            if line.contains("/session/ses_notif/form") {
                form_requested_srv.store(true, Ordering::SeqCst);
                gate.wait(Duration::from_millis(700));
                r#"{"data":[{"id":"form_1","sessionID":"ses_notif","title":"Q","fields":[{"id":"q1","label":"Proceed?","type":"text"}]}]}"#
                    .into()
            } else if line.contains("/session/ses_notif HTTP") {
                gate.wait(Duration::from_millis(500));
                r#"{"data":{"id":"ses_notif","title":"Notify","location":{"directory":"/repo"}}}"#
                    .into()
            } else {
                r#"{"data":[]}"#.into()
            }
        });
        let backend = test_backend(server.addr, "ses_notif");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let timed_out = rt.block_on(
            backend.notification_session_within(Some((true, "form_1")), Duration::from_millis(900)),
        );
        assert!(form_requested.load(Ordering::SeqCst));
        assert!(
            timed_out.is_none(),
            "pending read exceeding remaining shared budget must fail notification_session"
        );
        let ok = rt.block_on(
            backend
                .notification_session_within(Some((true, "form_1")), Duration::from_millis(2000)),
        );
        assert_eq!(ok.as_deref(), Some("Notify"));
    }

    #[test]
    fn permissions_and_forms_snapshots_read_only_their_own_endpoint() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_srv = seen.clone();
        let server = TestServer::spawn(move |line, _| {
            seen_srv.lock().unwrap().push(line.clone());
            if line.contains("/session/ses_split/permission") {
                r#"{"data":[{"id":"perm_1","sessionID":"ses_split","action":"bash","resources":["git status"]}]}"#.into()
            } else if line.contains("/session/ses_split/form") {
                r#"{"data":[{"id":"form_1","sessionID":"ses_split","title":"Confirm","fields":[{"id":"q1","label":"Proceed?","type":"text"}]}]}"#.into()
            } else {
                r#"{"data":[]}"#.into()
            }
        });
        let backend = test_backend(server.addr, "ses_split");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let perms = rt.block_on(backend.permissions_snapshot()).unwrap();
        assert_eq!(perms.len(), 1);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(seen.lock().unwrap()[0].contains("/session/ses_split/permission"));
        let forms = rt.block_on(backend.forms_snapshot()).unwrap();
        assert_eq!(forms.len(), 1);
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert!(seen.lock().unwrap()[1].contains("/session/ses_split/form"));
    }

    #[test]
    fn model_action_checks_only_session_and_models_without_permission_or_form_reads() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_server = seen.clone();
        let current_model = Arc::new(Mutex::new("m0".to_owned()));
        let current_model_server = current_model.clone();
        let server = TestServer::spawn(move |line, _| {
            seen_server.lock().unwrap().push(line.clone());
            if line.starts_with("GET ") && line.contains("/api/model?") {
                r#"{"data":[{"id":"m1","providerID":"p1","name":"Model 1","enabled":true,"cost":[{"input":0,"output":0}]}]}"#.into()
            } else if line.starts_with("POST ") && line.contains("/session/ses_m/model") {
                *current_model_server.lock().unwrap() = "m1".into();
                r#"{"ok":true}"#.into()
            } else {
                let model = current_model_server.lock().unwrap().clone();
                format!(
                    r#"{{"data":{{"id":"ses_m","location":{{"directory":"/repo"}},"model":{{"id":"{model}","providerID":"p1"}},"time":{{"busy":0,"idle":1}}}}}}"#
                )
            }
        });
        let backend = test_backend(server.addr, "ses_m");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(backend.agent_action(&Action::Model(json!({"id":"m1","providerID":"p1"}))))
            .unwrap();
        drop(server);
        assert_eq!(*current_model.lock().unwrap(), "m1");
        let requests = seen.lock().unwrap().clone();
        assert_eq!(
            requests.len(),
            4,
            "exact 4-step Action::Model sequence: {requests:?}"
        );
        assert!(requests[0].starts_with("GET ") && requests[0].contains("/session/ses_m HTTP"));
        assert!(requests[1].starts_with("GET ") && requests[1].contains("/api/model?"));
        assert!(
            requests[2].starts_with("POST ") && requests[2].contains("/session/ses_m/model HTTP")
        );
        assert!(requests[3].starts_with("GET ") && requests[3].contains("/session/ses_m HTTP"));
        assert!(
            requests
                .iter()
                .all(|line| !line.contains("/permission") && !line.contains("/form")),
            "Action::Model must not read unrelated permission or form endpoints: {requests:?}"
        );
    }
}
