use super::{MAX_FILE_BYTES, reject_svgz};

const MAX_SIDE: usize = 8192;

pub fn can_decode(bytes: &[u8]) -> bool {
    admit(bytes, cfg!(target_arch = "wasm32"))
}

fn admit(bytes: &[u8], browser: bool) -> bool {
    if bytes.len() > MAX_FILE_BYTES || reject_svgz(bytes).is_err() {
        return false;
    }
    let text = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    if text.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'<') {
        return true; // Rune applies its XML and raster bounds to plain SVG.
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        match bytes.get(8..12) {
            Some(b"avif") => return !avif_oversized(bytes, false).unwrap_or(false),
            Some(b"avis") if browser => return !avif_oversized(bytes, true).unwrap_or(false),
            _ => {}
        }
    }
    // Rune's native raster decoder and the shared PNG/ICNS paths own their limits.
    if !browser || bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.starts_with(b"icns") {
        return true;
    }
    let dimensions = if bytes.starts_with(b"BM") {
        bmp_size(bytes)
    } else if bytes.starts_with(b"\xff\xd8") {
        jpeg_size(bytes)
    } else if matches!(
        imagesize::image_type(bytes),
        Ok(imagesize::ImageType::Gif | imagesize::ImageType::Webp)
    ) {
        imagesize::blob_size(bytes)
            .ok()
            .map(|size| (size.width, size.height))
    } else {
        None
    };
    !dimensions.is_some_and(|(width, height)| oversized(width, height))
}

fn oversized(width: usize, height: usize) -> bool {
    width != 0 && height != 0 && (width > MAX_SIDE || height > MAX_SIDE)
}

fn bmp_size(bytes: &[u8]) -> Option<(usize, usize)> {
    let length = u32::from_le_bytes(bytes.get(14..18)?.try_into().ok()?) as usize;
    let header = bytes.get(14..14_usize.checked_add(length)?)?;
    match length {
        12 => {
            let side =
                |at| Some(u16::from_le_bytes(header.get(at..at + 2)?.try_into().ok()?) as usize);
            Some((side(4)?, side(6)?))
        }
        40 | 52 | 56 | 108 | 124 => {
            let side = |at| Some(i32::from_le_bytes(header.get(at..at + 4)?.try_into().ok()?));
            let width = usize::try_from(side(4)?).ok()?;
            let height = side(8)?.checked_abs()? as usize;
            Some((width, height))
        }
        _ => None,
    }
}

fn jpeg_size(mut bytes: &[u8]) -> Option<(usize, usize)> {
    bytes = bytes.strip_prefix(b"\xff\xd8")?;
    while bytes.first() == Some(&0xff) {
        let end = bytes.iter().position(|&byte| byte != 0xff)?;
        let marker = *bytes.get(end)?;
        bytes = bytes.get(end + 1..)?;
        match marker {
            0x00 | 0xd8 | 0xd9 | 0xda => return None,
            0x01 | 0xd0..=0xd7 => continue,
            _ => {}
        }
        let length = u16::from_be_bytes(bytes.get(..2)?.try_into().ok()?) as usize;
        let segment = bytes.get(2..length)?;
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            let components = *segment.get(5)? as usize;
            if components == 0 || segment.len() != 6 + 3 * components {
                return None;
            }
            let side =
                |at| Some(u16::from_be_bytes(segment.get(at..at + 2)?.try_into().ok()?) as usize);
            return Some((side(3)?, side(1)?));
        }
        bytes = bytes.get(length..)?;
    }
    None
}

