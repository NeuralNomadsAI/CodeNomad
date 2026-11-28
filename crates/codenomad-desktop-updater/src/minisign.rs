//! Fail-closed minisign Ed25519 verification (`ED` BLAKE2b-512 prehash + legacy `Ed`)
//! and pure-Rust RFC 7693 BLAKE2b-512 streaming hasher.
//!
//! Matches `packages/tauri-app/scripts/updater-artifacts.mjs` and Tauri's updater contract:
//! both the artifact signature and the trusted-comment global signature must verify against
//! the pinned public key, and the trusted comment must bind `version:<version>`.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ring::{
    digest::{self, SHA256},
    signature::{ED25519, UnparsedPublicKey},
};

use super::UpdateError;

const UNTRUSTED_PREFIX: &str = "untrusted comment:";
const TRUSTED_PREFIX: &str = "trusted comment: ";
const PUBKEY_PACKET_LEN: usize = 42;
const SIG_PACKET_LEN: usize = 74;
const GLOBAL_SIG_LEN: usize = 64;

/// Minisign signature algorithm tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinisignAlgorithm {
    /// Prehashed Ed25519 over BLAKE2b-512 of the file bytes (`ED`, Tauri default).
    PrehashedBlake2b512,
    /// Legacy raw Ed25519 directly over the file bytes (`Ed`).
    LegacyRawEd25519,
}

/// Parsed minisign Ed25519 public key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinisignPublicKey {
    pub key_id: [u8; 8],
    pub public_bytes: [u8; 32],
}

/// Parsed minisign signature packet prior to cryptographic verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MinisignSignature {
    pub algorithm: MinisignAlgorithm,
    pub key_id: [u8; 8],
    pub data_signature: [u8; 64],
    pub trusted_comment: String,
    pub global_signature: [u8; 64],
}

/// Metadata returned once both minisign Ed25519 signatures verify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedMinisign {
    pub algorithm: MinisignAlgorithm,
    pub trusted_comment: String,
    pub signed_version: Option<String>,
}

/// Parses a base64-encoded 2-line minisign public key string.
pub fn parse_public_key(encoded: &str) -> Result<MinisignPublicKey, UpdateError> {
    MinisignPublicKey::parse(encoded)
}

impl MinisignPublicKey {
    pub fn parse(encoded: &str) -> Result<Self, UpdateError> {
        let trimmed = encoded.trim();
        if trimmed.is_empty() {
            return Err(UpdateError::InvalidPublicKey {
                reason: "public key is empty".into(),
            });
        }
        let raw_text = BASE64
            .decode(trimmed)
            .map_err(|_| UpdateError::InvalidPublicKey {
                reason: "outer base64 decoding failed".into(),
            })?;
        let text = String::from_utf8(raw_text).map_err(|_| UpdateError::InvalidPublicKey {
            reason: "decoded public key is not valid UTF-8".into(),
        })?;
        let lines: Vec<&str> = split_minisign_lines(&text);
        if lines.len() != 2 {
            return Err(UpdateError::InvalidPublicKey {
                reason: format!("expected 2 lines, got {}", lines.len()),
            });
        }
        if !lines[0].starts_with(UNTRUSTED_PREFIX) {
            return Err(UpdateError::InvalidPublicKey {
                reason: "missing untrusted comment header".into(),
            });
        }
        let packet = BASE64
            .decode(lines[1].trim())
            .map_err(|_| UpdateError::InvalidPublicKey {
                reason: "inner key base64 decoding failed".into(),
            })?;
        if packet.len() != PUBKEY_PACKET_LEN {
            return Err(UpdateError::InvalidPublicKey {
                reason: format!(
                    "expected {PUBKEY_PACKET_LEN} key bytes, got {}",
                    packet.len()
                ),
            });
        }
        if &packet[0..2] != b"Ed" {
            return Err(UpdateError::InvalidPublicKey {
                reason: "unsupported public key algorithm tag".into(),
            });
        }
        let mut key_id = [0u8; 8];
        key_id.copy_from_slice(&packet[2..10]);
        let mut public_bytes = [0u8; 32];
        public_bytes.copy_from_slice(&packet[10..42]);
        Ok(Self {
            key_id,
            public_bytes,
        })
    }
}

