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
        let base = endpoint(address)?;
        let client = Http::new()?;
        if let Some(token) = bootstrap_token.filter(|v| !v.is_empty()) {
            client
                .post(format!("{base}api/auth/token"))
                .json(&json!({"token":token}))
                .send()
                .await?
                .error_for_status()?;
        }
        if !password.is_empty() {
            client
                .post(format!("{base}api/auth/login"))
                .json(&json!({"username":"codenomad","password":password}))
                .send()
                .await?
                .error_for_status()?;
        }
        Ok(Self {
            client,
            base,
            workspace: String::new(),
            session: String::new(),
            client_id: client_id()?,
            fresh_mode: false,
        })
    }
    pub async fn page(&self, target: Value) -> Result<Page> {
        // Match the broker's window envelope; other endpoints retain their own limits.
        const HISTORY_WINDOW_BYTES: usize = 24 * 1024 * 1024;
        history::decode(
            read_json_limited(
                self.client
                    .post(format!(
                        "{}api/workspaces/{}/session-history/window",
                        self.base, self.workspace
                    ))
                    .json(&json!({"sessionID":self.session,"target":target}))
                    .send()
                    .await?
                    .error_for_status()?,
                HISTORY_WINDOW_BYTES,
            )
            .await?,
        )
    }
    pub async fn empty(&self) -> Result<Page> {
        let initial = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}/message?limit=1",
                    self.base, self.workspace, self.session
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        if !initial["data"]
            .as_array()
            .is_some_and(|rows| rows.is_empty())
        {
            return Err("fresh-session mode requires an empty session".into());
        }
        Ok(Page {
            rows: vec![],
            older: None,
            newer: None,
            running: false,
        })
    }
    pub async fn send(&self, text: String) -> Result<()> {
        self.client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/prompt",
                self.base, self.workspace, self.session
            ))
            .json(&json!({"text":text}))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
    /// The explicit fresh-session flow retains at most its first 200 native rows.
    pub async fn fresh(&self, first: Option<&str>) -> Result<Page> {
        let data = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}/message?limit=200&order=asc",
                    self.base, self.workspace, self.session
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let native = data["data"]
            .as_array()
            .filter(|rows| rows.len() <= 200)
            .ok_or("fresh session response exceeds its bound")?;
        // Native cursors also anchor future reads; their presence alone is not evidence of another page.
        let latest = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}/message?limit=1",
                    self.base, self.workspace, self.session
                ))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let tail = latest["data"]
            .as_array()
            .filter(|rows| rows.len() <= 1)
            .ok_or("invalid latest message")?;
        if native.last().map(|r| &r["id"]) != tail.first().map(|r| &r["id"]) {
            return Err("fresh session retained history exceeds its bound or changed".into());
        }
        if first.is_some_and(|first| !native.iter().any(|row| row["id"] == first)) {
            return Err("fresh session retained anchor is outside the native page".into());
        }
        let mut page = history::decode(
            json!({"status":"window","messages":native,"older":null,"newer":null,"latest":true}),
        )?;
        self.read_running(&mut page).await?;
        Ok(page)
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
            let joined = history::join(&result.rows, &next.rows)?;
            if joined.len() <= result.rows.len() {
                return Err("history page did not advance".into());
            }
            result.rows = joined;
            result.newer = next.newer;
            result.running = next.running;
        }
        Err("recovery page budget reached".into())
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
