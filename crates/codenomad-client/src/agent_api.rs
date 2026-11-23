//! Bounded native control contracts. Credentials and model configuration never enter display models.
use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::{Value, json};
use std::time::Duration;
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
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ToolSource {
    pub message: String,
    pub call: String,
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
    pub session_known: bool,
    pub usage: Option<crate::content::Usage>,
    pub running: bool,
    pub permissions: Option<Vec<Permission>>,
    pub forms: Option<Vec<Form>>,
}
pub enum Action {
    Model(Value),
    Permission(String, String, String),
    Answer(String, Value, Vec<Value>),
    Cancel(String),
}
impl Backend {
    fn control_url(&self, path: &str) -> String {
        format!(
            "{}workspaces/{}/instance/api/{path}",
            self.base, self.workspace
        )
    }
    pub async fn control_get(&self, path: &str) -> Result<Value> {
        read_json(
            self.client
                .get(self.control_url(path))
                .timeout(Duration::from_secs(5))
                .send()
                .await?
                .error_for_status()?,
        )
        .await
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
    pub async fn agent_snapshot(&self, catalog: bool) -> Snapshot {
        let session = self.control_get(&format!("session/{}", self.session)).await;
        let current = session
            .as_ref()
            .ok()
            .map(|v| v["data"]["model"].clone())
            .filter(|v| !v.is_null());
        let running = session.as_ref().ok().is_some_and(|v| {
            v["data"]["time"]["busy"].as_f64().unwrap_or(0.0)
                > v["data"]["time"]["idle"].as_f64().unwrap_or(0.0)
        });
        let models = if catalog {
            if let Some(directory) = session
                .as_ref()
                .ok()
                .and_then(|v| v["data"]["location"]["directory"].as_str())
            {
                let response = self
                    .client
                    .get(self.control_url("model"))
                    .query(&[("location[directory]", directory)])
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await;
                match response.and_then(|r| r.error_for_status()) {
                    Ok(response) => read_json(response).await.ok().and_then(|v| models(&v).ok()),
                    Err(_) => None,
                }
            } else {
                None
            }
        } else {
            None
        };
        let permissions = self
            .control_get(&format!("session/{}/permission", self.session))
            .await
            .and_then(|v| permissions(&v, &self.session))
            .ok();
        let forms = self
            .control_get(&format!("session/{}/form", self.session))
            .await
            .and_then(|v| forms(&v, &self.session))
            .ok();
        Snapshot {
            models,
            current,
            session_known: session.is_ok(),
            usage: session
                .as_ref()
                .ok()
                .and_then(|v| crate::content::Usage::decode(&v["data"])),
            running,
            permissions,
            forms,
        }
    }
    pub async fn agent_action(&self, action: &Action) -> Result<()> {
        let path = format!("session/{}", self.session);
        match action {
            Action::Model(reference) => {
                let snapshot = self.agent_snapshot(true).await;
                if !snapshot
                    .models
                    .as_ref()
                    .is_some_and(|rows| rows.iter().any(|m| m.reference == *reference))
                {
                    return Err("model catalogue changed".into());
                }
                self.control_post(&format!("{path}/model"), json!({"model":reference}))
                    .await?;
                let fresh = self.control_get(&path).await?;
                if fresh["data"]["model"] != *reference {
                    return Err("model change is unconfirmed".into());
                }
                Ok(())
            }
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
            tool: tool_source(row),
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
        out.push(Form {
            id,
            title: string(&row["title"], 4096)?,
            fields,
            tool: tool_source(row),
        });
    }
    Ok(out)
}