// Inspect declared image extents without invoking the codec or allocating from box lengths.
// The decoder must still bound bitstream allocation: declared extents aren't authoritative.
fn avif_oversized(bytes: &[u8], animated: bool) -> Option<bool> {
    fn scan(mut bytes: &[u8], parent: &[u8], animated: bool, over: &mut bool) -> Option<()> {
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
            let side: fn(&[u8], usize) -> Option<u32> =
                |bytes, at| Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
            match (parent, kind) {
                (b"", b"meta") => scan(body.get(4..)?, kind, animated, over)?,
                (b"meta", b"iprp") | (b"iprp", b"ipco") => scan(body, kind, animated, over)?,
                (b"ipco", b"ispe") if body.get(..4) == Some(&[0; 4]) => {
                    *over |= oversized(side(body, 4)? as usize, side(body, 8)? as usize);
                }
                (b"", b"moov") | (b"moov", b"trak") if animated => {
                    scan(body, kind, animated, over)?;
                }
                (b"trak", b"tkhd") if animated => {
                    let width_offset = match body.first()? {
                        0 => 76,
                        1 => 88,
                        _ => return None,
                    };
                    let (width, height) =
                        (side(body, width_offset)?, side(body, width_offset + 4)?);
                    let limit = (MAX_SIDE as u32) << 16;
                    *over |= width != 0 && height != 0 && (width > limit || height > limit);
                }
                _ => {}
            }
            bytes = bytes.get(length..)?;
        }
        Some(())
    }
    let mut over = false;
    scan(bytes, b"", animated, &mut over)?;
    Some(over)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_caps_with_the_native_and_shared_decoders() {
        let mut png = *b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01";
        assert!(can_decode(&png));
        png[16..20].copy_from_slice(&8193_u32.to_be_bytes());
        assert!(admit(&png, true));
        assert!(admit(&png, false));
        assert!(can_decode(b"\xef\xbb\xbf <svg/>"));
        assert!(!can_decode(&[0x1f, 0x8b]));
        assert!(can_decode(b"\0\0\0\x0cftypavif"));
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
        assert!(can_decode(&avif(0)));
    }

    #[test]
    fn browser_admits_top_down_bmp_and_jpeg_marker_fill() {
        let mut bmp = [0_u8; 54];
        bmp[..2].copy_from_slice(b"BM");
        bmp[14..18].copy_from_slice(&40_u32.to_le_bytes());
        bmp[18..22].copy_from_slice(&1_i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&(-2_i32).to_le_bytes());
        assert_eq!(bmp_size(&bmp), Some((1, 2)));
        assert!(admit(&bmp, true));
        bmp[22..26].copy_from_slice(&(-8193_i32).to_le_bytes());
        assert!(!admit(&bmp, true));
        assert!(admit(&bmp, false));
        bmp[22..26].copy_from_slice(&i32::MIN.to_le_bytes());
        assert!(admit(&bmp, true));

        let mut jpeg = *b"\xff\xd8\xff\xff\xc0\x00\x0b\x08\x00\x02\x00\x01\x01\x01\x11\x00";
        assert_eq!(jpeg_size(&jpeg), Some((1, 2)));
        assert!(admit(&jpeg, true));
        jpeg[10..12].copy_from_slice(&8193_u16.to_be_bytes());
        assert!(!admit(&jpeg, true));
        assert!(admit(&jpeg[..12], true));
    }

    #[test]
    fn browser_avif_sequence_checks_track_dimensions() {
        fn atom(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
            [(8 + body.len() as u32).to_be_bytes().as_slice(), name, body].concat()
        }
        for (version, offset) in [(0, 76), (1, 88)] {
            let avis = |width: u32| {
                let mut track = vec![0; offset + 8];
                track[0] = version;
                track[offset..offset + 4].copy_from_slice(&(width << 16).to_be_bytes());
                track[offset + 4..offset + 8].copy_from_slice(&(1_u32 << 16).to_be_bytes());
                [
                    atom(b"ftyp", b"avis"),
                    atom(b"moov", &atom(b"trak", &atom(b"tkhd", &track))),
                ]
                .concat()
            };
            assert!(admit(&avis(8192), true));
            assert!(!admit(&avis(8193), true));
            assert!(admit(&avis(8193), false));
        }
    }
}
