#[cfg(not(target_arch = "wasm32"))]
pub fn fingerprint(content: &rune::ClipboardContent) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    let mut feed = |tag: u8, bytes: &[u8]| {
        hash ^= u64::from(tag);
        hash = hash.wrapping_mul(0x100000001b3);
        for &b in &(bytes.len() as u64).to_le_bytes() {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        for &b in bytes {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    };
    feed(1, content.text().as_bytes());
    if let Some(html) = content.html() {
        feed(2, html.as_bytes());
    }
    if let Some(rtf) = content.rtf() {
        feed(3, rtf.as_bytes());
    }
    if let Some(image) = content.image() {
        let (w, h) = image.size();
        feed(4, &w.to_le_bytes());
        feed(5, &h.to_le_bytes());
        feed(6, image.png());
    }
    for path in content.files() {
        feed(7, path.as_os_str().as_encoded_bytes());
    }
    hash
}
