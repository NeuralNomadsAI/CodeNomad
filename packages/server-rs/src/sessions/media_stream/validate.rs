//! Bounded JSON structural validators and O(1)-memory session record extraction.
use super::{
    scan::{for_each_json_array_item, for_each_json_object_field, parse_short_string, parse_string},
    syntax::JsonSyntax,
};

/// Checks that a JSON payload has at most `limit` structural container/item delimiters (`{`, `[`,
/// `,` outside string literals) in O(1) memory, preventing dense numeric arrays from amplifying
/// multi-MiB HTTP bodies into hundreds of MiB of `serde_json::Value` heap allocations.
pub(crate) fn json_node_count_within(bytes: &[u8], limit: usize) -> bool {
    json_bounds_within(bytes, limit, usize::MAX)
}

/// Checks both structural node count and maximum raw string token length in O(1) memory so
/// `serde_json::from_str::<Value>` cannot expand a single multi-MiB escaped string into a
/// multi-MiB scratch buffer + owned `String` above the caller's memory reservation.
pub(crate) fn json_bounds_within(bytes: &[u8], node_limit: usize, max_string_bytes: usize) -> bool {
    let mut count = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    let mut string_len = 0usize;
    for &b in bytes {
        if in_string {
            if escaped {
                escaped = false;
                string_len += 1;
            } else if b == b'\\' {
                escaped = true;
                string_len += 1;
            } else if b == b'"' {
                in_string = false;
                string_len = 0;
            } else {
                string_len += 1;
            }
            if in_string && string_len > max_string_bytes {
                return false;
            }
        } else {
            match b {
                b'"' => {
                    in_string = true;
                    string_len = 0;
                }
                b'{' | b'[' | b',' => {
                    count += 1;
                    if count > node_limit {
                        return false;
                    }
                }
                _ => {}
            }
        }
    }
    true
}

/// Validates full RFC 8259 JSON syntax on a native `GET /api/session/:id` response and extracts
/// only `id`, `projectID`, `location.{directory,workspaceID}`, and `revert` without allocating a
/// `serde_json::Value` tree over ignored fields.
/// Zero-allocation validator for `reference-v1` user message `files` arrays (matching
/// `user_files::reference`): avoids allocating a `serde_json::Value` tree even when a file entry
/// carries a multi-megabyte `name`, while strictly checking every key and value type.
pub(crate) fn valid_reference_files(raw: &str, max_count: usize) -> bool {
    let mut count = 0usize;
    let mut ok = true;
    for_each_json_array_item(raw, max_count + 1, |_idx, item| {
        if !ok {
            return;
        }
        count += 1;
        if count > max_count || !item.trim_start().starts_with('{') {
            ok = false;
            return;
        }
        let (mut has_mime, mut has_source) = (false, false);
        if for_each_json_object_field(item, |k, v| {
            if !ok {
                return;
            }
            let vt = v.trim();
            match k {
                "name" => {
                    if !vt.starts_with('"') {
                        ok = false;
                    }
                }
                "mime" => {
                    // Match TS `user-file-reference.ts:24-31`: any JSON string (including `""`).
                    if !vt.starts_with('"') {
                        ok = false;
                    } else {
                        has_mime = true;
                    }
                }
                "source" => {
                    if !vt.starts_with('{') {
                        ok = false;
                        return;
                    }
                    let (mut has_type, mut has_sha, mut kind, mut sha) = (false, false, None, None);
                    if for_each_json_object_field(vt, |sk, sv| {
                        let svt = sv.trim();
                        match sk {
                            "type" => {
                                has_type = true;
                                kind = parse_short_string(svt, 128);
                            }
                            "sha256" => {
                                has_sha = true;
                                sha = parse_short_string(svt, 512);
                            }
                            _ => ok = false,
                        }
                    })
                    .is_none()
                    {
                        ok = false;
                        return;
                    }
                    let source_ok = match kind.as_deref() {
                        Some("unavailable") => has_type && !has_sha,
                        Some("deferred") => {
                            has_type && has_sha && sha.as_deref().is_some_and(crate::sessions::user_files::valid_digest)
                        }
                        _ => false,
                    };
                    if source_ok {
                        has_source = true;
                    } else {
                        ok = false;
                    }
                }
                _ => ok = false,
            }
        })
        .is_none()
            || !has_mime
            || !has_source
        {
            ok = false;
        }
    })
    .is_some()
        && ok
}

