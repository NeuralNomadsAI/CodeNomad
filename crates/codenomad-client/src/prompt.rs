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

#[derive(Debug)]
pub(crate) struct EncodeError(String);
impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for EncodeError {}

pub(crate) fn encode(input: &Prompt) -> Result<Vec<u8>, EncodeError> {
    encode_limited(input, MAX_BODY_BYTES).map_err(|error| EncodeError(error.to_string()))
}

fn encode_limited(input: &Prompt, limit: usize) -> crate::history::Result<Vec<u8>> {
    struct Body(Vec<u8>, usize);
    impl std::io::Write for Body {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let new_len = self.0.len().saturating_add(bytes.len());
            if new_len > self.1 {
                return Err(std::io::Error::other(
                    "prompt request body exceeds its bound",
                ));
            }
            if new_len > self.0.capacity() {
                let capacity = new_len.max(self.0.capacity().saturating_mul(2)).min(self.1);
                self.0.reserve_exact(capacity - self.0.len());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut body = Body(Vec::new(), limit);
    serde_json::to_writer(&mut body, input)?;
    Ok(body.0)
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptError {
    Rejected,
    Unconfirmed,
    AuthenticationRequired { before_dispatch: bool },
}
impl std::fmt::Display for PromptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected => f.write_str("prompt was rejected"),
            Self::Unconfirmed => f.write_str("prompt receipt is unconfirmed"),
            Self::AuthenticationRequired { .. } => f.write_str("prompt requires authentication"),
        }
    }
}
impl std::error::Error for PromptError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaped_text_counts_against_the_serialization_budget() {
        let input = Prompt {
            text: "\0".repeat(12),
            ..Prompt::default()
        };
        let plain = serde_json::to_vec(&input).unwrap();
        assert!(plain.len() > input.text.len() * 6);
        assert_eq!(encode_limited(&input, plain.len()).unwrap(), plain);
        assert!(
            encode_limited(&input, plain.len() - 1)
                .unwrap_err()
                .to_string()
                .contains("exceeds its bound")
        );
    }
}
