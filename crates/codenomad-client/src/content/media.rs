use crate::{
    backend::Backend,
    files::{MAX_FILE_BYTES, images},
    history::Result,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::sync::Arc;
mod deferred;
pub use deferred::DeferredPicture;
pub(super) const ROW_IMAGE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub name: Option<String>,
    pub mime: String,
    pub source: PictureSource,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub enum PictureSource {
    Inline(Arc<str>),
    Http(Arc<str>),
    Attachment(super::Reference),
    Deferred(DeferredPicture),
    Unavailable,
}

impl PictureSource {
    pub(super) fn inline(mime: &str, value: &str) -> Self {
        let prefix = value
            .get(..value.len().min(64))
            .and_then(|prefix| STANDARD.decode(prefix).ok());
        if inline_fits(value)
            && prefix
                .as_ref()
                .is_some_and(|bytes| raster_type(bytes, mime))
        {
            Self::Inline(value.into())
        } else {
            Self::Unavailable
        }
    }

    pub(super) fn uri(mime: &str, uri: &str) -> Self {
        if let Some((header, body)) = uri.split_once(',')
            && header
                .get(..5)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:"))
        {
            let expected = format!("data:{mime};base64");
            if header.eq_ignore_ascii_case(&expected) {
                return Self::inline(mime, body);
            }
            return Self::Unavailable;
        }
        if uri.len() > 8192 || uri.contains('\\') {
            return Self::Unavailable;
        }
        match crate::http::external_http_url(uri) {
            Some((url, _)) => Self::Http(url.into()),
            None => Self::Unavailable,
        }
    }

    pub(super) fn retained_bytes(&self) -> usize {
        match self {
            Self::Inline(value) | Self::Http(value) => value.len(),
            Self::Attachment(reference) => reference.message.len() + reference.sha256.len(),
            Self::Deferred(reference) => reference.path().len(),
            Self::Unavailable => 0,
        }
    }

    pub(super) fn fit(self, left: &mut usize) -> Self {
        if let Some(remaining) = left.checked_sub(self.retained_bytes()) {
            *left = remaining;
            self
        } else {
            Self::Unavailable
        }
    }

    pub async fn bytes(&self, backend: Option<&Backend>, mime: &str) -> Result<Arc<Vec<u8>>> {
        let bytes = match self {
            Self::Inline(encoded) => {
                if !inline_fits(encoded) {
                    return Err("oversized transcript image".into());
                }
                Arc::new(STANDARD.decode(encoded.as_bytes())?)
            }
            Self::Http(url) => {
                Arc::new(images::Images::new()?.read("", url, MAX_FILE_BYTES).await?)
            }
            Self::Attachment(reference) => {
                backend
                    .ok_or("attachment connection unavailable")?
                    .attachment_bytes(reference)
                    .await?
            }
            Self::Deferred(reference) => Arc::new(
                reference
                    .read(backend.ok_or("image connection unavailable")?, mime)
                    .await?,
            ),
            Self::Unavailable => return Err("transcript image source unavailable".into()),
        };
        if !passive_raster(&bytes, mime) {
            return Err("unsupported transcript image".into());
        }
        Ok(bytes)
    }
}

impl std::fmt::Debug for PictureSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Inline(_) => "InlineImage",
            Self::Http(_) => "HttpImage",
            Self::Attachment(_) => "AttachmentImage",
            Self::Deferred(_) => "DeferredImage",
            Self::Unavailable => "UnavailableImage",
        })
    }
}

fn inline_fits(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_FILE_BYTES.div_ceil(3) * 4
}

pub(super) fn is_image(mime: &str) -> bool {
    mime.len() <= 128
        && mime
            .get(..6)
            .is_some_and(|value| value.eq_ignore_ascii_case("image/"))
}

fn passive_raster(bytes: &[u8], claimed: &str) -> bool {
    raster_type(bytes, claimed) && images::transcript_raster(bytes)
}

fn raster_type(bytes: &[u8], claimed: &str) -> bool {
    use imagesize::ImageType::*;
    let Ok(kind) = imagesize::image_type(bytes) else {
        return false;
    };
    let mime = match kind {
        Png => "image/png",
        Jpeg => "image/jpeg",
        Gif => "image/gif",
        Webp => "image/webp",
        Bmp => "image/bmp",
        Ico => "image/x-icon",
        Heif(imagesize::Compression::Av1) => "image/avif",
        _ => return false,
    };
    claimed.eq_ignore_ascii_case(mime)
        || (matches!(kind, Ico) && claimed.eq_ignore_ascii_case("image/vnd.microsoft.icon"))
}

pub(super) fn tool_pictures(
    state: &Value,
    message: &str,
    part: usize,
    bytes: &mut usize,
) -> Vec<Picture> {
    if state["status"] != "completed" {
        return Vec::new();
    }
    state["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, item)| {
            let mime = item["mime"].as_str().filter(|mime| is_image(mime))?;
            let uri = item["uri"].as_str().filter(|_| item["type"] == "file")?;
            let source = DeferredPicture::parse(uri, message, part, index)
                .map(PictureSource::Deferred)
                .unwrap_or_else(|| PictureSource::uri(mime, uri))
                .fit(bytes);
            Some(Picture {
                name: item["name"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.len() <= 512)
                    .map(str::to_owned),
                mime: mime.into(),
                source,
            })
        })
        .collect()
}

#[cfg(test)]
#[test]
fn media_requires_a_passive_signature_and_matching_mime() {
    use serde_json::json;
    let svg = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>";
    let png = b"\x89PNG\r\n\x1a\n";
    assert!(!passive_raster(svg, "image/png"));
    assert!(!passive_raster(png, "image/jpeg"));
    assert!(!passive_raster(b"<!doctype html>", "image/png"));
    let response = json!({"status":"completed","content":[
        {"type":"file","uri":"file:///private.png","mime":"image/png"},
        {"type":"file","uri":"https://user:secret@example.com/image.png","mime":"image/png"},
        {"type":"file","uri":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC","mime":"image/png"},
        {"type":"text","text":"visible log"}
    ]});
    let mut bytes = ROW_IMAGE_BYTES;
    let pictures = tool_pictures(&response, "message", 0, &mut bytes);
    assert_eq!(pictures.len(), 3);
    assert!(
        pictures[..2]
            .iter()
            .all(|p| p.source == PictureSource::Unavailable)
    );
    assert!(matches!(pictures[2].source, PictureSource::Inline(_)));
}

#[cfg(test)]
#[test]
fn all_fitting_tool_images_are_retained() {
    use serde_json::json;
    let items = (0..16).map(|index| json!({
        "type":"file","uri":format!("https://example.invalid/{index}.png"),"mime":"image/png"
    })).collect::<Vec<_>>();
    let pictures = tool_pictures(
        &json!({"status":"completed","content":items}),
        "message",
        0,
        &mut { ROW_IMAGE_BYTES },
    );
    assert_eq!(pictures.len(), 16);
    assert!(
        pictures
            .iter()
            .all(|pic| matches!(pic.source, PictureSource::Http(_)))
    );
}
