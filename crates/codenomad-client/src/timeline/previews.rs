//! Excerpts are a separate bounded read, independent of the transcript and outline.
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;

pub const PREVIEW_BATCH: usize = 12;
const MAX_UNITS: usize = 4096;
const MAX_REPLY: usize = PREVIEW_BATCH * MAX_UNITS * 2 * 6 + 32 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Excerpt {
    pub id: String,
    pub text: String,
    pub tools: String,
}

impl Backend {
    pub async fn outline_previews(&self, ids: &[String]) -> Result<Vec<Excerpt>> {
        let mut expected: HashSet<_> = ids.iter().map(String::as_str).collect();
        if !valid_id(&self.workspace)
            || !valid_id(&self.session)
            || ids.is_empty()
            || ids.len() > PREVIEW_BATCH
            || expected.len() != ids.len()
            || ids.iter().any(|id| !valid_id(id))
        {
            return Err("invalid excerpt scope".into());
        }
        let response = self
            .client
            .post(format!(
                "{}api/workspaces/{}/session-history/outlinePreview",
                self.base, self.workspace,
            ))
            .json(&json!({"sessionID": self.session, "messageIDs": ids}))
            .send()
            .await?
            .error_for_status()?;
        let mut value = read_json_limited(response, MAX_REPLY).await?;
        if value["status"] != "previews" {
            return Err("outline excerpts unavailable".into());
        }
        let entries: Vec<Excerpt> = serde_json::from_value(value["entries"].take())?;
        if entries.len() > ids.len()
            || entries.iter().any(|entry| {
                !expected.remove(entry.id.as_str())
                    || [&entry.text, &entry.tools]
                        .iter()
                        .any(|text| text.encode_utf16().count() > MAX_UNITS)
            })
        {
            return Err("invalid outline excerpts".into());
        }
        Ok(entries)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn reads_only_requested_excerpts_and_rejects_foreign_or_oversized_rows() {
    use super::tests::http_probe;
    for (id, size, accepted) in [
        ("marked", 4096, true),
        ("other", 4, false),
        ("marked", 4097, false),
    ] {
        http_probe(
            vec![(
                "POST /api/workspaces/workspace/session-history/outlinePreview HTTP/1.1",
                Some(json!({"sessionID":"session","messageIDs":["marked"]})),
                json!({"status":"previews","entries":[{"id":id,"text":"x".repeat(size),"tools":""}]}),
                false,
            )],
            async |backend, _| {
                assert_eq!(
                    backend.outline_previews(&["marked".into()]).await.is_ok(),
                    accepted
                );
            },
        );
    }
}