pub(crate) fn extract_session_record(raw: &[u8], id: &str, strict_id: bool) -> Result<serde_json::Value, ()> {
    let raw = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw);
    let text = std::str::from_utf8(raw).map_err(|_| ())?;
    let mut syntax = JsonSyntax::new();
    syntax.feed(raw);
    if !syntax.is_valid_eof() {
        return Err(());
    }
    let mut has_data = false;
    let mut data_raw: Option<&str> = None;
    for_each_json_object_field(text, |k, v| {
        if k == "data" {
            has_data = true;
            data_raw = Some(v);
        }
    })
    .ok_or(())?;
    let obj_raw = if has_data { data_raw.ok_or(())?.trim() } else { text.trim() };
    if !obj_raw.starts_with('{') {
        return Err(());
    }
    let (mut id_raw, mut project_raw, mut location_raw, mut revert_raw) = (None, None, None, None);
    for_each_json_object_field(obj_raw, |k, v| match k {
        "id" => id_raw = Some(v),
        "projectID" => project_raw = Some(v),
        "location" => location_raw = Some(v),
        "revert" => revert_raw = Some(v),
        _ => {}
    })
    .ok_or(())?;
    let mut out = serde_json::Map::new();
    if let Some(v) = id_raw {
        if !json_node_count_within(v.as_bytes(), 16) {
            return Err(());
        }
        let val: serde_json::Value = serde_json::from_str(v).map_err(|_| ())?;
        if strict_id && val.as_str() != Some(id) {
            return Err(());
        }
        out.insert("id".into(), val);
    } else if strict_id {
        return Err(());
    }
    if let Some(v) = project_raw {
        if !json_node_count_within(v.as_bytes(), 16) {
            return Err(());
        }
        out.insert("projectID".into(), serde_json::from_str(v).map_err(|_| ())?);
    }
    if let Some(loc) = location_raw {
        let loc = loc.trim();
        if loc.starts_with('{') {
            let (mut dir_raw, mut ws_raw) = (None, None);
            for_each_json_object_field(loc, |k, v| match k {
                "directory" => dir_raw = Some(v),
                "workspaceID" => ws_raw = Some(v),
                _ => {}
            })
            .ok_or(())?;
            let mut loc_map = serde_json::Map::new();
            if let Some(v) = dir_raw {
                if !json_node_count_within(v.as_bytes(), 16) {
                    return Err(());
                }
                loc_map.insert("directory".into(), serde_json::from_str(v).map_err(|_| ())?);
            }
            if let Some(v) = ws_raw {
                let kept = if v.len() <= 2048
                    && let Some(s) = parse_string(v)
                    && s.len() <= 514
                {
                    serde_json::Value::String(s)
                } else {
                    serde_json::Value::Null
                };
                loc_map.insert("workspaceID".into(), kept);
            }
            out.insert("location".into(), serde_json::Value::Object(loc_map));
        } else if json_node_count_within(loc.as_bytes(), 16) {
            out.insert("location".into(), serde_json::from_str(loc).map_err(|_| ())?);
        }
    }
    if let Some(rev) = revert_raw {
        if !json_node_count_within(rev.as_bytes(), 65_536) {
            return Err(());
        }
        out.insert("revert".into(), serde_json::from_str(rev).map_err(|_| ())?);
    }
    Ok(serde_json::Value::Object(out))
}
