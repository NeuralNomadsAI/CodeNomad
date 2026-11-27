use crate::history::{self, Page, Result};
use crate::http::{Http, client_id, endpoint};
use futures_lite::StreamExt;
use reqwest::Response;
use serde_json::{Value, json};
#[derive(Clone)]
pub struct Backend {
    pub client: Http,
    pub base: String,
    pub workspace: String,
    pub session: String,
    pub session_directory: Option<String>,
    pub client_id: String,
    pub fresh_mode: bool,
}
impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CodeNomadConnection")
    }
}
pub(crate) fn percent_encode_header(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(&mut out, "%{byte:02X}");
        }
    }
    out
}

#[cfg(not(target_arch = "wasm32"))]
const PROMPT_UPLOAD_CHUNK: usize = 64 * 1024;

#[cfg(not(target_arch = "wasm32"))]
struct UploadChunks {
    body: Vec<u8>,
    offset: usize,
    progress: std::sync::Arc<tokio::sync::Notify>,
}

#[cfg(not(target_arch = "wasm32"))]
impl futures_lite::Stream for UploadChunks {
    type Item = std::result::Result<Vec<u8>, std::io::Error>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.offset >= self.body.len() {
            return std::task::Poll::Ready(None);
        }
        self.progress.notify_one();
        if self.offset == 0 && self.body.len() <= PROMPT_UPLOAD_CHUNK {
            let chunk = std::mem::take(&mut self.body);
            return std::task::Poll::Ready(Some(Ok(chunk)));
        }
        let start = self.offset;
        let end = (start + PROMPT_UPLOAD_CHUNK).min(self.body.len());
        self.offset = end;
        std::task::Poll::Ready(Some(Ok(self.body[start..end].to_vec())))
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn send_prompt_with_idle_timeout(
    request: reqwest::RequestBuilder,
    idle_timeout: std::time::Duration,
    progress: std::sync::Arc<tokio::sync::Notify>,
) -> std::result::Result<reqwest::Response, crate::prompt::PromptError> {
    enum Step {
        Done(std::result::Result<reqwest::Response, reqwest::Error>),
        Progress,
        Idle,
    }
    let mut send = Box::pin(request.send());
    let mut sleep = Box::pin(tokio::time::sleep(idle_timeout));
    loop {
        match futures_lite::future::or(
            async { Step::Done(send.as_mut().await) },
            futures_lite::future::or(
                async {
                    progress.notified().await;
                    Step::Progress
                },
                async {
                    sleep.as_mut().await;
                    Step::Idle
                },
            ),
        )
        .await
        {
            Step::Done(result) => return result.map_err(|error| send_transport_error(&error)),
            Step::Progress => {
                sleep
                    .as_mut()
                    .reset(tokio::time::Instant::now() + idle_timeout);
            }
            Step::Idle => return Err(crate::prompt::PromptError::Unconfirmed),
        }
    }
}

pub(crate) fn send_transport_error(error: &reqwest::Error) -> crate::prompt::PromptError {
    #[cfg(not(target_arch = "wasm32"))]
    if error.is_connect() || error.is_builder() {
        return crate::prompt::PromptError::Rejected;
    }
    #[cfg(target_arch = "wasm32")]
    if error.is_builder() {
        return crate::prompt::PromptError::Rejected;
    }
    crate::prompt::PromptError::Unconfirmed
}

async fn read_error_body(response: reqwest::Response) -> Result<Value> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        tokio::time::timeout(
            crate::http::REQUEST_TIMEOUT,
            crate::prompt_receipt::read_with_idle_timeout(response, None),
        )
        .await
        .map_err(|_| crate::prompt::PromptError::Unconfirmed)?
    }
    #[cfg(target_arch = "wasm32")]
    {
        crate::prompt_receipt::read(response).await
    }
}

