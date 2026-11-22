//! Native prompt fields; mentions use UTF-16 offsets, independently of the editor.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use serde_json::{Map, Value};

pub const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;

pub fn inline_uri(mime: &str, bytes: &[u8]) -> String {
    let mut uri = format!("data:{mime};base64,");
    STANDARD.encode_string(bytes, &mut uri);
    uri
}

pub fn message_id() -> crate::history::Result<String> {
    let mut bytes = [0; 16];
    #[cfg(not(target_arch = "wasm32"))]
    getrandom::fill(&mut bytes).map_err(|_| "message entropy unavailable")?;
    #[cfg(target_arch = "wasm32")]
    web_sys::window()
        .ok_or("browser window required")?
        .crypto()
        .map_err(|_| "browser crypto unavailable")?
        .get_random_values_with_u8_array(&mut bytes)
        .map_err(|_| "message entropy unavailable")?;
    use std::fmt::Write;
    let mut id = String::from("msg_");
    for byte in bytes {
        write!(id, "{byte:02x}")?;
    }
    Ok(id)
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Prompt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<File>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<Agent>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<Skill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<bool>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    Queue,
    Steer,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Mention {
    pub start: usize,
    pub end: usize,
    pub text: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct File {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<FileSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention: Option<Mention>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FileSource {
    Inline,
    Uri { uri: String },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Agent {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention: Option<Mention>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Skill {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention: Option<Mention>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Acknowledgement {
    pub id: String,
}
