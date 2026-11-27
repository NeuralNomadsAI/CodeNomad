use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub(crate) fn provider_change(frame: &Value) -> Option<&str> {
    let id = match frame["type"].as_str()? {
        "instance.eventStatus" if frame["status"] == "connected" => frame["instanceId"].as_str()?,
        "instance.event"
            if matches!(
                frame["event"]["type"].as_str()?,
                "integration.updated"
                    | "credential.updated"
                    | "credential.switched"
                    | "model.updated"
                    | "provider.updated"
                    | "config.updated"
                    | "server.connected"
            ) =>
        {
            frame["instanceId"].as_str()?
        }
        _ => return None,
    };
    valid_id(id).then_some(id)
}

pub(crate) fn mission_catalog_change(frame: &Value) -> Option<&str> {
    let id = match frame["type"].as_str()? {
        "instance.event"
            if matches!(
                frame["event"]["type"].as_str()?,
                "agent.updated" | "plugin.updated" | "models-dev.refreshed"
            ) =>
        {
            frame["instanceId"].as_str()?
        }
        _ => return None,
    };
    valid_id(id).then_some(id)
}

pub struct Provider {
    pub id: String,
    pub name: String,
    pub active: Option<Account>,
}

pub struct Account {
    pub label: String,
    pub environment: bool,
    default_credential: Option<String>,
}

pub async fn providers(
    backend: &Backend,
    workspace: &str,
    session: Option<&str>,
) -> Result<Vec<Provider>> {
    if !valid_id(workspace) || session.is_some_and(|id| !valid_id(id)) {
        return Err("Invalid provider Location".into());
    }
    let base = format!("{}workspaces/{workspace}/instance/api", backend.base);
    let location = if let Some(session) = session {
        Some(super::session_directory(backend, workspace, session).await?)
    } else {
        None
    };
    let directory = location.as_deref();
    let base = base.as_str();
    let load = |kind| async move {
        let mut request = backend.client.get(format!("{base}/{kind}"));
        if let Some(directory) = directory {
            request = request.query(&[("location[directory]", directory)]);
        }
        read_json(request.send().await?.error_for_status()?).await
    };
    use futures_lite::future::zip;
    let ((integrations, providers), (models, search)) = zip(
        zip(load("integration"), load("provider")),
        zip(load("model"), load("websearch/provider")),
    )
    .await;
    let (integrations, providers, models, search) = (integrations?, providers?, models?, search?);
    let received = integrations["location"]["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .ok_or("Invalid provider Location")?;
    if [&providers, &models, &search]
        .iter()
        .any(|response| response["location"]["directory"] != received)
        || directory.is_some_and(|requested| !crate::same_server_path(requested, received))
    {
        return Err("Provider Location changed".into());
    }
    let mut rows = metadata(
        &integrations["data"],
        &providers["data"],
        &models["data"],
        &search["data"],
    )?;
    if rows.iter().any(|row| {
        row.active
            .as_ref()
            .is_some_and(|account| account.default_credential.is_some())
    }) && accounts_available(backend).await
    {
        for row in &mut rows {
            let Some(account) = &mut row.active else {
                continue;
            };
            if let Some(id) = &account.default_credential
                && let Some(email) = account_login(backend, workspace, &row.id, received, id).await
            {
                account.label = email;
            }
        }
    }
    Ok(rows)
}

async fn accounts_available(backend: &Backend) -> bool {
    let Ok(response) = backend
        .client
        .get(format!("{}api/meta", backend.base))
        .send()
        .await
    else {
        return false;
    };
    let Ok(response) = response.error_for_status() else {
        return false;
    };
    read_json(response).await.ok().is_some_and(|meta| {
        meta["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == "integrations"))
    })
}

async fn account_login(
    backend: &Backend,
    workspace: &str,
    integration: &str,
    directory: &str,
    credential: &str,
) -> Option<String> {
    let mut url = reqwest::Url::parse(&format!(
        "{}api/workspaces/{workspace}/provider-accounts",
        backend.base
    ))
    .ok()?;
    url.path_segments_mut().ok()?.push(integration);
    let response = backend
        .client
        .get(url)
        .query(&[("directory", directory)])
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let snapshot = read_json(response).await.ok()?;
    email(&snapshot["logins"][credential])
}

fn email(value: &Value) -> Option<String> {
    let email = value.as_str()?;
    let (local, domain) = email.split_once('@')?;
    let (host, suffix) = domain.rsplit_once('.')?;
    (!local.is_empty()
        && !host.is_empty()
        && !suffix.is_empty()
        && !domain.contains('@')
        && email.encode_utf16().take(255).count() <= 254
        && !email.chars().any(|c| c.is_control() || c.is_whitespace()))
    .then(|| email.to_owned())
}

fn label(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty() && s.chars().take(257).count() <= 256 && !s.contains(char::is_control)
        })
        .map(str::to_owned)
}

