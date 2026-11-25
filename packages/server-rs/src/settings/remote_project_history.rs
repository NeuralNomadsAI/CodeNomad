use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt,
};

pub const RECENT_PROJECT_LIMIT: usize = 20;

/// Extracts `remoteProjectHistory` key order directly from raw JSON bytes in wire insertion order.
pub(super) fn json_history_key_order(bytes: &[u8]) -> Vec<String> {
    struct KeyList;
    impl<'de> DeserializeSeed<'de> for KeyList {
        type Value = Vec<String>;
        fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
            struct KeyVisitor;
            impl<'de> Visitor<'de> for KeyVisitor {
                type Value = Vec<String>;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("a JSON object")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                    let mut keys = Vec::new();
                    let mut seen = HashSet::new();
                    while let Some(key) = map.next_key::<String>()? {
                        let _ = map.next_value::<IgnoredAny>()?;
                        if seen.insert(key.clone()) {
                            keys.push(key);
                        }
                    }
                    Ok(keys)
                }
                fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                    while seq.next_element::<IgnoredAny>()?.is_some() {}
                    Ok(Vec::new())
                }
                fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
                fn visit_i64<E: de::Error>(self, _: i64) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
                fn visit_u64<E: de::Error>(self, _: u64) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
                fn visit_f64<E: de::Error>(self, _: f64) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
                fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
                fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
                fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                    Ok(Vec::new())
                }
            }
            deserializer.deserialize_any(KeyVisitor)
        }
    }
    struct RootVisitor;
    impl<'de> Visitor<'de> for RootVisitor {
        type Value = Vec<String>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut order = Vec::new();
            while let Some(key) = map.next_key::<String>()? {
                if key == "remoteProjectHistory" {
                    order = map.next_value_seed(KeyList)?;
                } else {
                    let _ = map.next_value::<IgnoredAny>()?;
                }
            }
            Ok(order)
        }
    }
    let mut de = serde_json::Deserializer::from_slice(bytes);
    de.deserialize_any(RootVisitor).unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ServerSelection {
    id: String,
    base_url: String,
    skip_tls_verify: bool,
    ssh_host: Option<String>,
}

impl ServerSelection {
    fn policy_key(&self) -> String {
        json!([&self.id, &self.base_url, self.skip_tls_verify, &self.ssh_host]).to_string()
    }

    fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), json!(self.id));
        map.insert("baseUrl".into(), json!(self.base_url));
        map.insert("skipTlsVerify".into(), json!(self.skip_tls_verify));
        if let Some(host) = &self.ssh_host {
            map.insert("ssh".into(), json!({ "host": host }));
        }
        Value::Object(map)
    }
}

