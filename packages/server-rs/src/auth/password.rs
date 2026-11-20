//! Password records and `auth.json` in the reference's format (`password-hash.ts`, `auth-store.ts`),
//! so either server reads the other's file.
use std::{fs, path::Path};

use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    algorithm: String,
    salt_base64: String,
    hash_base64: String,
    key_length: usize,
    params: Params,
}
#[derive(Serialize, Deserialize, Clone)]
struct Params {
    #[serde(rename = "N")]
    n: u64,
    r: u32,
    p: u32,
    maxmem: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthFile {
    pub version: u8,
    pub username: String,
    pub password: Record,
    pub user_provided: bool,
    pub updated_at: String,
}

fn scrypt(password: &str, salt: &[u8], params: &Params, length: usize) -> Option<Vec<u8>> {
    // Node refuses 128·N·r above maxmem; the file is also bounded here (256 MiB, 1 KiB keys).
    let memory = 128u64.checked_mul(params.n)?.checked_mul(params.r.into())?;
    if !params.n.is_power_of_two()
        || params.n < 2
        || memory > params.maxmem.min(256 << 20)
        || !(1..=1024).contains(&length)
    {
        return None;
    }
    let params = scrypt::Params::new(params.n.trailing_zeros() as u8, params.r, params.p, length).ok()?;
    let mut output = vec![0; length];
    scrypt::scrypt(password.as_bytes(), salt, &params, &mut output).ok()?;
    Some(output)
}

impl Record {
    /// N=16384, r=8, p=1, 64-byte key, random 16-byte salt.
    pub fn new(password: &str) -> Result<Self, &'static str> {
        let mut salt = [0; 16];
        getrandom::fill(&mut salt).map_err(|_| "Secure random source unavailable")?;
        let params = Params { n: 16384, r: 8, p: 1, maxmem: 32 << 20 };
        let hash = scrypt(password, &salt, &params, 64).ok_or("Password hashing failed")?;
        Ok(Self {
            algorithm: "scrypt".into(),
            salt_base64: STANDARD.encode(salt),
            hash_base64: STANDARD.encode(hash),
            key_length: 64,
            params,
        })
    }
    pub fn verify(&self, password: &str) -> bool {
        let (Ok(salt), Ok(expected)) = (STANDARD.decode(&self.salt_base64), STANDARD.decode(&self.hash_base64)) else {
            return false;
        };
        self.algorithm == "scrypt"
            && scrypt(password, &salt, &self.params, self.key_length)
                .is_some_and(|derived| derived.len() == expected.len() && bool::from(derived.ct_eq(&expected)))
    }
}

/// A missing, unreadable or other-version file reads as absent, as in the reference.
pub fn load(path: &Path) -> Option<AuthFile> {
    let file: AuthFile = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (file.version == 1).then_some(file)
}

pub fn save(path: &Path, file: &AuthFile) -> std::io::Result<()> {
    fs::create_dir_all(path.parent().unwrap_or(Path::new(".")))?;
    crate::auth::tls::write_private(path, serde_json::to_string_pretty(file)?.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `hashPasswordSync("correct horse", Buffer.alloc(16, 7))`.
    #[test]
    fn verifies_reference_records_and_bounds_parameters() {
        let record: Record = serde_json::from_str(
            r#"{"algorithm":"scrypt","saltBase64":"BwcHBwcHBwcHBwcHBwcHBw==","hashBase64":
            "5TRHB2ApnfGdNDl3bNPaEguAozb+v0jyBBXcGVyselY7jfrf29WRCzvD5ZjsxkhZIzn8Zw7uCBKGN3SSwYSMxQ==",
            "keyLength":64,"params":{"N":16384,"r":8,"p":1,"maxmem":33554432}}"#,
        )
        .unwrap();
        assert!(record.verify("correct horse") && !record.verify("correct horse "));
        let fresh = Record::new("another").unwrap();
        assert!(fresh.verify("another") && !fresh.verify("Another"));
        let json = serde_json::to_value(&fresh).unwrap();
        assert_eq!(json["params"], serde_json::json!({"N":16384,"r":8,"p":1,"maxmem":33554432}));
        for bad in [
            r#"{"N":16384,"r":8,"p":1,"maxmem":1024}"#,
            r#"{"N":1000,"r":8,"p":1,"maxmem":33554432}"#,
            r#"{"N":1048576,"r":8,"p":1,"maxmem":4294967296}"#,
        ] {
            let mut value = serde_json::to_value(&record).unwrap();
            value["params"] = serde_json::from_str(bad).unwrap();
            assert!(!serde_json::from_value::<Record>(value).unwrap().verify("correct horse"));
        }
    }
}
