//! `memory/contract.ts` + `memory/model.ts` + the projections of `memory/service.ts`:
//! limits, safe business errors, zod-equivalent validation and content revisions.

use crate::shared::js_space;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

pub const GLOBAL_LIMIT: usize = 60;
pub const PROJECT_LIMIT: usize = 200;
pub const TITLE_LIMIT: usize = 60;
pub const TEXT_LIMIT: usize = 2000;
pub const INSTRUCTIONS_LIMIT: usize = 8000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Global,
    Project,
}
impl Scope {
    pub fn parse(value: &str) -> Option<Scope> {
        match value {
            "global" => Some(Scope::Global),
            "project" => Some(Scope::Project),
            _ => None,
        }
    }
    pub fn limit(self) -> usize {
        match self {
            Scope::Global => GLOBAL_LIMIT,
            Scope::Project => PROJECT_LIMIT,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Disabled,
    Full,
    Conflict,
    Invalid,
    Unreadable,
    GitUnavailable,
    Malformed,
}
impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Disabled => "disabled",
            Code::Full => "full",
            Code::Conflict => "conflict",
            Code::Invalid => "invalid",
            Code::Unreadable => "unreadable",
            Code::GitUnavailable => "git_unavailable",
            Code::Malformed => "malformed",
        }
    }
    /// `memoryErrorReply` status table.
    pub fn status(self) -> u16 {
        match self {
            Code::Disabled => 403,
            Code::Full | Code::Conflict => 409,
            Code::Invalid => 400,
            Code::Unreadable | Code::GitUnavailable => 503,
            Code::Malformed => 422,
        }
    }
}

/// `MemoryError`: only the code (and safe capacity titles) ever leave the server.
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryError {
    pub code: Code,
    pub message: &'static str,
    pub titles: Option<Vec<String>>,
}
pub fn fail(code: Code, message: &'static str) -> MemoryError {
    MemoryError { code, message, titles: None }
}
pub type Result<T> = std::result::Result<T, MemoryError>;
pub fn check(cancel: Option<&tokio_util::sync::CancellationToken>) -> Result<()> {
    if cancel.is_some_and(|c| c.is_cancelled()) {
        Err(fail(Code::Unreadable, "Memory request cancelled"))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Content {
    pub title: String,
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    pub session_id: String,
}

const KINDS: [&str; 3] = ["fact", "preference", "reference"];
fn control(value: &str) -> bool {
    value.chars().any(|c| (c as u32) <= 0x1f || c as u32 == 0x7f)
}
/// zod 4 string lengths count Unicode code points.
pub fn points(value: &str) -> usize {
    value.chars().count()
}
pub fn valid_id(value: &str) -> bool {
    static ID: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$").unwrap());
    static DEVICE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$").unwrap());
    ID.is_match(value) && !DEVICE.is_match(value)
}
/// zod 4 `z.string().datetime({ offset: true })`.
pub fn valid_datetime(value: &str) -> bool {
    static DATE: LazyLock<regex::Regex> = LazyLock::new(|| {
        let date = r"(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))";
        let time =
            r"(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9]))";
        regex::Regex::new(&format!("^{date}T(?:{time})$")).unwrap()
    });
    DATE.is_match(value)
}
fn valid_title(value: &str) -> bool {
    points(value) <= TITLE_LIMIT && value.chars().any(|c| !js_space(c)) && !control(value)
}
fn valid_content(c: &Content) -> bool {
    valid_title(&c.title) && KINDS.contains(&c.kind.as_str()) && points(&c.text) <= TEXT_LIMIT
}

/// `validateMemoryContent`: a strict `{ title, type, text }` object.
pub fn content(value: &Value) -> Result<Content> {
    let invalid = || fail(Code::Invalid, "Invalid memory content");
    let object = value.as_object().filter(|o| o.len() == 3).ok_or_else(invalid)?;
    let field = |name: &str| object.get(name).and_then(Value::as_str).map(str::to_owned).ok_or_else(invalid);
    let parsed = Content { title: field("title")?, kind: field("type")?, text: field("text")? };
    if !valid_content(&parsed) { Err(invalid()) } else { Ok(parsed) }
}

/// `validateMemoryEntry(value, code)`.
pub fn validate(entry: &Entry, code: Code) -> Result<()> {
    let ok = valid_content(&Content { title: entry.title.clone(), kind: entry.kind.clone(), text: entry.text.clone() })
        && valid_id(&entry.id)
        && valid_datetime(&entry.created_at)
        && valid_datetime(&entry.updated_at)
        && (1..=200).contains(&points(&entry.session_id))
        && !control(&entry.session_id);
    if ok { Ok(()) } else { Err(fail(code, "Invalid memory entry")) }
}

/// `memoryRevision`: SHA-256 of the JSON array of every field.
pub fn revision(e: &Entry) -> String {
    let array = json!([e.id, e.title, e.kind, e.text, e.created_at, e.updated_at, e.session_id]);
    format!("{:x}", Sha256::digest(js_json(&array).as_bytes()))
}

/// `JSON.stringify` of strings: serde_json escapes the same set except that JS
/// leaves U+2028/U+2029 raw too, as serde_json does; both use lowercase `\u00xx`.
pub fn js_json(value: &Value) -> String {
    serde_json::to_string(value).expect("JSON value")
}

pub fn versioned(e: &Entry) -> Value {
    json!({"id":e.id,"title":e.title,"type":e.kind,"text":e.text,"createdAt":e.created_at,
        "updatedAt":e.updated_at,"sessionId":e.session_id,"revision":revision(e)})
}
pub fn header(e: &Entry) -> Value {
    json!({"id":e.id,"title":e.title,"type":e.kind,"createdAt":e.created_at,
        "updatedAt":e.updated_at,"sessionId":e.session_id,"revision":revision(e)})
}
pub fn reviewed(e: &Entry, flagged: bool) -> Value {
    let mut v = versioned(e);
    v["flagged"] = json!(flagged);
    if flagged {
        v["warning"] = json!("suspected_injection");
    }
    v
}

/// `memoryErrorReply` body.
pub fn error_body(e: &MemoryError) -> Value {
    let message = if e.code == Code::Full {
        "Memory is full. Merge or delete entries before retrying.".to_owned()
    } else {
        format!("Memory operation failed: {}", e.code.as_str())
    };
    let mut body = json!({"code": e.code.as_str(), "error": message});
    if let Some(titles) = &e.titles {
        body["titles"] = json!(titles);
    }
    body
}
