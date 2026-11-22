use super::{MAX_FILE_BYTES, reject_svgz};

const MAX_SIDE: usize = 8192;

pub fn can_decode(bytes: &[u8]) -> bool {
    if bytes.len() > MAX_FILE_BYTES || reject_svgz(bytes).is_err() {
        return false;
    }
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    if text.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'<') {
        return true; // Rune applies its XML and raster bounds to plain SVG.
    }
    if bytes.get(4..8) == Some(b"ftyp") && matches!(bytes.get(8..12), Some(b"avif" | b"avis")) {
        return avif_extents(bytes).unwrap_or(false);
    }
    imagesize::blob_size(bytes).is_ok_and(|size| within(size.width, size.height))
}

fn within(width: usize, height: usize) -> bool {
    (1..=MAX_SIDE).contains(&width) && (1..=MAX_SIDE).contains(&height)
}

// Inspect declared image extents without invoking the codec or allocating from box lengths.
// The decoder must still bound bitstream allocation: declared extents aren't authoritative.
fn avif_extents(bytes: &[u8]) -> Option<bool> {
    fn scan(mut bytes: &[u8], depth: usize, found: &mut bool) -> Option<()> {
        while !bytes.is_empty() {
            let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
            let kind = bytes.get(4..8)?;
            let (length, header) = match size {
                0 => (bytes.len(), 8),
                1 => (
                    usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?,
                    16,
                ),
                value => (value as usize, 8),
            };
            let body = bytes.get(header..length)?;
            match (depth, kind) {
                (0, b"meta") => scan(body.get(4..)?, 1, found)?,
                (1, b"iprp") => scan(body, 2, found)?,
                (2, b"ipco") => scan(body, 3, found)?,
                (3, b"ispe") => {
                    let side = |at| {
                        Some(u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?) as usize)
                    };
                    if !within(side(4)?, side(8)?) {
                        return None;
                    }
                    *found = true;
                }
                _ => {}
            }
            bytes = bytes.get(length..)?;
        }
        Some(())
    }
    let mut found = false;
    scan(bytes, 0, &mut found)?;
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_bounded_raster_and_plain_svg_metadata() {
        let mut png = *b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01";
        assert!(can_decode(&png));
        png[16..20].copy_from_slice(&8193_u32.to_be_bytes());
        assert!(!can_decode(&png));
        assert!(can_decode(b"\xef\xbb\xbf <svg/>"));
        assert!(!can_decode(&[0x1f, 0x8b]));
        assert!(!can_decode(b"\0\0\0\x0cftypavif"));
    }

    #[test]
    fn avif_sizes_are_read_from_nested_extent_boxes() {
        fn atom(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
            [(8 + body.len() as u32).to_be_bytes().as_slice(), name, body].concat()
        }
        let avif = |width: u32| {
            let extent = [
                0_u32.to_be_bytes(),
                width.to_be_bytes(),
                1_u32.to_be_bytes(),
            ]
            .concat();
            let properties = atom(b"iprp", &atom(b"ipco", &atom(b"ispe", &extent)));
            [
                atom(b"ftyp", b"avif"),
                atom(b"meta", &[&[0; 4], properties.as_slice()].concat()),
            ]
            .concat()
        };
        assert!(can_decode(&avif(8192)));
        assert!(!can_decode(&avif(8193)));
        assert!(!can_decode(&avif(0)));
    }
}