pub(crate) async fn classify_http_error(response: reqwest::Response) -> crate::prompt::PromptError {
    let status = response.status();
    let before_dispatch = response
        .headers()
        .get("x-codenomad-before-dispatch")
        .and_then(|value| value.to_str().ok())
        == Some("1");
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return crate::prompt::PromptError::AuthenticationRequired { before_dispatch };
    }
    if !before_dispatch {
        return crate::prompt::PromptError::Unconfirmed;
    }
    if status.is_client_error() {
        return crate::prompt::PromptError::Rejected;
    }
    match status {
        reqwest::StatusCode::NOT_IMPLEMENTED => {
            if let Ok(body) = read_error_body(response).await
                && body["error"].as_str() == Some("Route not implemented in this prototype")
            {
                return crate::prompt::PromptError::Rejected;
            }
        }
        reqwest::StatusCode::BAD_GATEWAY => {
            if let Ok(body) = read_error_body(response).await
                && matches!(
                    body["error"].as_str(),
                    Some(
                        "session_environment_failed"
                            | "opencode_unavailable_before_send"
                            | "OpenCode service is not ready"
                            | "PROVIDER_ACCOUNT_SELECTION_FAILED"
                    )
                )
            {
                return crate::prompt::PromptError::Rejected;
            }
        }
        reqwest::StatusCode::SERVICE_UNAVAILABLE => {
            if let Ok(body) = read_error_body(response).await
                && matches!(
                    body["error"].as_str(),
                    Some(
                        "Mission schedule carrier ownership could not be verified"
                            | "Conversation permissions unavailable"
                            | "Git ownership could not be verified"
                            | "Session mutation transport is unavailable"
                    )
                )
            {
                return crate::prompt::PromptError::Rejected;
            }
        }
        _ => {}
    }
    crate::prompt::PromptError::Unconfirmed
}

impl Backend {
    pub async fn connect(address: &str, password: &str) -> Result<Self> {
        Self::connect_with_bootstrap(address, password, None).await
    }
    /// Establish the managed child server cookie without storing its one-use token.
    pub async fn connect_with_bootstrap(
        address: &str,
        password: &str,
        bootstrap_token: Option<&str>,
    ) -> Result<Self> {
        let backend = Self::unauthenticated(address)?;
        backend.authenticate(password, bootstrap_token).await?;
        Ok(backend)
    }