impl MinisignSignature {
    /// Parses a base64-encoded 4-line minisign signature string (matching `latest.json`).
    pub fn parse(encoded: &str) -> Result<Self, UpdateError> {
        let trimmed = encoded.trim();
        if trimmed.is_empty() {
            return Err(UpdateError::InvalidSignature {
                reason: "signature is empty".into(),
            });
        }
        let raw_text = BASE64
            .decode(trimmed)
            .map_err(|_| UpdateError::InvalidSignature {
                reason: "outer base64 decoding failed".into(),
            })?;
        let text = String::from_utf8(raw_text).map_err(|_| UpdateError::InvalidSignature {
            reason: "decoded signature is not valid UTF-8".into(),
        })?;
        let lines: Vec<&str> = split_minisign_lines(&text);
        if lines.len() != 4 {
            return Err(UpdateError::InvalidSignature {
                reason: format!("expected 4 lines, got {}", lines.len()),
            });
        }
        if !lines[0].starts_with(UNTRUSTED_PREFIX) {
            return Err(UpdateError::InvalidSignature {
                reason: "missing untrusted comment header".into(),
            });
        }
        let packet = BASE64
            .decode(lines[1].trim())
            .map_err(|_| UpdateError::InvalidSignature {
                reason: "signature packet base64 decoding failed".into(),
            })?;
        if packet.len() != SIG_PACKET_LEN {
            return Err(UpdateError::InvalidSignature {
                reason: format!(
                    "expected {SIG_PACKET_LEN} packet bytes, got {}",
                    packet.len()
                ),
            });
        }
        let algorithm = match &packet[0..2] {
            b"ED" => MinisignAlgorithm::PrehashedBlake2b512,
            b"Ed" => MinisignAlgorithm::LegacyRawEd25519,
            _ => {
                return Err(UpdateError::InvalidSignature {
                    reason: "unsupported minisign signature algorithm".into(),
                });
            }
        };
        let mut key_id = [0u8; 8];
        key_id.copy_from_slice(&packet[2..10]);
        let mut data_signature = [0u8; 64];
        data_signature.copy_from_slice(&packet[10..74]);

        let Some(trusted_comment) = lines[2].strip_prefix(TRUSTED_PREFIX) else {
            return Err(UpdateError::InvalidSignature {
                reason: "missing trusted comment line".into(),
            });
        };
        let global_raw =
            BASE64
                .decode(lines[3].trim())
                .map_err(|_| UpdateError::InvalidSignature {
                    reason: "global signature base64 decoding failed".into(),
                })?;
        if global_raw.len() != GLOBAL_SIG_LEN {
            return Err(UpdateError::InvalidSignature {
                reason: format!(
                    "expected {GLOBAL_SIG_LEN} global signature bytes, got {}",
                    global_raw.len()
                ),
            });
        }
        let mut global_signature = [0u8; 64];
        global_signature.copy_from_slice(&global_raw);

        Ok(Self {
            algorithm,
            key_id,
            data_signature,
            trusted_comment: trusted_comment.to_string(),
            global_signature,
        })
    }

    /// Performs cheap pre-download checks: key ID match, trusted-comment signature, and
    /// signed `version:<expected>` binding. Fails closed before any artifact byte is fetched.
    pub fn check_header(
        &self,
        pubkey: &MinisignPublicKey,
        expected_version: &str,
    ) -> Result<(), UpdateError> {
        if self.key_id != pubkey.key_id {
            return Err(UpdateError::SignatureVerificationFailed {
                reason: "signing key ID does not match pinned public key".into(),
            });
        }
        self.verify_trusted_comment(pubkey)?;
        let signed = trusted_comment_version(&self.trusted_comment)?;
        if signed != Some(expected_version) {
            return Err(UpdateError::SignedVersionMismatch {
                expected: expected_version.to_string(),
                signed: signed.map(str::to_owned),
            });
        }
        Ok(())
    }

