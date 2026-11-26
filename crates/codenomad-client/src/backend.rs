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
        let response = self
            .client
            .get(format!("{}api/auth/status", self.base))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?
            .error_for_status()?;
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
                    .header(
                        crate::content::DEFERRED_MEDIA_HEADER,
                        crate::content::DEFERRED_MEDIA_VALUE,
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
                .header(
                    crate::content::DEFERRED_MEDIA_HEADER,
                    crate::content::DEFERRED_MEDIA_VALUE,
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
        self.prompt_with_401(input, false).await
    }

    pub(crate) async fn prompt_with_401(
        &self,
        input: &crate::prompt::Prompt,
        report_wasm_401: bool,
    ) -> Result<crate::prompt::Acknowledgement> {
        let body = crate::prompt::encode(input)?;
        let response = self
            .client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/prompt",
                self.base, self.workspace, self.session
            ))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| crate::prompt::PromptError::Unconfirmed)?;
        if (cfg!(not(target_arch = "wasm32")) || report_wasm_401)
            && response.status() == reqwest::StatusCode::UNAUTHORIZED
        {
            return Err(crate::prompt::PromptError::AuthenticationRequired.into());
        }
        if !response.status().is_success() {
            let error = if response.status().is_client_error() {
                crate::prompt::PromptError::Rejected
            } else {
                crate::prompt::PromptError::Unconfirmed
            };
            return Err(error.into());
        }
        let response = crate::prompt_receipt::read(response)
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
            None | Some(Value::Null) => input.id.as_deref(),
            Some(Value::String(id)) if id.is_empty() => input.id.as_deref(),
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