    /// Establish a loopback connection seeded with a renewed managed-session cookie.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn connect_with_session_cookie(
        address: &str,
        cookie_name: &str,
        session_id: &str,
    ) -> Result<Self> {
        Ok(Self {
            client: Http::with_session_cookie(address, cookie_name, session_id)?,
            base: endpoint(address)?,
            workspace: String::new(),
            session: String::new(),
            session_directory: None,
            client_id: client_id()?,
            fresh_mode: false,
        })
    }

    pub fn unauthenticated(address: &str) -> Result<Self> {
        Ok(Self {
            client: Http::new()?,
            base: endpoint(address)?,
            workspace: String::new(),
            session: String::new(),
            session_directory: None,
            client_id: client_id()?,
            fresh_mode: false,
        })
    }

    pub async fn authenticate(&self, password: &str, bootstrap_token: Option<&str>) -> Result<()> {
        let base = &self.base;
        let client = &self.client;
        if let Some(token) = bootstrap_token.filter(|v| !v.is_empty()) {
            client
                .post(format!("{base}api/auth/token"))
                .json(&json!({"token":token}))
                .send()
                .await?
                .error_for_status()?;
        }
        if !password.is_empty() {
            self.sign_in("codenomad", password).await?;
        }
        Ok(())
    }
    pub async fn sign_in(&self, username: &str, password: &str) -> Result<()> {
        self.client
            .post(format!("{}api/auth/login", self.base))
            .json(&json!({"username":username,"password":password}))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
    pub async fn authentication_status(&self) -> Result<bool> {
        let request = self
            .client
            .get(format!("{}api/auth/status", self.base))
            .timeout(std::time::Duration::from_secs(5));
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_cache_no_store();
        let response = request.send().await?.error_for_status()?;
        read_json_limited(response, 4096).await?["authenticated"]
            .as_bool()
            .ok_or_else(|| "Invalid authentication status".into())
    }
    pub async fn page(&self, target: Value) -> Result<Page> {
        // Match the broker's window envelope; other endpoints retain their own limits.
        history::decode_target(
            read_json_limited(
                self.client
                    .post(format!(
                        "{}api/workspaces/{}/session-history/window",
                        self.base, self.workspace
                    ))
                    .header(
                        "x-codenomad-user-files",
                        crate::attachments::USER_FILES_REFERENCE,
                    )
                    .json(&json!({"sessionID":self.session,"target":target}))
                    .send()
                    .await?
                    .error_for_status()?,
                history::WINDOW_BYTES,
            )
            .await?,
            &target,
        )
    }
    pub(crate) async fn page_raw_tools(
        &self,
        target: Value,
    ) -> Result<(Vec<(String, Vec<Value>)>, Option<Value>)> {
        let mut v = read_json_limited(
            self.client
                .post(format!(
                    "{}api/workspaces/{}/session-history/window",
                    self.base, self.workspace
                ))
                .header(
                    "x-codenomad-user-files",
                    crate::attachments::USER_FILES_REFERENCE,
                )
                .json(&json!({"sessionID":self.session,"target":target}))
                .send()
                .await?
                .error_for_status()?,
            history::WINDOW_BYTES,
        )
        .await?;
        if v["status"] != "window" {
            return Err("history unavailable or anchor changed".into());
        }
        let newer = history::cursor(&v["newer"], "after")?;
        if v["latest"].as_bool() != Some(newer.is_none()) {
            return Err("inconsistent latest marker".into());
        }
        let rows = v["messages"]
            .as_array_mut()
            .filter(|rows| rows.len() <= 200)
            .ok_or("invalid history window")?;
        let mut out = Vec::new();
        for row in rows.iter_mut() {
            let row_id = row["id"]
                .as_str()
                .filter(|id| history::valid_id(id))
                .ok_or("invalid history row id")?
                .to_owned();
            let Some(parts) = row["content"].as_array_mut() else {
                continue;
            };
            let mut tools = Vec::new();
            for part in parts.iter_mut() {
                if part["type"] == "tool" {
                    let mut raw = std::mem::take(part);
                    if let Some(items) = raw
                        .get_mut("state")
                        .and_then(|state| state.get_mut("content"))
                        .and_then(Value::as_array_mut)
                    {
                        for item in items.iter_mut() {
                            if matches!(item["type"].as_str(), Some("image" | "file"))
                                && let Some(obj) = item.as_object_mut()
                            {
                                obj.remove("data");
                                obj.remove("uri");
                                obj.remove("url");
                            }
                        }
                    }
                    tools.push(raw);
                }
            }
            if !tools.is_empty() {
                out.push((row_id, tools));
            }
        }
        Ok((out, newer))
    }
    pub async fn background(&self) -> Result<()> {
        self.client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/background",
                self.base, self.workspace, self.session
            ))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn empty(&self) -> Result<Page> {
        let page = self.page(json!({"kind":"latest"})).await?;
        if !page.rows.is_empty() {
            return Err("fresh-session mode requires an empty session".into());
        }
        Ok(page)
    }
    pub async fn prompt(
        &self,
        input: &crate::prompt::Prompt,
    ) -> Result<crate::prompt::Acknowledgement> {
        let body = crate::prompt::encode(input)?;
        self.send_encoded_prompt(input.id.as_deref(), body).await
    }
    pub(crate) async fn send_encoded_prompt(
        &self,
        attempted_id: Option<&str>,
        body: Vec<u8>,
    ) -> Result<crate::prompt::Acknowledgement> {
        if self.client.server_identity_mismatch() {
            return Err(crate::prompt::PromptError::Rejected.into());
        }
        let url = format!(
            "{}workspaces/{}/instance/api/session/{}/prompt",
            self.base, self.workspace, self.session
        );
        #[cfg(not(target_arch = "wasm32"))]
        let (response, idle_timeout) = {
            let idle_timeout = self.client.prompt_idle_timeout();
            let progress = std::sync::Arc::new(tokio::sync::Notify::new());
            let length = body.len();
            let mut request = self
                .client
                .post_prompt(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .header(reqwest::header::CONTENT_LENGTH, length)
                .body(reqwest::Body::wrap_stream(UploadChunks {
                    body,
                    offset: 0,
                    progress: progress.clone(),
                }));
            if let Some(directory) = &self.session_directory {
                request = request.query(&[("directory", directory.as_str())]).header(
                    "x-codenomad-session-directory",
                    percent_encode_header(directory),
                );
            }
            let response = send_prompt_with_idle_timeout(request, idle_timeout, progress).await?;
            (response, Some(idle_timeout))
        };
        #[cfg(target_arch = "wasm32")]
        let (response, idle_timeout) = {
            let mut request = self
                .client
                .post_prompt(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
            if let Some(directory) = &self.session_directory {
                request = request.query(&[("directory", directory.as_str())]).header(
                    "x-codenomad-session-directory",
                    percent_encode_header(directory),
                );
            }
            let response = request
                .send()
                .await
                .map_err(|error| send_transport_error(&error))?;
            (response, None)
        };
        if !response.status().is_success() {
            return Err(classify_http_error(response).await.into());
        }
        let response = crate::prompt_receipt::read_with_idle_timeout(response, idle_timeout)
            .await
            .map_err(|_| crate::prompt::PromptError::Unconfirmed)?;
        let native = response.get("data").unwrap_or(&response);
        if !native.is_object() {
            return Err("invalid prompt acknowledgement".into());
        }
        if native
            .get("sessionID")
            .is_some_and(|session| session != &self.session)
        {
            return Err("prompt acknowledgement belongs to another session".into());
        }
        let id = match native.get("id") {
            None | Some(Value::Null) => attempted_id,
            Some(Value::String(id)) if id.is_empty() => attempted_id,
            Some(id) => id.as_str(),
        }
        .filter(|id| history::valid_id(id))
        .ok_or("prompt acknowledgement has no valid identity")?;
        Ok(crate::prompt::Acknowledgement { id: id.into() })
    }
    async fn read_running(&self, page: &mut Page) -> Result<()> {
        let state = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}",
                    self.base, self.workspace, self.session
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let native = state.get("data").unwrap_or(&state);
        if let Some(busy) = native["time"]["busy"].as_f64() {
            page.running = busy > native["time"]["idle"].as_f64().unwrap_or(0.0);
        }
        Ok(())
    }
    pub async fn restore(&self, first: Option<&str>) -> Result<Page> {
        let target = first
            .map(|id| json!({"kind":"around","messageID":id}))
            .unwrap_or(json!({"kind":"latest"}));
        let mut result = self.page(target).await?;
        if let Some(first) = first {
            let index = result
                .rows
                .iter()
                .position(|row| row.id == first)
                .ok_or("resident anchor missing")?;
            let has_older = index > 0 || result.older.is_some();
            result.rows.drain(..index);
            result.older = has_older.then(|| json!({"kind":"before","messageID":first}));
        }
        let mut cursors = std::collections::HashSet::new();
        for _ in 0..16 {
            let Some(target) = result.newer.clone() else {
                self.read_running(&mut result).await?;
                return Ok(result);
            };
            if !cursors.insert(target.to_string()) {
                return Err("history cursor did not advance".into());
            }
            let next = self.page(target).await?;
            let joined = match history::join(&result.rows, &next.rows) {
                Err(error) if error.is::<history::ReasoningLimit>() => {
                    let mut latest = self.page(json!({"kind":"latest"})).await?;
                    self.read_running(&mut latest).await?;
                    return Ok(latest);
                }
                result => result?,
            };
            if joined.len() <= result.rows.len() {
                return Err("history page did not advance".into());
            }
            result.rows = joined;
            result.newer = next.newer;
            result.running = next.running;
            result.user_file_references &= next.user_file_references;
        }
        Err("recovery page budget reached".into())
    }

    pub(crate) async fn reading_window(
        &self,
        target: &crate::recovery::demand::Target,
    ) -> Result<Page> {
        use crate::recovery::demand::Target;
        let request = match target {
            Target::Latest => json!({"kind":"latest"}),
            Target::Around(id) => json!({"kind":"around", "messageID":id}),
        };
        let mut page = match (target, self.page(request).await) {
            (Target::Around(_), Err(error)) if error.is::<history::AnchorMissing>() => {
                self.page(json!({"kind":"latest"})).await?
            }
            (Target::Around(id), Ok(page)) if !page.rows.iter().any(|row| &row.id == id) => {
                return Err("resident anchor missing".into());
            }
            (_, result) => result?,
        };
        self.read_running(&mut page).await?;
        Ok(page)
    }
}
pub async fn read_json(response: Response) -> Result<Value> {
    read_json_limited(response, 2 * 1024 * 1024).await
}
pub(crate) async fn read_json_limited(response: Response, limit: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("oversized response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
