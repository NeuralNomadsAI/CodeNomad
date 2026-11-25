use crate::missions::activity::ojson::{self, J};
use crate::worktrees::fence;
use serde::Deserialize;
#[cfg(test)]
use serde_json::{Value, json};
use serde_json::value::RawValue;

#[derive(Deserialize)]
struct EnvelopeRaw<'a> {
    #[serde(borrow)]
    output: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct MissionHeaderPeek {
    id: String,
    #[serde(rename = "projectID")]
    project_id: String,
    #[serde(rename = "projectCanonical")]
    project_canonical: String,
}

#[derive(Deserialize)]
struct CleanupHeaderPeek {
    #[serde(rename = "missionID")]
    mission_id: String,
}

#[derive(Deserialize)]
struct SnapshotOutputRaw<'a> {
    version: Option<u64>,
    #[serde(rename = "projectID")]
    project_id: Option<String>,
    #[serde(rename = "generatedAt", borrow)]
    generated_at: Option<&'a RawValue>,
    #[serde(borrow)]
    missions: Option<Vec<&'a RawValue>>,
    #[serde(borrow)]
    cleanups: Option<Vec<&'a RawValue>>,
    #[serde(rename = "cleanupUnavailable")]
    cleanup_unavailable: Option<bool>,
    #[serde(rename = "controlUnavailable")]
    control_unavailable: Option<bool>,
    #[serde(rename = "notificationUnavailable")]
    notification_unavailable: Option<bool>,
}

/// Extract a single Mission from a raw `snapshot` RPC envelope without materializing
/// AST nodes for other missions in the project, preserving wire key order for compaction.
pub(super) fn project_snapshot_bytes(
    bytes: &[u8],
    target_id: &str,
    project: &str,
    canonical: &str,
    compact_mission: bool,
) -> Result<Vec<u8>, ()> {
    let envelope: EnvelopeRaw<'_> = serde_json::from_slice(bytes).map_err(|_| ())?;
    let output_raw = envelope.output.ok_or(())?;
    let snap: SnapshotOutputRaw<'_> = serde_json::from_str(output_raw.get()).map_err(|_| ())?;
    if snap.version != Some(1) || snap.project_id.as_deref() != Some(project) {
        return Err(());
    }
    let normalized = fence::normalize(canonical);
    let missions_raw = snap.missions.ok_or(())?;
    let mut target_raw: Option<&RawValue> = None;
    for raw in missions_raw {
        let peek: MissionHeaderPeek = serde_json::from_str(raw.get()).map_err(|_| ())?;
        if peek.project_id != project || fence::normalize(&peek.project_canonical) != normalized {
            return Err(());
        }
        if peek.id == target_id && target_raw.is_none() {
            target_raw = Some(raw);
        }
    }
    let mut kept_cleanups = Vec::new();
    if let Some(cleanups_raw) = snap.cleanups {
        for raw in cleanups_raw {
            if let Ok(peek) = serde_json::from_str::<CleanupHeaderPeek>(raw.get())
                && peek.mission_id == target_id
            {
                kept_cleanups.push(ojson::parse(raw.get().as_bytes()).ok_or(())?);
            }
        }
    }
    let generated_at = snap
        .generated_at
        .and_then(|r| ojson::parse(r.get().as_bytes()))
        .unwrap_or(J::Null);
    let mut out_entries = vec![
        ("available".to_owned(), J::Bool(true)),
        ("version".to_owned(), J::U(1)),
        ("projectID".to_owned(), J::S(project.to_owned())),
        ("generatedAt".to_owned(), generated_at),
        ("cleanups".to_owned(), J::A(kept_cleanups)),
    ];
    if let Some(raw) = target_raw {
        let parsed = ojson::parse(raw.get().as_bytes()).ok_or(())?;
        let projected = if compact_mission { crate::missions::compact::compact_mission_j(parsed) } else { parsed };
        out_entries.push(("mission".to_owned(), projected));
    }
    if snap.cleanup_unavailable == Some(true) {
        out_entries.push(("cleanupUnavailable".to_owned(), J::Bool(true)));
    }
    if snap.control_unavailable == Some(true) {
        out_entries.push(("controlUnavailable".to_owned(), J::Bool(true)));
    }
    if snap.notification_unavailable == Some(true) {
        out_entries.push(("notificationUnavailable".to_owned(), J::Bool(true)));
    }
    Ok(J::O(out_entries).stringify().into_bytes())
}

/// Process a direct `mission` RPC envelope in insertion-ordered `ojson::J` so structured
/// body digests match JavaScript `JSON.stringify` wire key order, then compact in place.
pub(super) fn project_direct_mission_bytes(
    bytes: &[u8],
    target_id: &str,
    project: &str,
    canonical: &str,
) -> Result<Vec<u8>, ()> {
    let envelope: EnvelopeRaw<'_> = serde_json::from_slice(bytes).map_err(|_| ())?;
    let output_raw = envelope.output.ok_or(())?;
    let parsed = ojson::parse(output_raw.get().as_bytes()).ok_or(())?;
    let J::O(mut entries) = parsed else { return Err(()) };
    if entries.iter().find(|(k, _)| k == "projectID").and_then(|(_, v)| v.str()) != Some(project)
        || entries.iter().find(|(k, _)| k == "version").and_then(|(_, v)| v.count()) != Some(1)
    {
        return Err(());
    }
    let normalized = fence::normalize(canonical);
    if let Some(pos) = entries.iter().position(|(k, _)| k == "mission") {
        let map = std::mem::replace(&mut entries[pos].1, J::Null);
        if !matches!(map, J::Null) {
            if map.get("id").and_then(J::str) != Some(target_id)
                || map.get("projectID").and_then(J::str) != Some(project)
                || map
                    .get("projectCanonical")
                    .and_then(J::str)
                    .is_none_or(|p| fence::normalize(p) != normalized)
            {
                return Err(());
            }
            entries[pos].1 = crate::missions::compact::compact_mission_j(map);
        }
    }
    if let Some(slot) = entries.iter_mut().find(|(k, _)| k == "available") {
        slot.1 = J::Bool(true);
    } else {
        entries.push(("available".to_owned(), J::Bool(true)));
    }
    Ok(J::O(entries).stringify().into_bytes())
}

#[cfg(test)]
fn admission_projection_owned(mut snapshot: Value, mission: &Value) -> Value {
    let cleanups: Vec<Value> = snapshot
        .get_mut("cleanups")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .into_iter()
        .flatten()
        .filter(|c| &c["missionID"] == mission)
        .collect();
    let mut result = json!({"available":true,"version":snapshot["version"],"projectID":snapshot["projectID"],
        "generatedAt":snapshot["generatedAt"],"cleanups":cleanups});
    if let Some(map) = snapshot
        .get_mut("missions")
        .and_then(Value::as_array_mut)
        .map(std::mem::take)
        .into_iter()
        .flatten()
        .find(|m| &m["id"] == mission)
    {
        result["mission"] = map;
    }
    for flag in ["cleanupUnavailable", "controlUnavailable", "notificationUnavailable"] {
        if snapshot[flag] == true {
            result[flag] = json!(true);
        }
    }
    result
}

#[cfg(test)]
pub(super) fn admission_projection(snapshot: &Value, mission: &Value) -> Value {
    admission_projection_owned(snapshot.clone(), mission)
}
