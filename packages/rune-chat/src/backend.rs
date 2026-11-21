use crate::history::{self, Page, Result};
use reqwest::blocking::{Client, Response};
use serde_json::{Value, json};
use std::{io::Read, time::Duration};
#[derive(Clone)]
pub struct Backend {
    pub client: Client,
    pub base: String,
    pub workspace: String,
    pub session: String,
    pub client_id: String,
}
impl Backend {
    pub fn environment() -> Result<Self> {
        let base = std::env::var("RUNE_BACKEND")?;
        let url = reqwest::Url::parse(&base)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("explicit loopback endpoint required".into());
        }
        let workspace = std::env::var("RUNE_WORKSPACE")?;
        let session = std::env::var("RUNE_SESSION")?;
        if !history::valid_id(&workspace) || !history::valid_id(&session) {
            return Err("invalid scope".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .cookie_store(true)
            .timeout(Duration::from_secs(30))
            .build()?;
        if let Some(token) = std::env::var("RUNE_BOOTSTRAP_TOKEN")
            .ok()
            .filter(|v| !v.is_empty())
        {
            client
                .post(format!("{base}api/auth/token"))
                .json(&json!({"token":token}))
                .send()?
                .error_for_status()?;
        }
        if let Some(password) = std::env::var("RUNE_PASSWORD")
            .ok()
            .filter(|v| !v.is_empty())
        {
            client
                .post(format!("{base}api/auth/login"))
                .json(&json!({"username":"codenomad","password":password}))
                .send()?
                .error_for_status()?;
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        Ok(Self {
            client,
            base,
            workspace,
            session,
            client_id: format!("rune-{}-{nonce}", std::process::id()),
        })
    }
    pub fn page(&self, target: Value) -> Result<Page> {
        history::decode(read_json(
            self.client
                .post(format!(
                    "{}api/workspaces/{}/session-history/window",
                    self.base, self.workspace
                ))
                .json(&json!({"sessionID":self.session,"target":target}))
                .send()?
                .error_for_status()?,
        )?)
    }
    pub fn empty(&self) -> Result<Page> {
        let initial = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}/message?limit=1",
                    self.base, self.workspace, self.session
                ))
                .send()?
                .error_for_status()?,
        )?;
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
    pub fn send(&self, text: String) -> Result<()> {
        self.client
            .post(format!(
                "{}workspaces/{}/instance/api/session/{}/prompt",
                self.base, self.workspace, self.session
            ))
            .json(&json!({"text":text}))
            .send()?
            .error_for_status()?;
        Ok(())
    }
    /// The explicit fresh-session flow retains at most its first 200 native rows.
    pub fn fresh(&self, first: Option<&str>) -> Result<Page> {
        let data = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}/message?limit=200",
                    self.base, self.workspace, self.session
                ))
                .send()?
                .error_for_status()?,
        )?;
        let native = data["data"]
            .as_array()
            .filter(|rows| rows.len() <= 200)
            .ok_or("fresh session response exceeds its bound")?;
        if first.is_some_and(|first| !native.iter().any(|row| row["id"] == first)) {
            return Err("fresh session retained anchor is outside the native page".into());
        }
        let mut page = history::decode(
            json!({"status":"window","messages":native,"older":null,"newer":null,"latest":true}),
        )?;
        self.read_running(&mut page)?;
        Ok(page)
    }
    fn read_running(&self, page: &mut Page) -> Result<()> {
        let state = read_json(
            self.client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{}",
                    self.base, self.workspace, self.session
                ))
                .send()?
                .error_for_status()?,
        )?;
        let native = state.get("data").unwrap_or(&state);
        if let Some(busy) = native["time"]["busy"].as_f64() {
            page.running = busy > native["time"]["idle"].as_f64().unwrap_or(0.0);
        }
        Ok(())
    }
    pub fn restore(&self, first: Option<&str>) -> Result<Page> {
        let target = first
            .map(|id| json!({"kind":"around","messageID":id}))
            .unwrap_or(json!({"kind":"latest"}));
        let mut result = self.page(target)?;
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
                self.read_running(&mut result)?;
                return Ok(result);
            };
            if !cursors.insert(target.to_string()) {
                return Err("history cursor did not advance".into());
            }
            let next = self.page(target)?;
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
pub fn read_json(response: Response) -> Result<Value> {
    let mut bytes = Vec::new();
    response.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("oversized response".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}