fn metadata(
    integrations: &Value,
    providers: &Value,
    models: &Value,
    search: &Value,
) -> Result<Vec<Provider>> {
    let integrations = integrations
        .as_array()
        .filter(|rows| rows.len() <= 2048)
        .ok_or("Invalid integrations")?;
    let providers = providers
        .as_array()
        .filter(|rows| rows.len() <= 2048)
        .ok_or("Invalid providers")?;
    let models: HashSet<_> = models
        .as_array()
        .ok_or("Invalid models")?
        .iter()
        .filter_map(|m| m["providerID"].as_str())
        .collect();
    let search: HashSet<_> = search
        .as_array()
        .ok_or("Invalid search providers")?
        .iter()
        .filter_map(|r| r["id"].as_str())
        .collect();
    let mut with_models = HashSet::new();
    let mut entries = BTreeMap::new();
    for provider in providers {
        let Some(id) = label(&provider["id"]) else {
            continue;
        };
        let key = label(&provider["integrationID"]).unwrap_or_else(|| id.clone());
        if models.contains(id.as_str()) {
            with_models.insert(key.clone());
        }
        entries.entry(key.clone()).or_insert(Provider {
            name: label(&provider["name"]).unwrap_or_else(|| id.clone()),
            id: key,
            active: None,
        });
    }
    for integration in integrations {
        let Some(id) = label(&integration["id"]) else {
            continue;
        };
        let first = integration["connections"]
            .as_array()
            .and_then(|rows| rows.first());
        if first.is_none() && !entries.contains_key(&id) {
            continue;
        }
        let active = first.and_then(|entry| {
            let environment = match entry["type"].as_str()? {
                "env" => true,
                "credential" => false,
                _ => return None,
            };
            let name = label(&entry[if environment { "name" } else { "label" }])?;
            Some(Account {
                default_credential: (!environment && name == "default")
                    .then(|| label(&entry["id"]))
                    .flatten(),
                label: name,
                environment,
            })
        });
        entries.insert(
            id.clone(),
            Provider {
                name: label(&integration["name"]).unwrap_or_else(|| id.clone()),
                id,
                active,
            },
        );
    }
    let mut rows: Vec<_> = entries
        .into_values()
        .filter(|row| !search.contains(row.id.as_str()) || with_models.contains(&row.id))
        .collect();
    rows.sort_by_cached_key(|row| row.name.to_lowercase());
    Ok(rows)
}

#[cfg(test)]
#[test]
fn invalid_primary_label_never_promotes_a_secondary_account() {
    use serde_json::json;
    let rows = metadata(
        &json!([{
            "id":"provider", "connections":[
                {"type":"credential","label":"invalid\nlabel"},
                {"type":"env","name":"SECONDARY","value":"private"}
            ]
        }]),
        &json!([]),
        &json!([]),
        &json!([]),
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].active.is_none());
}

#[cfg(test)]
#[test]
fn models_exclude_search_only_and_account_login_is_display_only() {
    use serde_json::json;
    let rows = metadata(
        &json!([{"id":"search","connections":[{"type":"credential","label":"Search"}]},
            {"id":"both","connections":[{"type":"credential","id":"active","label":"default"}]}]),
        &json!([{"id":"both-models","integrationID":"both"}]),
        &json!([{"id":"model","providerID":"both-models"}]),
        &json!([{"id":"search"},{"id":"both"}]),
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]
            .active
            .as_ref()
            .unwrap()
            .default_credential
            .as_deref(),
        Some("active")
    );
    assert_eq!(
        email(&json!("user@example.test")).as_deref(),
        Some("user@example.test")
    );
    assert!(email(&json!("user@example.test\nhidden")).is_none());
}
