use crate::{
    backend::{Backend, read_json},
    history::{Result, valid_id},
};
use serde_json::Value;

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

pub struct Provider {
    pub id: String,
    pub name: String,
    pub active: Option<Account>,
}

pub struct Account {
    pub label: String,
    pub environment: bool,
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
        let value = read_json(
            backend
                .client
                .get(format!("{base}/session/{session}"))
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        let location = &value["data"]["location"];
        if value["data"]["id"] != session || location.get("workspaceID").is_some() {
            return Err("Invalid provider session Location".into());
        }
        Some(
            location["directory"]
                .as_str()
                .filter(|path| crate::absolute_server_path(path))
                .ok_or("Invalid provider session directory")?
                .to_owned(),
        )
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
    let (integrations, providers) =
        futures_lite::future::zip(load("integration"), load("provider")).await;
    let (integrations, providers) = (integrations?, providers?);
    let received = integrations["location"]["directory"]
        .as_str()
        .filter(|path| crate::absolute_server_path(path))
        .ok_or("Invalid provider Location")?;
    if providers["location"]["directory"] != received
        || directory.is_some_and(|requested| !crate::same_server_path(requested, received))
    {
        return Err("Provider Location changed".into());
    }
    metadata(&integrations["data"], &providers["data"])
}

fn label(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            !s.is_empty() && s.chars().take(257).count() <= 256 && !s.contains(char::is_control)
        })
        .map(str::to_owned)
}

fn metadata(integrations: &Value, providers: &Value) -> Result<Vec<Provider>> {
    let integrations = integrations
        .as_array()
        .filter(|rows| rows.len() <= 2048)
        .ok_or("Invalid integrations")?;
    let providers = providers
        .as_array()
        .filter(|rows| rows.len() <= 2048)
        .ok_or("Invalid providers")?;
    let mut entries = std::collections::BTreeMap::new();
    for provider in providers {
        let Some(id) = label(&provider["id"]) else {
            continue;
        };
        let key = label(&provider["integrationID"]).unwrap_or_else(|| id.clone());
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
            Some(Account {
                label: label(&entry[if environment { "name" } else { "label" }])?,
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
    let mut rows: Vec<_> = entries.into_values().collect();
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
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].active.is_none());
}