    /// Verifies the trusted-comment global Ed25519 signature over
    /// `data_signature || trusted_comment`.
    pub fn verify_trusted_comment(&self, pubkey: &MinisignPublicKey) -> Result<(), UpdateError> {
        let mut message =
            Vec::with_capacity(self.data_signature.len() + self.trusted_comment.len());
        message.extend_from_slice(&self.data_signature);
        message.extend_from_slice(self.trusted_comment.as_bytes());
        let verifier = UnparsedPublicKey::new(&ED25519, &pubkey.public_bytes);
        verifier
            .verify(&message, &self.global_signature)
            .map_err(|_| UpdateError::SignatureVerificationFailed {
                reason: "trusted comment Ed25519 verification failed".into(),
            })
    }

    /// Verifies a prehashed `ED` signature against a streaming BLAKE2b-512 digest.
    pub fn verify_prehashed(
        &self,
        pubkey: &MinisignPublicKey,
        blake2b_digest: &[u8; 64],
    ) -> Result<VerifiedMinisign, UpdateError> {
        if self.algorithm != MinisignAlgorithm::PrehashedBlake2b512 {
            return Err(UpdateError::InvalidSignature {
                reason: "prehashed verification called for non-ED signature".into(),
            });
        }
        if self.key_id != pubkey.key_id {
            return Err(UpdateError::SignatureVerificationFailed {
                reason: "signing key ID does not match pinned public key".into(),
            });
        }
        let verifier = UnparsedPublicKey::new(&ED25519, &pubkey.public_bytes);
        verifier
            .verify(blake2b_digest, &self.data_signature)
            .map_err(|_| UpdateError::SignatureVerificationFailed {
                reason: "artifact Ed25519 signature verification failed".into(),
            })?;
        self.verify_trusted_comment(pubkey)?;
        let signed_version = trusted_comment_version(&self.trusted_comment)?.map(str::to_owned);
        Ok(VerifiedMinisign {
            algorithm: self.algorithm,
            trusted_comment: self.trusted_comment.clone(),
            signed_version,
        })
    }

    /// Verifies either `ED` (BLAKE2b-512 prehash) or legacy `Ed` (raw Ed25519) against full bytes.
    pub fn verify_bytes(
        &self,
        pubkey: &MinisignPublicKey,
        bytes: &[u8],
    ) -> Result<VerifiedMinisign, UpdateError> {
        if self.key_id != pubkey.key_id {
            return Err(UpdateError::SignatureVerificationFailed {
                reason: "signing key ID does not match pinned public key".into(),
            });
        }
        match self.algorithm {
            MinisignAlgorithm::PrehashedBlake2b512 => {
                let mut hasher = Blake2b512::new();
                hasher.update(bytes);
                let digest = hasher.finalize();
                self.verify_prehashed(pubkey, &digest)
            }
            MinisignAlgorithm::LegacyRawEd25519 => {
                let verifier = UnparsedPublicKey::new(&ED25519, &pubkey.public_bytes);
                verifier.verify(bytes, &self.data_signature).map_err(|_| {
                    UpdateError::SignatureVerificationFailed {
                        reason: "legacy artifact Ed25519 signature verification failed".into(),
                    }
                })?;
                self.verify_trusted_comment(pubkey)?;
                let signed_version =
                    trusted_comment_version(&self.trusted_comment)?.map(str::to_owned);
                Ok(VerifiedMinisign {
                    algorithm: self.algorithm,
                    trusted_comment: self.trusted_comment.clone(),
                    signed_version,
                })
            }
        }
    }
}

/// Verifies a minisign signature string against artifact bytes and a pinned public key.
pub fn verify_minisign(
    bytes: &[u8],
    signature_encoded: &str,
    public_key_encoded: &str,
) -> Result<VerifiedMinisign, UpdateError> {
    let pubkey = MinisignPublicKey::parse(public_key_encoded)?;
    let sig = MinisignSignature::parse(signature_encoded)?;
    sig.verify_bytes(&pubkey, bytes)
}

/// Extracts the tab-delimited `version:<value>` field from a minisign trusted comment.
/// Rejects duplicate `version:` fields fail-closed.
pub fn trusted_comment_version(comment: &str) -> Result<Option<&str>, UpdateError> {
    let mut found: Option<&str> = None;
    for field in comment.split('\t') {
        if let Some(value) = field.strip_prefix("version:") {
            if value.is_empty() {
                return Err(UpdateError::InvalidSignature {
                    reason: "trusted comment contains empty version field".into(),
                });
            }
            if found.is_some() {
                return Err(UpdateError::InvalidSignature {
                    reason: "trusted comment contains duplicate version fields".into(),
                });
            }
            found = Some(value);
        }
    }
    Ok(found)
}