#[derive(Clone, Debug)]
struct RecentRecord {
    policy: ServerSelection,
    path: String,
    last_accessed: f64,
    project_name: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct RecentEditMeta {
    project_name: Option<String>,
    opened_name: Option<String>,
}

fn normalize_workspace_path(folder_path: &str) -> String {
    let bytes = folder_path.as_bytes();
    let windows_like =
        (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
            || (bytes.len() >= 2 && matches!(bytes[0], b'/' | b'\\') && matches!(bytes[1], b'/' | b'\\'));
    let normalized = if windows_like { folder_path.replace('\\', "/").to_lowercase() } else { folder_path.to_owned() };
    let is_drive_root =
        normalized.len() == 3 && normalized.as_bytes()[0].is_ascii_lowercase() && &normalized[1..] == ":/";
    if normalized == "/" || is_drive_root { normalized } else { normalized.trim_end_matches('/').to_owned() }
}

/// Matches ECMAScript `WhiteSpace | LineTerminator` (excludes U+0085 NEL, includes U+FEFF BOM).
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

fn recent_project_name(value: Option<&Value>) -> Option<String> {
    let text = js_trim(value?.as_str()?);
    if text.is_empty() {
        return None;
    }
    // UTF-16 code unit cap matching JS `.slice(0, 256)`.
    let mut utf16 = 0usize;
    let mut end = 0usize;
    for (idx, ch) in text.char_indices() {
        let units = ch.len_utf16();
        if utf16 + units > 256 {
            break;
        }
        utf16 += units;
        end = idx + ch.len_utf8();
    }
    let trimmed = &text[..end];
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn normalize_server_selection(value: Option<&Value>) -> Option<ServerSelection> {
    let obj = value?.as_object()?;
    if obj.keys().any(|k| !matches!(k.as_str(), "id" | "baseUrl" | "skipTlsVerify" | "ssh")) {
        return None;
    }
    let id = obj.get("id")?.as_str()?;
    if id.is_empty()
        || id.len() > 64
        || id == "local"
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let base_url = obj.get("baseUrl")?.as_str()?;
    if base_url.encode_utf16().count() > 4096 {
        return None;
    }
    let skip_tls_verify = obj.get("skipTlsVerify")?.as_bool()?;
    let url = reqwest::Url::parse(base_url).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    let ssh_host = match obj.get("ssh") {
        None => None,
        Some(ssh) => {
            let ssh_obj = ssh.as_object()?;
            if ssh_obj.keys().any(|k| k != "host") {
                return None;
            }
            let host = ssh_obj.get("host")?.as_str()?;
            if host.is_empty()
                || host.encode_utf16().count() > 256
                || host.chars().any(|c| is_js_whitespace(c) || (c as u32) <= 0x1f)
            {
                return None;
            }
            Some(host.to_owned())
        }
    };
    Some(ServerSelection { id: id.to_owned(), base_url: base_url.to_owned(), skip_tls_verify, ssh_host })
}

fn recent_key(policy: &ServerSelection, path: &str) -> String {
    json!([&policy.id, &policy.base_url, policy.skip_tls_verify, &policy.ssh_host, normalize_workspace_path(path),])
        .to_string()
}

fn normalize_recent_record(obj: &Map<String, Value>) -> Option<RecentRecord> {
    let policy = normalize_server_selection(obj.get("policy"))?;
    let path = obj.get("path")?.as_str()?;
    if js_trim(path).is_empty()
        || path.encode_utf16().count() > 4096
        || path.contains('\0')
        || normalize_workspace_path(path).is_empty()
    {
        return None;
    }
    let last_accessed = obj.get("lastAccessed")?.as_f64()?;
    if !last_accessed.is_finite() || last_accessed < 0.0 {
        return None;
    }
    let last_accessed = if last_accessed == 0.0 { 0.0 } else { last_accessed };
    Some(RecentRecord {
        policy,
        path: path.to_owned(),
        last_accessed,
        project_name: recent_project_name(obj.get("projectName")),
    })
}

fn normalize_legacy_recents(legacy: Option<&Value>) -> Vec<RecentRecord> {
    let Some(items) = legacy.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut recents = Vec::new();
    for item in items.iter().take(RECENT_PROJECT_LIMIT) {
        let Some(obj) = item.as_object() else { continue };
        let Some(record) = normalize_recent_record(obj) else { continue };
        let key = recent_key(&record.policy, &record.path);
        if recents.iter().any(|existing: &RecentRecord| recent_key(&existing.policy, &existing.path) == key) {
            continue;
        }
        recents.push(record);
    }
    recents
}

fn number_value(v: f64) -> Value {
    if v.fract() == 0.0 && v >= 0.0 && v <= 9_007_199_254_740_991.0 { json!(v as u64) } else { json!(v) }
}

/// Port of `compactRemoteProjectHistory` (`packages/server/src/settings/remote-project-history.ts`).
pub(super) fn compact_doc(
    doc: &mut Map<String, Value>,
    before_merge: Option<&Map<String, Value>>,
    key_order: &[String],
) -> Option<Vec<String>> {
    let Some(ui) = doc.get("ui").and_then(Value::as_object) else {
        return None;
    };
    if !ui.contains_key("remoteProjectHistory") && !ui.contains_key("remoteProjectRecents") {
        return None;
    }
    let previous = before_merge
        .and_then(|before| before.get("ui"))
        .and_then(Value::as_object)
        .and_then(|ui| ui.get("remoteProjectHistory"))
        .and_then(Value::as_object);

    let mut records: HashMap<String, (usize, RecentRecord)> = HashMap::new();
    let mut next_order = 0usize;
    for item in normalize_legacy_recents(ui.get("remoteProjectRecents")) {
        let key = recent_key(&item.policy, &item.path);
        records.insert(key, (next_order, item));
        next_order += 1;
    }
    let mut edits: HashMap<String, RecentEditMeta> = HashMap::new();

    if let Some(keyed) = ui.get("remoteProjectHistory").and_then(Value::as_object) {
        let mut seen = HashSet::new();
        let mut ordered_keys: Vec<&String> = Vec::with_capacity(keyed.len());
        for key in key_order {
            if let Some((stored_key, _)) = keyed.get_key_value(key)
                && seen.insert(stored_key.as_str())
            {
                ordered_keys.push(stored_key);
            }
        }
        for key in keyed.keys() {
            if seen.insert(key.as_str()) {
                ordered_keys.push(key);
            }
        }
        for key in ordered_keys {
            let value = &keyed[key];
            let Some(edit_obj) = value.as_object() else { continue };
            if edit_obj.get("removed").and_then(Value::as_bool) == Some(true) {
                records.remove(key);
                continue;
            }
            let mut merged = Map::new();
            if let Some((_, existing)) = records.get(key) {
                merged.insert("policy".into(), existing.policy.to_json());
                merged.insert("path".into(), json!(existing.path));
                merged.insert("lastAccessed".into(), number_value(existing.last_accessed));
                if let Some(name) = &existing.project_name {
                    merged.insert("projectName".into(), json!(name));
                }
            }
            for (k, v) in edit_obj {
                merged.insert(k.clone(), v.clone());
            }
            let Some(mut record) = normalize_recent_record(&merged) else { continue };
            if recent_key(&record.policy, &record.path) != *key {
                continue;
            }
            if let Some(prev_access) = previous
                .and_then(|p| p.get(key))
                .and_then(Value::as_object)
                .and_then(|p| p.get("lastAccessed"))
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite())
            {
                record.last_accessed = record.last_accessed.max(prev_access);
            }
            let opened_name = edit_obj.get("openedName").and_then(Value::as_str).map(str::to_owned);
            let edit_project_name = record.project_name.clone();
            if record.project_name.is_none() {
                record.project_name = recent_project_name(edit_obj.get("openedName"));
            }
            if let Some((_, slot)) = records.get_mut(key) {
                *slot = record;
            } else {
                records.insert(key.clone(), (next_order, record));
                next_order += 1;
            }
            edits.insert(key.clone(), RecentEditMeta { project_name: edit_project_name, opened_name });
        }
    }

    let mut ordered_records: Vec<(usize, RecentRecord)> = records.into_values().collect();
    ordered_records
        .sort_by(|(a_ord, a), (b_ord, b)| b.last_accessed.total_cmp(&a.last_accessed).then_with(|| a_ord.cmp(b_ord)));
    let recents: Vec<RecentRecord> = ordered_records.into_iter().map(|(_, record)| record).collect();

    let mut active: HashSet<String> = HashSet::new();
    if let Some(servers) = ui.get("remoteServers").and_then(Value::as_array) {
        for profile in servers {
            let Some(obj) = profile.as_object() else { continue };
            let Some(name) = obj.get("name").and_then(Value::as_str) else { continue };
            if js_trim(name).is_empty() {
                continue;
            }
            let mut candidate = Map::new();
            if let Some(id) = obj.get("id").and_then(Value::as_str) {
                candidate.insert("id".into(), json!(js_trim(id)));
            }
            if let Some(base_url) = obj.get("baseUrl").and_then(Value::as_str) {
                candidate.insert("baseUrl".into(), json!(js_trim(base_url)));
            }
            candidate.insert("skipTlsVerify".into(), json!(js_truthy(obj.get("skipTlsVerify"))));
            if let Some(ssh) = obj.get("ssh") {
                if let Some(host) = ssh.as_object().and_then(|s| s.get("host")).and_then(Value::as_str) {
                    candidate.insert("ssh".into(), json!({ "host": js_trim(host) }));
                } else {
                    candidate.insert("ssh".into(), ssh.clone());
                }
            }
            if let Some(policy) = normalize_server_selection(Some(&Value::Object(candidate))) {
                active.insert(policy.policy_key());
            }
        }
    }

    let mut pinned: HashSet<String> = HashSet::new();
    let mut history = Map::new();
    let mut history_order = Vec::new();
    let mut recent_count = 0usize;
    for record in recents {
        let policy_id = record.policy.policy_key();
        if !active.contains(&policy_id) || (recent_count >= RECENT_PROJECT_LIMIT && pinned.contains(&policy_id)) {
            continue;
        }
        let key = recent_key(&record.policy, &record.path);
        let edit = edits.get(&key);
        let opened_name =
            edit.and_then(|e| e.opened_name.as_deref()).and_then(|s| recent_project_name(Some(&json!(s))));
        let mut entry = Map::new();
        entry.insert("policy".into(), record.policy.to_json());
        entry.insert("path".into(), json!(record.path));
        entry.insert("lastAccessed".into(), number_value(record.last_accessed));
        if let Some(project_name) = record.project_name
            && (edit.is_some_and(|e| e.project_name.is_some()) || opened_name.is_none())
        {
            entry.insert("projectName".into(), json!(project_name));
        }
        if let Some(opened_name) = opened_name {
            entry.insert("openedName".into(), json!(opened_name));
        }
        history_order.push(key.clone());
        history.insert(key, Value::Object(entry));
        recent_count += 1;
        pinned.insert(policy_id);
    }

    let mut next_ui = ui.clone();
    next_ui.insert("remoteProjectHistory".into(), Value::Object(history));
    next_ui.remove("remoteProjectRecents");
    doc.insert("ui".into(), Value::Object(next_ui));
    Some(history_order)
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// Serializes a `state/ui` JSON object while keeping `remoteProjectHistory` keys in their YAML/compacted order.
pub(super) struct OrderedStateOwner<'a>(pub &'a Map<String, Value>, pub &'a [String]);

struct OrderedHistoryMap<'a>(&'a Map<String, Value>, &'a [String]);

impl serde::Serialize for OrderedHistoryMap<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        let mut seen = HashSet::with_capacity(self.1.len());
        for key in self.1 {
            if let Some((stored_key, value)) = self.0.get_key_value(key)
                && seen.insert(stored_key.as_str())
            {
                map.serialize_entry(stored_key, value)?;
            }
        }
        for (key, value) in self.0 {
            if seen.insert(key.as_str()) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

impl serde::Serialize for OrderedStateOwner<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in self.0 {
            if key == "remoteProjectHistory"
                && !self.1.is_empty()
                && let Some(history) = value.as_object()
            {
                map.serialize_entry(key, &OrderedHistoryMap(history, self.1))?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
