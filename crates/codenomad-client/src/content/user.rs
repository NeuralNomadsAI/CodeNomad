use super::Part;
use crate::history::Result;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct Skill {
    pub id: String,
    pub skill_id: String,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct File {
    pub id: String,
    pub uri: String,
    pub mime: String,
    pub name: Option<String>,
}
impl File {
    pub fn display_name(&self) -> Option<String> {
        if let Some(name) = self.name.as_ref().filter(|name| !name.trim().is_empty()) {
            return Some(name.clone());
        }
        if self
            .uri
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
        {
            return None;
        }
        reqwest::Url::parse(&self.uri).ok().and_then(|url| {
            url.path_segments()?
                .next_back()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
    }
}
fn list<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    match value.get(key) {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err("invalid native user attachments".into()),
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| "invalid native user attachment".into())
}
pub(super) fn decode(value: &Value) -> Result<Vec<Part>> {
    let id = string(value, "id")?;
    let skills = list(value, "skills")?;
    let files = list(value, "files")?;
    const DISPLAY_LIMIT: usize = 1000;
    let total = skills.len() + files.len();
    let mut parts = Vec::with_capacity(total.min(DISPLAY_LIMIT) + 1);
    let visible = |parts: &mut Vec<Part>, index: usize| {
        if total > DISPLAY_LIMIT && index >= DISPLAY_LIMIT / 2 && index < total - DISPLAY_LIMIT / 2
        {
            if index == DISPLAY_LIMIT / 2 {
                parts.push(Part::HiddenUserAttachments(total - DISPLAY_LIMIT));
            }
            false
        } else {
            true
        }
    };
    for (index, skill) in skills.iter().enumerate() {
        if !visible(&mut parts, index) {
            continue;
        }
        parts.push(Part::Skill(Skill {
            id: format!("{id}-skill-{index}"),
            skill_id: string(skill, "id")?.into(),
            name: string(skill, "name")?.into(),
        }));
    }
    for (index, file) in files.iter().enumerate() {
        if !visible(&mut parts, skills.len() + index) {
            continue;
        }
        let mime = string(file, "mime")?;
        let uri = match file["source"]["type"].as_str() {
            Some("uri") => string(&file["source"], "uri")?.into(),
            // Stored media projection keeps the historical `file` source and hydrates its bytes.
            Some("inline" | "file") => format!("data:{mime};base64,{}", string(file, "data")?),
            _ => return Err("invalid native file source".into()),
        };
        parts.push(Part::File(File {
            id: format!("{id}-file-{index}"),
            uri,
            mime: mime.into(),
            name: file["name"].as_str().map(str::to_owned),
        }));
    }
    Ok(parts)
}
