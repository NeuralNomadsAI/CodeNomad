#[path = "../../src/platform/collation.rs"]
mod collation;
use codenomad_client::files::{Entry, EntryKind};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn sort_files(input: &str) -> Result<String, JsValue> {
    let rows: Vec<(String, bool, String)> =
        serde_json::from_str(input).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let entries = rows
        .into_iter()
        .map(|(name, directory, path)| Entry {
            name,
            path,
            kind: if directory {
                EntryKind::Directory
            } else {
                EntryKind::File
            },
            absolute_path: None,
            directory_identity: None,
            size: None,
            modified_at: None,
        })
        .collect();
    let collator = collation::Collation::try_default().map_err(|e| JsValue::from_str(&e))?;
    let sorted = collator
        .sort_files(entries)
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(serde_json::json!({"locale":collator.locale(),"paths":sorted.iter().map(|entry|entry.path.as_str()).collect::<Vec<_>>()}).to_string())
}
