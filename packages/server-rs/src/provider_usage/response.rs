//! HTTP display model for a provider quota read.
use serde_json::{Value, json};

use super::{Provider, google, shared::Quota};

fn name(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}
fn model_key(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    let id = lower.strip_prefix("models/").unwrap_or(&lower);
    id.split(|c: char| !c.is_ascii_alphanumeric()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-")
}
pub(super) fn public(
    requested: &str,
    model: Option<&str>,
    provider: Option<&Provider>,
    name_label: &str,
    data: Quota,
    stamp: u64,
) -> Value {
    let mut body = json!({
        "requestedProviderId": requested, "providerId": provider.map(|p| p.id), "providerName":name_label,
        "configured":data.as_ref().map_or_else(|f| f.configured, |_| true), "supported":provider.is_some(),
        "ok":data.is_ok(), "fetchedAt":stamp, "windows":{},
    });
    if let Some(model) = model {
        body["modelId"] = json!(model);
    }
    match data {
        Ok(mut u) => {
            if provider.is_some_and(|p| p.id == "google") {
                for (id, values) in u.models {
                    if model.is_none_or(|m| m.is_empty() || google::model(m) == Some(&id)) {
                        u.windows.extend(values.into_iter().map(|(k, v)| (format!("{k}:{id}"), v)));
                    }
                }
            } else if let Some(model) = model.filter(|s| !s.is_empty()) {
                let key = model_key(model);
                let select = u.models.iter().find(|(id, _)| model_key(name(id)) == key).or_else(|| {
                    u.models.iter().find(|(id, _)| {
                        let m = model_key(name(id));
                        m.contains(&key) || key.contains(&m)
                    })
                });
                if let Some((id, values)) = select {
                    if u.windows.is_empty() {
                        u.windows = values.clone();
                    } else {
                        u.windows.extend(values.iter().map(|(k, v)| (format!("{k}:{}", name(id)), v.clone())));
                    }
                }
            }
            body["windows"] = json!(u.windows);
            if let Some(at) = u.at {
                body["fetchedAt"] = json!(at);
            }
            body.as_object_mut().unwrap().extend(u.extra);
        }
        Err(f) => {
            if let Some(reason) = f.reason {
                body["unavailableReason"] = json!(reason);
            }
            if let Some(code) = f.code {
                body["providerErrorCode"] = json!(code);
            }
            match f.reason {
                Some("openai-token-sharing-unsupported") => body["unavailableAction"] = json!("chatgpt-usage"),
                Some("opencode-go-key-expired") => body["unavailableAction"] = json!("opencode-go-new-key"),
                _ => {}
            }
        }
    }
    body
}
