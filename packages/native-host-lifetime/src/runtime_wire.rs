//! Exact native-runtime-transport.ts sustained M/S wire. Broker JSON is internal only.
use crate::channel_wire::{self as wire, ChannelBootstrap};
use crate::{Error, Result};
use sha2::{Digest, Sha256};
pub(crate) const HEADER: usize = 62;
pub(crate) struct Packet {
    pub(crate) id: u32,
    pub(crate) opcode: u8,
    pub(crate) payload: Vec<u8>,
}
pub(crate) struct Decoder {
    buffer: Vec<u8>,
    sequence: u32,
}
pub(crate) fn unhex(s: &str) -> Result<Vec<u8>> {
    if !s.is_ascii() || !s.len().is_multiple_of(2) {
        return Err(Error("native-wire-hex"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| Error("native-wire-hex")))
        .collect()
}
pub(crate) fn digest(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for (i, k) in key.iter().enumerate() {
        inner[i] ^= k;
        outer[i] ^= k;
    }
    let mut h = Sha256::new();
    h.update(inner);
    h.update(bytes);
    let mut o = Sha256::new();
    o.update(outer);
    o.update(h.finalize());
    o.finalize().to_vec()
}
pub(crate) fn identity(boot: &ChannelBootstrap) -> Result<Vec<u8>> {
    let mut bytes = b"CNHRv001".to_vec();
    bytes.extend(unhex(&boot.profile)?);
    bytes.extend(unhex(&boot.generation.replace('-', ""))?);
    if bytes.len() != 56 {
        return Err(Error("native-wire-scope"));
    }
    Ok(bytes)
}
pub(crate) fn sign_receipt(boot: &ChannelBootstrap, value: &serde_json::Value) -> Result<Vec<u8>> {
    let data = serde_json::to_vec(value).map_err(|_| Error("native-receipt-encode"))?;
    if data.len() > 4064 {
        return Err(Error("native-receipt-bound"));
    }
    let signature = hmac(&unhex(&boot.receipt_secret)?, &data);
    let mut bytes = data;
    bytes.extend(signature);
    Ok(bytes)
}
pub(crate) fn verify_receipt(boot: &ChannelBootstrap, bytes: &[u8]) -> Result<serde_json::Value> {
    if !(32..=4096).contains(&bytes.len()) {
        return Err(Error("native-receipt-bound"));
    }
    let end = bytes.len() - 32;
    if !constant_equal(
        &bytes[end..],
        &hmac(&unhex(&boot.receipt_secret)?, &bytes[..end]),
    ) {
        return Err(Error("native-receipt-source"));
    }
    serde_json::from_slice(&bytes[..end]).map_err(|_| Error("native-receipt-json"))
}
pub(crate) fn constant_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |s, (a, b)| s | (a ^ b)) == 0
}
pub(crate) fn encode(
    boot: &ChannelBootstrap,
    id: u32,
    opcode: u8,
    direction: u8,
    payload: &[u8],
) -> Result<Vec<u8>> {
    if payload.len() > wire::MAX_FRAME || id == 0 || !(1..=4).contains(&opcode) {
        return Err(Error("native-wire-frame"));
    }
    let mut content = identity(boot)?;
    content.extend(id.to_le_bytes());
    content.extend([opcode, direction]);
    content.extend(payload);
    let signature = hmac(&unhex(&boot.secret)?, &content);
    let mut bytes = ((content.len() + 32) as u32).to_le_bytes().to_vec();
    bytes.extend(content);
    bytes.extend(signature);
    Ok(bytes)
}
impl Decoder {
    pub(crate) fn new() -> Self {
        Self {
            buffer: vec![],
            sequence: 0,
        }
    }
    pub(crate) fn append(&mut self, bytes: &[u8]) -> Result<()> {
        if self.buffer.len() + bytes.len() > wire::MAX_FRAME + HEADER + 36 {
            return Err(Error("native-wire-buffer"));
        }
        self.buffer.extend(bytes);
        Ok(())
    }
    pub(crate) fn take(&mut self, boot: &ChannelBootstrap) -> Result<Option<Packet>> {
        if self.buffer.len() < 4 {
            return Ok(None);
        }
        let size = u32::from_le_bytes(self.buffer[..4].try_into().unwrap()) as usize;
        if !(HEADER + 32..=wire::MAX_FRAME + HEADER + 32).contains(&size) {
            return Err(Error("native-wire-frame"));
        }
        if self.buffer.len() < size + 4 {
            return Ok(None);
        }
        let bytes: Vec<u8> = self.buffer.drain(..size + 4).skip(4).collect();
        let end = bytes.len() - 32;
        let content = &bytes[..end];
        if !constant_equal(&bytes[end..], &hmac(&unhex(&boot.secret)?, content))
            || content[..56] != identity(boot)?
            || content[61] != 0
        {
            return Err(Error("native-wire-auth"));
        }
        let id = u32::from_le_bytes(content[56..60].try_into().unwrap());
        let opcode = content[60];
        if id == 0
            || id
                != self
                    .sequence
                    .checked_add(1)
                    .ok_or(Error("native-wire-sequence"))?
            || !(1..=4).contains(&opcode)
        {
            return Err(Error("native-wire-sequence"));
        }
        self.sequence = id;
        Ok(Some(Packet {
            id,
            opcode,
            payload: content[HEADER..].to_vec(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn boot() -> ChannelBootstrap {
        ChannelBootstrap {
            v: 1,
            profile: "a".repeat(64),
            generation: "12345678-1234-1234-1234-123456789abc".into(),
            pipe: String::new(),
            secret: "b".repeat(64),
            receipt_secret: "c".repeat(64),
            control_pipe: String::new(),
            role: "manager".into(),
            supervisor: wire::Birth {
                pid: 1,
                creation_filetime: "1".into(),
            },
            peer: wire::Birth {
                pid: 2,
                creation_filetime: "2".into(),
            },
            application: serde_json::json!({}),
        }
    }
    #[test]
    fn sustained_fragmentation_and_sixteen_coalesced_calls() {
        let b = boot();
        let mut d = Decoder::new();
        let frames: Vec<u8> = (1..=16)
            .flat_map(|i| encode(&b, i, 1, 0, &[3; 36]).unwrap())
            .collect();
        for chunk in frames.chunks(7) {
            d.append(chunk).unwrap();
            while let Some(p) = d.take(&b).unwrap() {
                assert_eq!(p.opcode, 1);
                assert_eq!(p.payload, [3; 36]);
            }
        }
        assert_eq!(d.sequence, 16);
        assert!(d.buffer.is_empty());
    }
    #[test]
    fn wrong_profile_generation_nonce_mac_direction_and_replay_refuse() {
        let b = boot();
        let mut other = b.clone();
        other.profile = "d".repeat(64);
        let mut generation = b.clone();
        generation.generation = "22345678-1234-1234-1234-123456789abc".into();
        let mut nonce = b.clone();
        nonce.secret = "e".repeat(64);
        for bad in [
            encode(&other, 1, 1, 0, &[]).unwrap(),
            encode(&generation, 1, 1, 0, &[]).unwrap(),
            encode(&nonce, 1, 1, 0, &[]).unwrap(),
            encode(&b, 1, 1, 1, &[]).unwrap(),
            encode(&b, 2, 1, 0, &[]).unwrap(),
        ] {
            let mut d = Decoder::new();
            d.append(&bad).unwrap();
            assert!(d.take(&b).is_err());
        }
        let mut d = Decoder::new();
        let bytes = encode(&b, 1, 1, 0, &[]).unwrap();
        d.append(&bytes).unwrap();
        d.take(&b).unwrap();
        d.append(&bytes).unwrap();
        assert!(d.take(&b).is_err());
    }
    #[test]
    fn length_and_queue_overflow_refuse_before_allocation() {
        for n in [0, 93, 262239, u32::MAX] {
            let mut d = Decoder::new();
            d.append(&n.to_le_bytes()).unwrap();
            assert!(d.take(&boot()).is_err());
        }
        assert!(Decoder::new()
            .append(&vec![0; wire::MAX_FRAME + HEADER + 37])
            .is_err());
    }
    #[test]
    fn wire_key_cannot_forge_native_receipt() {
        let b = boot();
        let receipt = sign_receipt(&b, &serde_json::json!({"nonce":"native"})).unwrap();
        assert_eq!(verify_receipt(&b, &receipt).unwrap()["nonce"], "native");
        let mut forged = receipt[..receipt.len() - 32].to_vec();
        forged.extend(hmac(&unhex(&b.secret).unwrap(), &forged.clone()));
        assert!(verify_receipt(&b, &forged).is_err());
    }
}
