use crate::{
    backend::Backend,
    files::{MAX_FILE_BYTES, images},
    history::Result,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::sync::Arc;
pub(super) const ROW_IMAGE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub name: Option<String>,
    pub mime: String,
    pub source: PictureSource,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PictureSource {
    Inline(Arc<str>),
    Http(Arc<str>),
    Attachment(super::Reference),
    Unavailable,
}

impl PictureSource {
    pub(super) fn inline(value: &str) -> Self {
        if inline_fits(value) {
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
                return Self::inline(body);
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
            Self::Unavailable => return Err("transcript image source unavailable".into()),
        };
        if !passive_raster(&bytes, mime) {
            return Err("unsupported transcript image".into());
        }
        Ok(bytes)
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
    (claimed.eq_ignore_ascii_case(mime)
        || (matches!(kind, Ico) && claimed.eq_ignore_ascii_case("image/vnd.microsoft.icon")))
        && images::can_decode(bytes)
        && imagesize::blob_size(bytes).ok().is_some_and(|size| {
            size.width > 0 && size.height > 0 && size.width.saturating_mul(size.height) <= 8 * 1024 * 1024
        })
}

pub(super) fn tool_pictures(state: &Value, bytes: &mut usize) -> Vec<Picture> {
    if state["status"] != "completed" {
        return Vec::new();
    }
    state["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let mime = item["mime"].as_str().filter(|mime| is_image(mime))?;
            let uri = item["uri"].as_str().filter(|_| item["type"] == "file")?;
            let source = PictureSource::uri(mime, uri).fit(bytes);
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
        .take(8)
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
        {"type":"file","uri":"data:image/png;base64,AAAA","mime":"image/png"},
        {"type":"text","text":"visible log"}
    ]});
    let mut bytes = ROW_IMAGE_BYTES;
    let pictures = tool_pictures(&response, &mut bytes);
    assert_eq!(pictures.len(), 3);
    assert!(
        pictures[..2]
            .iter()
            .all(|p| p.source == PictureSource::Unavailable)
    );
    assert!(matches!(pictures[2].source, PictureSource::Inline(_)));
}
