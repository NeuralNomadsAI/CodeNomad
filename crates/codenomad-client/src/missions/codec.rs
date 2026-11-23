use super::directory::Verified;
use crate::history::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub struct RevisionChanged(pub u64);

impl std::fmt::Display for RevisionChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Mission revision changed")
    }
}

impl std::error::Error for RevisionChanged {}

pub(super) fn digest(rows: &[String]) -> String {
    let mut hash = Sha256::new();
    let mut buffer = [0; 2048];
    hash.update([b'[', 0]);
    for (index, row) in rows.iter().enumerate() {
        if index != 0 {
            hash.update([b',', 0]);
        }
        let mut written = 0;
        for unit in row.encode_utf16() {
            buffer[written..written + 2].copy_from_slice(&unit.to_le_bytes());
            written += 2;
            if written == buffer.len() {
                hash.update(buffer);
                written = 0;
            }
        }
        hash.update(&buffer[..written]);
    }
    hash.update([b']', 0]);
    URL_SAFE_NO_PAD.encode(hash.finalize())
}

pub(super) fn decode_row<T: serde::de::DeserializeOwned>(page: &Verified) -> Result<T> {
    let [text] = page.rows.as_slice() else {
        return Err("missing Mission panel row".into());
    };
    // Limit structure before decoding compact metadata, including unknown extensions.
    let mut depth = 0usize;
    let mut tokens = 0;
    let mut quoted = false;
    let mut escaped = false;
    for byte in text.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            continue;
        }
        match byte {
            b'"' => quoted = true,
            b'{' | b'[' => {
                tokens += 1;
                depth += 1;
            }
            b'}' | b']' => depth = depth.checked_sub(1).ok_or("invalid Mission panel JSON")?,
            b':' | b',' => tokens += 1,
            _ => {}
        }
        if depth > 24 || tokens > 262_144 {
            return Err("oversized Mission panel JSON structure".into());
        }
    }
    Ok(serde_json::from_str(text)?)
}
