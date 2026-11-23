use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) const REFERENCE: &str = "reference-v1";
pub(super) const FILE_BYTES: usize = 8 * 1024 * 1024;
pub(super) const FILE_COUNT: usize = 128;

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(super) fn inline(value: &Value) -> Option<Vec<u8>> {
    let value = value.as_str()?;
    if value.len() > FILE_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = STANDARD.decode(value).ok()?;
    (bytes.len() <= FILE_BYTES).then_some(bytes)
}

pub(super) fn validate_window(output: &mut Value) -> bool {
    let Some(root) = output.as_object_mut() else { return false };
    if root.remove("userFiles").as_ref().and_then(Value::as_str) != Some(REFERENCE) {
        return false;
    }
    let Some(messages) = root.get("messages").and_then(Value::as_array) else { return false };
    messages.iter().filter(|message| message["type"] == "user").all(|message| {
        message.get("files").is_none_or(|files| {
            files.as_array().is_some_and(|files| {
                files.len() <= FILE_COUNT
                    && files.iter().all(|file| {
                        file.as_object().is_some_and(|file| {
                            file.keys().all(|key| matches!(key.as_str(), "name" | "mime" | "source"))
                                && file.get("name").is_none_or(|name| name.as_str().is_some())
                                && file.get("mime").and_then(Value::as_str).is_some_and(|mime| !mime.is_empty())
                                && file.get("source").and_then(Value::as_object).is_some_and(|source| {
                                    match source.get("type").and_then(Value::as_str) {
                                        Some("unavailable") => source.len() == 1,
                                        Some("deferred") => {
                                            source.len() == 2
                                                && source
                                                    .get("sha256")
                                                    .and_then(Value::as_str)
                                                    .is_some_and(valid_digest)
                                        }
                                        _ => false,
                                    }
                                })
                        })
                    })
            })
        })
    })
}

pub(crate) fn projected_event(value: &Value) -> Option<Value> {
    if value["type"] != "instance.event" || value["event"]["type"] != "session.inbox.enqueued" {
        return None;
    }
    let item = &value["event"]["data"]["item"];
    if item["type"] != "user" {
        return None;
    }
    let files = item["payload"]["files"].as_array()?;
    let labels = files
        .iter()
        .take(FILE_COUNT)
        .map(|file| {
            let name = file["name"].as_str().and_then(|name| name.rsplit(['/', '\\']).next()).filter(|s| !s.is_empty());
            let mime = file["mime"].as_str().filter(|s| !s.is_empty()).unwrap_or("application/octet-stream");
            let source = inline(&file["data"]).map_or_else(
                || json!({"type":"unavailable"}),
                |bytes| json!({"type":"deferred","sha256":digest(&bytes)}),
            );
            let mut label = json!({"mime": mime.chars().take(256).collect::<String>(), "source": source});
            if let Some(name) = name {
                label["name"] = name.chars().take(1024).collect::<String>().into();
            }
            label
        })
        .collect();
    let mut projected = value.clone();
    projected["event"]["data"]["item"]["payload"]["files"] = Value::Array(labels);
    Some(projected)
}
