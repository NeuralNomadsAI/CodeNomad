//! Private runtime protocol; no generic RPC/executable operation.
use crate::{Error, Identity, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Security::Cryptography::{
    BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
};

pub const MAX_FRAME: usize = 256 * 1024;
pub const MAX_PENDING: usize = 16;
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Birth {
    pub pid: u32,
    pub creation_filetime: String,
}
impl From<Identity> for Birth {
    fn from(b: Identity) -> Self {
        Self {
            pid: b.pid,
            creation_filetime: b.creation_filetime.to_string(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChannelBootstrap {
    pub v: u8,
    pub profile: String,
    pub generation: String,
    pub pipe: String,
    pub secret: String,
    pub receipt_secret: String,
    pub control_pipe: String,
    pub role: String,
    pub supervisor: Birth,
    pub peer: Birth,
    pub application: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Hello {
    pub v: u8,
    pub profile: String,
    pub generation: String,
    pub role: String,
    pub peer: Birth,
    pub challenge: String,
    pub proof: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServicePolicy {
    pub executable: String,
    pub args_prefix: Vec<String>,
    pub cwd: String,
    pub windows_verbatim_arguments: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServiceRequest {
    pub file: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cwd: String,
    pub windows_verbatim_arguments: bool,
}
impl ServicePolicy {
    pub(crate) fn admit(&self, value: &ServiceRequest) -> Result<()> {
        if self.executable != value.file
            || self.cwd != value.cwd
            || self.windows_verbatim_arguments != value.windows_verbatim_arguments
            || self.args_prefix.is_empty()
            || value.args != self.args_prefix
        {
            return Err(Error("native-service-policy-refused"));
        }
        // Validate the SAME full native command before irreversible permit issuance,
        // not just at starter creation. No environment truncation or Refused replay.
        crate::Command {
            executable: value.file.clone().into(),
            args: value.args.clone(),
            directory: value.cwd.clone().into(),
            environment: value
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        }
        .prepare_mode(value.windows_verbatim_arguments)
        .map(|_| ())
    }
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn random_hex() -> Result<String> {
    let mut data = [0u8; 32];
    if unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            data.as_mut_ptr(),
            32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    } < 0
    {
        return Err(Error("native-channel-random-unavailable"));
    }
    Ok(hex(&data))
}
fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn is_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |x, (a, b)| x | (a ^ b)) == 0
}
pub(crate) fn mac(boot: &ChannelBootstrap, challenge: &str, domain: &str) -> String {
    // RFC 2104 HMAC-SHA256, fixed 32-byte ephemeral key. Not a persistent host signature.
    let key: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&boot.secret[i..i + 2], 16).unwrap())
        .collect();
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for (i, k) in key.iter().enumerate() {
        inner[i] ^= k;
        outer[i] ^= k;
    }
    let text = format!(
        "codenomad-runtime-v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        boot.profile,
        boot.generation,
        boot.role,
        boot.peer.pid,
        boot.peer.creation_filetime,
        boot.supervisor.pid,
        boot.supervisor.creation_filetime,
        challenge,
        domain
    );
    let mut h = Sha256::new();
    h.update(inner);
    h.update(text.as_bytes());
    let mut o = Sha256::new();
    o.update(outer);
    o.update(h.finalize());
    hex(&o.finalize())
}
pub(crate) fn encode(value: &Value) -> Result<Vec<u8>> {
    let data = serde_json::to_vec(value).map_err(|_| Error("native-channel-encode"))?;
    if data.is_empty() || data.len() > MAX_FRAME {
        return Err(Error("native-channel-frame-bound"));
    }
    let mut result = (data.len() as u32).to_le_bytes().to_vec();
    result.extend(data);
    Ok(result)
}

#[cfg(test)]
mod service_tests {
    use super::*;
    fn policy() -> ServicePolicy {
        ServicePolicy {
            executable: "C:/fixture/selected.exe".into(),
            args_prefix: vec!["service".into(), "start".into()],
            cwd: "C:/fixture".into(),
            windows_verbatim_arguments: false,
        }
    }
    fn request() -> ServiceRequest {
        ServiceRequest {
            file: "C:/fixture/selected.exe".into(),
            args: vec!["service".into(), "start".into()],
            env: std::collections::BTreeMap::new(),
            cwd: "C:/fixture".into(),
            windows_verbatim_arguments: false,
        }
    }
    #[test]
    fn service_policy_rejects_extra_args_or_changed_selected_cli() {
        let p = policy();
        let mut r = request();
        p.admit(&r).unwrap();
        r.args.push("--unapproved".into());
        assert!(p.admit(&r).is_err());
        r = request();
        r.file = "other.exe".into();
        assert!(p.admit(&r).is_err());
    }
    #[test]
    fn service_policy_preserves_environment_without_accepting_nuls() {
        let p = policy();
        let mut r = request();
        r.env.insert("PRIVATE".into(), "a b \" c".into());
        p.admit(&r).unwrap();
        r.env.insert("PRIVATE".into(), "bad\0value".into());
        assert!(p.admit(&r).is_err());
        r = request();
        r.env.insert("bad=key".into(), "v".into());
        assert!(p.admit(&r).is_err());
    }
    #[test]
    fn service_policy_rejects_changed_cwd_and_verbatim_mode() {
        let p = policy();
        let mut r = request();
        r.cwd = "other".into();
        assert!(p.admit(&r).is_err());
        r = request();
        r.windows_verbatim_arguments = true;
        assert!(p.admit(&r).is_err());
    }
}
