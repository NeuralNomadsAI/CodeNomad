//! Streaming, zero-`Value` deserializer for `/session/{id}/permission` responses.
use crate::{
    agent_api::{Permission, ToolSource},
    history::{Result, valid_id},
};
use futures_lite::StreamExt;
use reqwest::Response;
use serde::de::{
    DeserializeSeed, Deserializer, Error as DeError, IgnoredAny, MapAccess, SeqAccess, Visitor,
};
use serde_json::Value;
use std::{collections::HashMap, fmt};

const MAX_PERMISSIONS: usize = 128;
const MAX_FIELD_BYTES: usize = 4096;
const MAX_RESOURCES: usize = 64;
#[cfg(not(target_arch = "wasm32"))]
const INLINE_BYTES: usize = 256 * 1024;
// Hard wire ceiling for streaming native reads (O(1) RAM; prevents infinite hostile streams).
#[cfg(not(target_arch = "wasm32"))]
const STREAM_MAX_BYTES: usize = 128 * 1024 * 1024;
// Buffered wire ceiling on wasm32 where bytes_stream cannot drive synchronous from_reader.
#[cfg(target_arch = "wasm32")]
const WASM_MAX_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn truncate_utf8(value: &str, max_bytes: usize) -> (&str, bool) {
    if value.len() <= max_bytes {
        (value, false)
    } else {
        (&value[..value.floor_char_boundary(max_bytes)], true)
    }
}

pub(crate) fn parse_value(value: &Value, session: &str) -> Result<Vec<Permission>> {
    PermissionsSeed { session }
        .deserialize(value)
        .map_err(Into::into)
}

pub(crate) fn parse_slice(bytes: &[u8], session: &str) -> Result<Vec<Permission>> {
    let mut de = serde_json::Deserializer::from_slice(bytes);
    let out = PermissionsSeed { session }.deserialize(&mut de)?;
    de.end()?;
    Ok(out)
}

#[cfg(not(target_arch = "wasm32"))]
fn parse_reader<R: std::io::Read>(reader: R, session: &str) -> Result<Vec<Permission>> {
    let mut de =
        serde_json::Deserializer::from_reader(std::io::BufReader::with_capacity(16 * 1024, reader));
    let out = PermissionsSeed { session }.deserialize(&mut de)?;
    de.end()?;
    Ok(out)
}

pub(crate) async fn read_permissions(response: Response, session: &str) -> Result<Vec<Permission>> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        read_permissions_with_limits(response, session, INLINE_BYTES, STREAM_MAX_BYTES).await
    }
    #[cfg(target_arch = "wasm32")]
    {
        read_permissions_buffered(response, session, WASM_MAX_BYTES).await
    }
}