/// Computes lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex_lowercase(bytes: &[u8]) -> String {
    let digest = digest::digest(&SHA256, bytes);
    encode_lower_hex(digest.as_ref())
}

/// Encodes arbitrary bytes as lowercase hexadecimal.
pub(crate) fn encode_lower_hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Validates and normalizes an expected 64-character SHA-256 hex digest.
pub(crate) fn normalize_sha256_hex(raw: &str) -> Result<String, UpdateError> {
    let trimmed = raw.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(UpdateError::InvalidManifest {
            reason: "sha256 must be a 64-character hexadecimal string".into(),
        });
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn split_minisign_lines(text: &str) -> Vec<&str> {
    text.trim_end_matches(['\r', '\n'])
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// Streaming RFC 7693 BLAKE2b-512 hasher (unkeyed, 64-byte output).
pub(crate) struct Blake2b512 {
    h: [u64; 8],
    t: u128,
    buf: [u8; 128],
    buf_len: usize,
}

impl Blake2b512 {
    const IV: [u64; 8] = [
        0x6a09_e667_f3bc_c908,
        0xbb67_ae85_84ca_a73b,
        0x3c6e_f372_fe94_f82b,
        0xa54f_f53a_5f1d_36f1,
        0x510e_527f_ade6_82d1,
        0x9b05_688c_2b3e_6c1f,
        0x1f83_d9ab_fb41_bd6b,
        0x5be0_cd19_137e_2179,
    ];

    const SIGMA: [[usize; 16]; 12] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
        [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
        [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
        [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
        [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
        [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
        [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
        [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
        [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    ];

    pub(crate) fn new() -> Self {
        let mut h = Self::IV;
        // Parameter block word 0: digest length 64 (0x40), key length 0, fanout 1, depth 1.
        h[0] ^= 0x0101_0040;
        Self {
            h,
            t: 0,
            buf: [0u8; 128],
            buf_len: 0,
        }
    }

    pub(crate) fn update(&mut self, mut input: &[u8]) {
        while !input.is_empty() {
            if self.buf_len == 128 {
                self.t = self.t.wrapping_add(128);
                let block = self.buf;
                self.compress(&block, false);
                self.buf_len = 0;
            }
            let take = (128 - self.buf_len).min(input.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&input[..take]);
            self.buf_len += take;
            input = &input[take..];
        }
    }

    pub(crate) fn finalize(mut self) -> [u8; 64] {
        self.t = self.t.wrapping_add(self.buf_len as u128);
        for slot in &mut self.buf[self.buf_len..] {
            *slot = 0;
        }
        let block = self.buf;
        self.compress(&block, true);
        let mut out = [0u8; 64];
        for (idx, word) in self.h.iter().enumerate() {
            out[idx * 8..(idx + 1) * 8].copy_from_slice(&word.to_le_bytes());
        }
        out
    }

    fn compress(&mut self, block: &[u8; 128], last: bool) {
        let mut m = [0u64; 16];
        for (idx, chunk) in block.chunks_exact(8).enumerate() {
            m[idx] = u64::from_le_bytes([
                chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7],
            ]);
        }

        let mut v = [0u64; 16];
        v[0..8].copy_from_slice(&self.h);
        v[8..16].copy_from_slice(&Self::IV);
        v[12] ^= self.t as u64;
        v[13] ^= (self.t >> 64) as u64;
        if last {
            v[14] = !v[14];
        }

        for s in &Self::SIGMA {
            mix(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
            mix(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
            mix(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
            mix(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
            mix(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
            mix(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
            mix(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
            mix(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
        }

        for idx in 0..8 {
            self.h[idx] ^= v[idx] ^ v[idx + 8];
        }
    }
}

#[inline]
fn mix(v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64) {
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
    v[d] = (v[d] ^ v[a]).rotate_right(32);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(24);
    v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
    v[d] = (v[d] ^ v[a]).rotate_right(16);
    v[c] = v[c].wrapping_add(v[d]);
    v[b] = (v[b] ^ v[c]).rotate_right(63);
}
