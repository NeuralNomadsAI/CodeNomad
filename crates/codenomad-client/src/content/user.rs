use super::{Part, Text, TextProvenance};
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
fn list<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    match value.get(key) {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err("invalid native user attachments".into()),
    }
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| "invalid native user attachment".into())
}
pub(super) fn decode(value: &Value) -> Result<Vec<Part>> {
    let id = string(value, "id")?;
    let skills = list(value, "skills")?;
    let files = list(value, "files")?;
    if skills.len() + files.len() + 1 > 1000 {
        return Err("message part bound reached".into());
    }
    let mut parts = vec![Part::Text(Text {
        text: string(value, "text")?.into(),
        provenance: TextProvenance::Closed,
    })];
    for (index, skill) in skills.iter().enumerate() {
        parts.push(Part::Skill(Skill { id: format!("{id}-skill-{index}"),
            skill_id: string(skill, "id")?.into(), name: string(skill, "name")?.into() }));
    }
    for (index, file) in files.iter().enumerate() {
        let mime = string(file, "mime")?;
        let uri = match file["source"]["type"].as_str() {
            Some("uri") => string(&file["source"], "uri")?.into(),
            Some("inline") => format!("data:{mime};base64,{}", string(file, "data")?),
            _ => return Err("invalid native file source".into()),
        };
        parts.push(Part::File(File { id: format!("{id}-file-{index}"), uri, mime: mime.into(),
            name: file["name"].as_str().map(str::to_owned) }));
    }
    Ok(parts)
}