#[cfg(target_arch = "wasm32")]
async fn read_permissions_buffered(
    response: Response,
    session: &str,
    max_bytes: usize,
) -> Result<Vec<Permission>> {
    let mut bytes = Vec::new();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
            return Err("oversized response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_slice(&bytes, session)
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn read_permissions_with_limits(
    response: Response,
    session: &str,
    inline_limit: usize,
    max_bytes: usize,
) -> Result<Vec<Permission>> {
    let mut buf = Vec::new();
    let mut chunks = response.bytes_stream();
    let overflow = loop {
        match chunks.next().await {
            None => return parse_slice(&buf, session),
            Some(Err(error)) => return Err(error.into()),
            Some(Ok(chunk)) => {
                if chunk.len() > max_bytes.saturating_sub(buf.len()) {
                    return Err("oversized response".into());
                }
                if chunk.len() <= inline_limit.saturating_sub(buf.len()) {
                    buf.extend_from_slice(&chunk);
                } else {
                    break chunk;
                }
            }
        }
    };

    let mut total = buf.len() + overflow.len();
    let (tx, rx) = async_channel::bounded::<Vec<u8>>(4);
    let session_owned = session.to_owned();
    let reader = ChannelReader {
        head: buf,
        head_pos: 0,
        rx,
    };
    let parse_task = tokio::task::spawn_blocking(move || parse_reader(reader, &session_owned));

    let mut stream_err: Option<Box<dyn std::error::Error + Send + Sync>> = None;
    if tx.send(overflow.to_vec()).await.is_ok() {
        while let Some(next) = chunks.next().await {
            if tx.is_closed() {
                break;
            }
            match next {
                Err(error) => {
                    stream_err = Some(error.into());
                    break;
                }
                Ok(chunk) => {
                    if chunk.len() > max_bytes.saturating_sub(total) {
                        stream_err = Some("oversized response".into());
                        break;
                    }
                    total += chunk.len();
                    if tx.send(chunk.to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    drop(tx);
    let parsed = parse_task.await;
    if let Some(error) = stream_err {
        return Err(error);
    }
    parsed.map_err(|_| "permission parser cancelled")?
}

#[cfg(not(target_arch = "wasm32"))]
struct ChannelReader {
    head: Vec<u8>,
    head_pos: usize,
    rx: async_channel::Receiver<Vec<u8>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl std::io::Read for ChannelReader {
    fn read(&mut self, dst: &mut [u8]) -> std::io::Result<usize> {
        if dst.is_empty() {
            return Ok(0);
        }
        while self.head_pos >= self.head.len() {
            match self.rx.recv_blocking() {
                Ok(chunk) => {
                    self.head = chunk;
                    self.head_pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let avail = &self.head[self.head_pos..];
        let n = avail.len().min(dst.len());
        dst[..n].copy_from_slice(&avail[..n]);
        self.head_pos += n;
        if self.head_pos >= self.head.len() {
            self.head = Vec::new();
            self.head_pos = 0;
        }
        Ok(n)
    }
}

fn drain_seq<'de, A: SeqAccess<'de>>(mut seq: A) -> std::result::Result<(), A::Error> {
    while seq.next_element::<IgnoredAny>()?.is_some() {}
    Ok(())
}

fn drain_map<'de, A: MapAccess<'de>>(mut map: A) -> std::result::Result<(), A::Error> {
    while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
    Ok(())
}

struct PermissionsSeed<'a> {
    session: &'a str,
}

impl<'de, 'a> DeserializeSeed<'de> for PermissionsSeed<'a> {
    type Value = Vec<Permission>;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_any(EnvelopeVisitor {
            session: self.session,
        })
    }
}

struct EnvelopeVisitor<'a> {
    session: &'a str,
}

impl<'de, 'a> Visitor<'de> for EnvelopeVisitor<'a> {
    type Value = Vec<Permission>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("pending permissions envelope")
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut data: Option<Vec<Permission>> = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "data" {
                data = Some(map.next_value_seed(PermissionListSeed {
                    session: self.session,
                })?);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        data.ok_or_else(|| DeError::custom("invalid pending permissions"))
    }
}

struct PermissionListSeed<'a> {
    session: &'a str,
}

impl<'de, 'a> DeserializeSeed<'de> for PermissionListSeed<'a> {
    type Value = Vec<Permission>;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_any(PermissionListVisitor {
            session: self.session,
        })
    }
}

struct PermissionListVisitor<'a> {
    session: &'a str,
}

impl<'de, 'a> Visitor<'de> for PermissionListVisitor<'a> {
    type Value = Vec<Permission>;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("pending permissions array")
    }

    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut out: Vec<Permission> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        while let Some(outcome) = seq.next_element_seed(PermissionRowSeed {
            session: self.session,
            cap_reached: out.len() >= MAX_PERMISSIONS,
        })? {
            match outcome {
                RowOutcome::Skip => {}
                RowOutcome::IdOnly(id) => {
                    if let Some(&existing) = seen.get(&id) {
                        out[existing].supported = false;
                    }
                }
                RowOutcome::Entry(permission) => {
                    if let Some(&existing) = seen.get(&permission.id) {
                        out[existing].supported = false;
                        continue;
                    }
                    if out.len() >= MAX_PERMISSIONS {
                        continue;
                    }
                    seen.insert(permission.id.clone(), out.len());
                    out.push(permission);
                }
            }
        }
        Ok(out)
    }
}

enum RowOutcome {
    Skip,
    IdOnly(String),
    Entry(Permission),
}

enum KeyIdField {
    Absent,
    Invalid,
    Valid(String),
}

impl KeyIdField {
    fn or(self, other: Self) -> Self {
        match self {
            Self::Absent => other,
            present => present,
        }
    }
}

struct PermissionRowSeed<'a> {
    session: &'a str,
    cap_reached: bool,
}

impl<'de, 'a> DeserializeSeed<'de> for PermissionRowSeed<'a> {
    type Value = RowOutcome;

    fn deserialize<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Self::Value, D::Error> {
        deserializer.deserialize_any(PermissionRowVisitor {
            session: self.session,
            cap_reached: self.cap_reached,
        })
    }
}

struct PermissionRowVisitor<'a> {
    session: &'a str,
    cap_reached: bool,
}

impl<'de, 'a> Visitor<'de> for PermissionRowVisitor<'a> {
    type Value = RowOutcome;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("permission row")
    }

    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(RowOutcome::Skip)
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(RowOutcome::Skip)
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(RowOutcome::Skip)
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok(RowOutcome::Skip)
    }
    fn visit_str<E: DeError>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok(RowOutcome::Skip)
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Self::Value, E> {
        Ok(RowOutcome::Skip)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Self::Value, A::Error> {
        drain_seq(seq)?;
        Ok(RowOutcome::Skip)
    }

    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut session_ok = false;
        let mut id: Option<String> = None;
        let mut action: Option<(String, bool)> = None;
        let mut resources: Option<(Vec<String>, bool)> = None;
        let mut message: Option<(String, bool)> = None;
        let mut part_id_upper = KeyIdField::Absent;
        let mut part_id_camel = KeyIdField::Absent;
        let mut metadata = MetadataIds::default();
        let mut source = SourceFields::default();

        while let Some(key) = map.next_key::<String>()? {
            if key == "sessionID" {
                let matched = map.next_value_seed(SessionMatchSeed {
                    session: self.session,
                })?;
                if !matched {
                    return Err(DeError::custom("foreign permission"));
                }
                session_ok = true;
                continue;
            }
            if key == "id" {
                id = map.next_value_seed(ValidIdSeed)?;
                continue;
            }
            if self.cap_reached {
                map.next_value::<IgnoredAny>()?;
                continue;
            }
            match key.as_str() {
                "action" => action = Some(map.next_value_seed(TruncatedStringSeed)?),
                "resources" => resources = Some(map.next_value_seed(ResourcesSeed)?),
                "message" => message = Some(map.next_value_seed(OptionalMessageSeed)?),
                "partID" => part_id_upper = map.next_value_seed(KeyIdSeed)?,
                "partId" => part_id_camel = map.next_value_seed(KeyIdSeed)?,
                "metadata" => metadata = map.next_value_seed(MetadataSeed)?,
                "source" => source = map.next_value_seed(SourceSeed)?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }

        if !session_ok {
            return Err(DeError::custom("foreign permission"));
        }
        let Some(id) = id else {
            return Ok(RowOutcome::Skip);
        };
        if self.cap_reached {
            return Ok(RowOutcome::IdOnly(id));
        }

        let mut bounded = false;
        let action = match action {
            Some((text, truncated)) => {
                bounded |= truncated;
                text
            }
            None => {
                bounded = true;
                String::new()
            }
        };
        let resources = match resources {
            Some((items, truncated)) => {
                bounded |= truncated;
                items
            }
            None => {
                bounded = true;
                Vec::new()
            }
        };
        let message = match message {
            Some((text, truncated)) => {
                bounded |= truncated;
                text
            }
            None => String::new(),
        };

        let call_slot = part_id_upper
            .or(part_id_camel)
            .or(metadata.part_id_upper)
            .or(metadata.part_id_camel)
            .or(source.id_as_valid);
        let explicit_tool = match (&source.message_id, &call_slot) {
            (Some(msg), KeyIdField::Valid(call)) => Some(ToolSource {
                message: msg.clone(),
                call: call.clone(),
            }),
            _ => None,
        };
        let fallback_tool = if source.is_tool {
            match (&source.message_id, &source.id_raw) {
                (Some(msg), Some(call)) => Some(ToolSource {
                    message: msg.clone(),
                    call: call.clone(),
                }),
                _ => None,
            }
        } else {
            None
        };

        Ok(RowOutcome::Entry(Permission {
            id,
            action,
            resources,
            message,
            supported: !bounded,
            tool: explicit_tool.or(fallback_tool),
        }))
    }
}

