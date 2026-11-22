#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Source,
    Markdown,
    Mermaid,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Content<'a> {
    Image(&'static str),
    Text { text: &'a str, format: Format },
    Binary,
}

pub fn content<'a>(path: &str, bytes: &'a [u8]) -> Content<'a> {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        _ => None,
    };
    if let Some(mime) = mime {
        return Content::Image(mime);
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Content::Binary;
    };
    if text.contains('\0') {
        return Content::Binary;
    }
    let format = match extension.as_str() {
        "md" | "markdown" if path.contains('.') => Format::Markdown,
        "mmd" if path.contains('.') => Format::Mermaid,
        _ => Format::Source,
    };
    Content::Text {
        text: text.strip_prefix('\u{feff}').unwrap_or(text),
        format,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_text_decoding_matches_browser_bom_and_binary_boundaries() {
        for (bytes, text) in [
            (b"".as_slice(), ""),
            ("été 🦀\r\n日本語".as_bytes(), "été 🦀\r\n日本語"),
            ("\u{feff}text".as_bytes(), "text"),
            ("\u{feff}\u{feff}".as_bytes(), "\u{feff}"),
        ] {
            assert_eq!(
                content("source.rs", bytes),
                Content::Text {
                    text,
                    format: Format::Source
                }
            );
        }
        for bytes in [
            b"a\0b".as_slice(),
            b"\xff",
            b"\xc0\xaf",
            b"\xed\xa0\x80",
            b"\xf0\x9f\xa6",
        ] {
            assert_eq!(content("README.md", bytes), Content::Binary);
        }
    }

    #[test]
    fn source_extension_selects_images_and_rendered_text_without_sniffing() {
        for (extension, mime) in [
            ("PNG", "image/png"),
            ("jpg", "image/jpeg"),
            ("jpeg", "image/jpeg"),
            ("webp", "image/webp"),
            ("gif", "image/gif"),
            ("svg", "image/svg+xml"),
            ("ico", "image/x-icon"),
            ("bmp", "image/bmp"),
            ("avif", "image/avif"),
        ] {
            assert_eq!(
                content(&format!("nested/image.{extension}"), b"\xff\0"),
                Content::Image(mime)
            );
        }
        for (path, format) in [
            ("README.MD", Format::Markdown),
            ("readme.markdown", Format::Markdown),
            ("diagram.MMD", Format::Mermaid),
            ("folder.md/file", Format::Source),
            ("empty.", Format::Source),
            ("md", Format::Source),
            ("mmd", Format::Source),
        ] {
            assert_eq!(content(path, b""), Content::Text { text: "", format });
        }
    }
}
