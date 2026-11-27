use super::{Part, PictureSource, media};
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
    pub mime: String,
    pub name: Option<String>,
    pub reference: Option<Reference>,
    pub picture: Option<PictureSource>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Reference {
    pub message: String,
    pub ordinal: usize,
    pub sha256: String,
}
pub(crate) fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn basename(uri: &str) -> Option<String> {
    if uri.len() > 8192 {
        return None;
    }
    let url = reqwest::Url::parse(uri).ok()?;
    matches!(url.scheme(), "file" | "http" | "https")
        .then(|| {
            url.path_segments()?
                .next_back()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
        .flatten()
}
fn list<'a>(value: &'a Value, key: &str) -> Result<&'a [Value]> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(&[]),
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
    decode_payload(id, value)
}
pub(crate) fn decode_payload(id: &str, value: &Value) -> Result<Vec<Part>> {
    let skills = list(value, "skills")?;
    let files = list(value, "files")?;
    let mut parts = Vec::with_capacity(skills.len() + files.len());
    for (index, skill) in skills.iter().enumerate() {
        parts.push(Part::Skill(Skill {
            id: format!("{id}-skill-{index}"),
            skill_id: string(skill, "id")?.into(),
            name: string(skill, "name")?.into(),
        }));
    }
    let mut image_bytes = media::ROW_IMAGE_BYTES;
    for (index, file) in files.iter().enumerate() {
        let mime = string(file, "mime")?;
        let source = &file["source"];
        let reference = match source["type"].as_str() {
            Some("uri" | "inline" | "file" | "unavailable") => None,
            Some("deferred") => {
                let sha256 = string(source, "sha256")?;
                if !digest(sha256) {
                    return Err("invalid native attachment digest".into());
                }
                Some(Reference {
                    message: id.into(),
                    ordinal: index,
                    sha256: sha256.into(),
                })
            }
            _ => return Err("invalid native file source".into()),
        };
        let picture = media::is_image(mime).then(|| {
            if let Some(reference) = &reference {
                return PictureSource::Attachment(reference.clone());
            }
            let picture = match source["type"].as_str() {
                Some("uri") => source["uri"]
                    .as_str()
                    .map(|uri| PictureSource::uri(mime, uri)),
                Some("inline" | "file") => file["data"]
                    .as_str()
                    .or_else(|| source["data"].as_str())
                    .map(|data| PictureSource::inline(mime, data)),
                _ => None,
            };
            picture
                .unwrap_or(PictureSource::Unavailable)
                .fit(&mut image_bytes)
        });
        parts.push(Part::File(File {
            id: format!("{id}-file-{index}"),
            mime: mime.into(),
            name: file["name"]
                .as_str()
                .filter(|name| !name.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| source["uri"].as_str().and_then(basename)),
            reference,
            picture,
        }));
    }
    Ok(parts)
}