struct SessionMatchSeed<'a> {
    session: &'a str,
}

impl<'de, 'a> DeserializeSeed<'de> for SessionMatchSeed<'a> {
    type Value = bool;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<bool, D::Error> {
        d.deserialize_any(SessionMatchVisitor {
            session: self.session,
        })
    }
}

struct SessionMatchVisitor<'a> {
    session: &'a str,
}

impl<'de, 'a> Visitor<'de> for SessionMatchVisitor<'a> {
    type Value = bool;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("sessionID")
    }
    fn visit_str<E: DeError>(self, v: &str) -> std::result::Result<bool, E> {
        Ok(v == self.session)
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<bool, E> {
        Ok(false)
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<bool, E> {
        Ok(false)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<bool, A::Error> {
        drain_seq(seq)?;
        Ok(false)
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<bool, A::Error> {
        drain_map(map)?;
        Ok(false)
    }
}

struct ValidIdSeed;

impl<'de> DeserializeSeed<'de> for ValidIdSeed {
    type Value = Option<String>;
    fn deserialize<D: Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<Option<String>, D::Error> {
        d.deserialize_any(ValidIdVisitor)
    }
}

struct ValidIdVisitor;

impl<'de> Visitor<'de> for ValidIdVisitor {
    type Value = Option<String>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("valid id")
    }
    fn visit_str<E: DeError>(self, v: &str) -> std::result::Result<Option<String>, E> {
        Ok(valid_id(v).then(|| v.to_owned()))
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Option<String>, E> {
        Ok(None)
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Option<String>, E> {
        Ok(None)
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Option<String>, E> {
        Ok(None)
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Option<String>, E> {
        Ok(None)
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Option<String>, E> {
        Ok(None)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Option<String>, A::Error> {
        drain_seq(seq)?;
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Option<String>, A::Error> {
        drain_map(map)?;
        Ok(None)
    }
}

struct KeyIdSeed;

impl<'de> DeserializeSeed<'de> for KeyIdSeed {
    type Value = KeyIdField;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<KeyIdField, D::Error> {
        Ok(match ValidIdSeed.deserialize(d)? {
            Some(id) => KeyIdField::Valid(id),
            None => KeyIdField::Invalid,
        })
    }
}

struct TruncatedStringSeed;

impl<'de> DeserializeSeed<'de> for TruncatedStringSeed {
    type Value = (String, bool);
    fn deserialize<D: Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<(String, bool), D::Error> {
        d.deserialize_any(TruncatedStringVisitor { null_is_ok: false })
    }
}

struct OptionalMessageSeed;

impl<'de> DeserializeSeed<'de> for OptionalMessageSeed {
    type Value = (String, bool);
    fn deserialize<D: Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<(String, bool), D::Error> {
        d.deserialize_any(TruncatedStringVisitor { null_is_ok: true })
    }
}

struct TruncatedStringVisitor {
    null_is_ok: bool,
}

impl<'de> Visitor<'de> for TruncatedStringVisitor {
    type Value = (String, bool);
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded string")
    }
    fn visit_str<E: DeError>(self, v: &str) -> std::result::Result<(String, bool), E> {
        let (text, truncated) = truncate_utf8(v, MAX_FIELD_BYTES);
        Ok((text.to_owned(), truncated))
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<(String, bool), E> {
        Ok((String::new(), !self.null_is_ok))
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<(String, bool), E> {
        Ok((String::new(), true))
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<(String, bool), E> {
        Ok((String::new(), true))
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<(String, bool), E> {
        Ok((String::new(), true))
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<(String, bool), E> {
        Ok((String::new(), true))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<(String, bool), A::Error> {
        drain_seq(seq)?;
        Ok((String::new(), true))
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<(String, bool), A::Error> {
        drain_map(map)?;
        Ok((String::new(), true))
    }
}

struct ResourceItemSeed;

impl<'de> DeserializeSeed<'de> for ResourceItemSeed {
    type Value = Option<(String, bool)>;
    fn deserialize<D: Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<Option<(String, bool)>, D::Error> {
        d.deserialize_any(ResourceItemVisitor)
    }
}

struct ResourceItemVisitor;

impl<'de> Visitor<'de> for ResourceItemVisitor {
    type Value = Option<(String, bool)>;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("resource item")
    }
    fn visit_str<E: DeError>(self, v: &str) -> std::result::Result<Self::Value, E> {
        let (text, truncated) = truncate_utf8(v, MAX_FIELD_BYTES);
        Ok(Some((text.to_owned(), truncated)))
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Self::Value, E> {
        Ok(None)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Self::Value, A::Error> {
        drain_seq(seq)?;
        Ok(None)
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Self::Value, A::Error> {
        drain_map(map)?;
        Ok(None)
    }
}

struct ResourcesSeed;

impl<'de> DeserializeSeed<'de> for ResourcesSeed {
    type Value = (Vec<String>, bool);
    fn deserialize<D: Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<(Vec<String>, bool), D::Error> {
        d.deserialize_any(ResourcesVisitor)
    }
}

struct ResourcesVisitor;

impl<'de> Visitor<'de> for ResourcesVisitor {
    type Value = (Vec<String>, bool);
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("resources array")
    }
    fn visit_seq<A: SeqAccess<'de>>(
        self,
        mut seq: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        let mut bounded = false;
        let mut count = 0usize;
        while count < MAX_RESOURCES {
            let Some(item) = seq.next_element_seed(ResourceItemSeed)? else {
                return Ok((items, bounded));
            };
            count += 1;
            match item {
                Some((text, truncated)) => {
                    bounded |= truncated;
                    items.push(text);
                }
                None => bounded = true,
            }
        }
        while seq.next_element::<IgnoredAny>()?.is_some() {
            bounded = true;
        }
        Ok((items, bounded))
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok((Vec::new(), true))
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok((Vec::new(), true))
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok((Vec::new(), true))
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok((Vec::new(), true))
    }
    fn visit_str<E: DeError>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok((Vec::new(), true))
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Self::Value, E> {
        Ok((Vec::new(), true))
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Self::Value, A::Error> {
        drain_map(map)?;
        Ok((Vec::new(), true))
    }
}

struct MetadataIds {
    part_id_upper: KeyIdField,
    part_id_camel: KeyIdField,
}

impl Default for MetadataIds {
    fn default() -> Self {
        Self {
            part_id_upper: KeyIdField::Absent,
            part_id_camel: KeyIdField::Absent,
        }
    }
}

struct MetadataSeed;

impl<'de> DeserializeSeed<'de> for MetadataSeed {
    type Value = MetadataIds;
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<MetadataIds, D::Error> {
        d.deserialize_any(MetadataVisitor)
    }
}

struct MetadataVisitor;

impl<'de> Visitor<'de> for MetadataVisitor {
    type Value = MetadataIds;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("permission metadata")
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut out = MetadataIds::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "partID" => out.part_id_upper = map.next_value_seed(KeyIdSeed)?,
                "partId" => out.part_id_camel = map.next_value_seed(KeyIdSeed)?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(out)
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(MetadataIds::default())
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(MetadataIds::default())
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(MetadataIds::default())
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok(MetadataIds::default())
    }
    fn visit_str<E: DeError>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok(MetadataIds::default())
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Self::Value, E> {
        Ok(MetadataIds::default())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Self::Value, A::Error> {
        drain_seq(seq)?;
        Ok(MetadataIds::default())
    }
}

struct SourceFields {
    is_tool: bool,
    message_id: Option<String>,
    id_as_valid: KeyIdField,
    id_raw: Option<String>,
}

impl Default for SourceFields {
    fn default() -> Self {
        Self {
            is_tool: false,
            message_id: None,
            id_as_valid: KeyIdField::Absent,
            id_raw: None,
        }
    }
}

struct SourceSeed;

impl<'de> DeserializeSeed<'de> for SourceSeed {
    type Value = SourceFields;
    fn deserialize<D: Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<SourceFields, D::Error> {
        d.deserialize_any(SourceVisitor)
    }
}

struct SourceVisitor;

impl<'de> Visitor<'de> for SourceVisitor {
    type Value = SourceFields;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("permission source")
    }
    fn visit_map<A: MapAccess<'de>>(
        self,
        mut map: A,
    ) -> std::result::Result<Self::Value, A::Error> {
        let mut out = SourceFields::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "type" => {
                    out.is_tool = map.next_value_seed(SessionMatchSeed { session: "tool" })?
                }
                "messageID" => out.message_id = map.next_value_seed(ValidIdSeed)?,
                "id" => {
                    let (valid, raw) = map.next_value_seed(SourceIdSeed)?;
                    out.id_as_valid = valid;
                    out.id_raw = raw;
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(out)
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(SourceFields::default())
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(SourceFields::default())
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(SourceFields::default())
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok(SourceFields::default())
    }
    fn visit_str<E: DeError>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok(SourceFields::default())
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Self::Value, E> {
        Ok(SourceFields::default())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Self::Value, A::Error> {
        drain_seq(seq)?;
        Ok(SourceFields::default())
    }
}

struct SourceIdSeed;

impl<'de> DeserializeSeed<'de> for SourceIdSeed {
    type Value = (KeyIdField, Option<String>);
    fn deserialize<D: Deserializer<'de>>(self, d: D) -> std::result::Result<Self::Value, D::Error> {
        d.deserialize_any(SourceIdVisitor)
    }
}

struct SourceIdVisitor;

impl<'de> Visitor<'de> for SourceIdVisitor {
    type Value = (KeyIdField, Option<String>);
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("source id")
    }
    fn visit_str<E: DeError>(self, v: &str) -> std::result::Result<Self::Value, E> {
        let valid = if valid_id(v) {
            KeyIdField::Valid(v.to_owned())
        } else {
            KeyIdField::Invalid
        };
        let raw = (!v.is_empty() && v.len() <= 512).then(|| v.to_owned());
        Ok((valid, raw))
    }
    fn visit_bool<E: DeError>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok((KeyIdField::Invalid, None))
    }
    fn visit_i64<E: DeError>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok((KeyIdField::Invalid, None))
    }
    fn visit_u64<E: DeError>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok((KeyIdField::Invalid, None))
    }
    fn visit_f64<E: DeError>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok((KeyIdField::Invalid, None))
    }
    fn visit_unit<E: DeError>(self) -> std::result::Result<Self::Value, E> {
        Ok((KeyIdField::Invalid, None))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Self::Value, A::Error> {
        drain_seq(seq)?;
        Ok((KeyIdField::Invalid, None))
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Self::Value, A::Error> {
        drain_map(map)?;
        Ok((KeyIdField::Invalid, None))
    }
}
