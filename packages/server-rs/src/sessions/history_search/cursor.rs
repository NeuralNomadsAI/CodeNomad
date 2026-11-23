use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub(super) fn digest(value: &serde_json::Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

pub(super) fn encode(value: &impl Serialize) -> Option<String> {
    Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).ok()?))
}

pub(super) fn decode<T: DeserializeOwned>(token: &str) -> Option<T> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(token).ok()?).ok()
}

fn signer() -> Option<Hmac<Sha256>> {
    static SECRET: OnceLock<Option<[u8; 32]>> = OnceLock::new();
    let key = SECRET.get_or_init(|| {
        let mut key = [0; 32];
        getrandom::fill(&mut key).ok()?;
        Some(key)
    });
    Hmac::new_from_slice(key.as_ref()?).ok()
}

pub(super) fn seal(binding: &str, value: &impl Serialize) -> Option<String> {
    let body = encode(&(binding, value))?;
    let mut mac = signer()?;
    mac.update(body.as_bytes());
    Some(format!("{body}.{}", URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())))
}

pub(super) fn open<T: DeserializeOwned>(binding: &str, token: &str) -> Option<T> {
    let (body, signature) = token.split_once('.')?;
    let mut mac = signer()?;
    mac.update(body.as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?).ok()?;
    let (issued_for, value): (String, T) = decode(body)?;
    (issued_for == binding).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranked_cursor_binds_and_authenticates_the_continuation() {
        let token = seal("query", &12u64).unwrap();
        assert_eq!(open("query", &token), Some(12u64));
        assert_eq!(open::<u64>("changed", &token), None);
        let (_, signature) = token.split_once('.').unwrap();
        let tampered = format!("{}.{signature}", encode(&("query", 13u64)).unwrap());
        assert_eq!(open::<u64>("query", &tampered), None);
    }
}
