use super::{
    Error, MAX_BYTES, MAX_DRAFT, MAX_DRAFTS, MAX_STRINGS, NO_SESSION_DRAFT_ID, Snapshot, Tab,
    Workspace, draft_id, encode, is_recovered_draft_id, snapshot_budget::choose, snapshot_bytes,
    snapshot_string_units, validate,
};
use crate::composer::draft_storage::SavedParts;
use std::cmp::Reverse;

pub(super) fn encode_for_save(snapshot: &Snapshot) -> Result<(Vec<u8>, bool), Error> {
    if let Ok(bytes) = encode(snapshot) {
        return Ok((bytes, false));
    }
    let mut valid = snapshot.clone();
    for tab in &mut valid.tabs {
        let Tab::Workspace(saved) = tab else { continue };
        let mut shell = saved.clone();
        shell.drafts.clear();
        shell.attachment_drafts.clear();
        shell.attachment_parts.clear();
        if validate(&Snapshot {
            revision: snapshot.revision,
            saved_at: snapshot.saved_at,
            panel_widths: snapshot.panel_widths,
            file_wrap: snapshot.file_wrap,
            tabs: vec![Tab::Workspace(shell)],
            active: Some(0),
        })
        .is_err()
        {
            *tab = Tab::Blank;
            continue;
        }
        saved
            .drafts
            .retain(|id, text| draft_id(id) && text.encode_utf16().nth(MAX_DRAFT).is_none());
        while saved.drafts.len() > MAX_DRAFTS {
            let Some(id) = saved
                .drafts
                .iter()
                .max_by_key(|(id, text)| {
                    (
                        Reverse(cap_priority(saved, id)),
                        text.encode_utf16().count(),
                        id.as_str(),
                    )
                })
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            saved.drafts.remove(&id);
            if let Some(parts) = saved.attachment_parts.get_mut(&id) {
                parts.mark_incomplete();
            }
        }
        saved
            .attachment_drafts
            .extend(saved.attachment_parts.keys().cloned());
        saved.attachment_drafts.retain(|id| draft_id(id));
        saved
            .attachment_parts
            .retain(|id, parts| saved.attachment_drafts.contains(id) && parts.valid());
        while saved.attachment_drafts.len() > MAX_DRAFTS {
            let Some(id) = saved
                .attachment_drafts
                .iter()
                .max_by_key(|id| {
                    let part_len = saved
                        .attachment_parts
                        .get(id.as_str())
                        .and_then(|parts| part_bytes(parts).ok())
                        .unwrap_or(0);
                    (
                        Reverse(cap_priority(saved, id)),
                        !saved.drafts.contains_key(id.as_str()),
                        part_len,
                        id.as_str(),
                    )
                })
                .cloned()
            else {
                break;
            };
            saved.attachment_drafts.remove(&id);
            saved.attachment_parts.remove(&id);
            // Never leave a retained text draft stripped of its attachment marker/parts.
            saved.drafts.remove(&id);
        }
    }
    fit_text(&mut valid)?;
    fit_parts(&mut valid).map(|bytes| (bytes, true))
}

fn cap_priority(saved: &Workspace, id: &str) -> u8 {
    if saved.active_session_id.as_deref() == Some(id) {
        3
    } else if id == NO_SESSION_DRAFT_ID {
        2
    } else if is_recovered_draft_id(id) {
        1
    } else {
        0
    }
}

fn priority(active: bool, saved: &Workspace, id: &str) -> u8 {
    let rank = cap_priority(saved, id);
    if rank == 0 {
        0
    } else if active {
        rank + 3
    } else {
        rank
    }
}

fn fit_text(snapshot: &mut Snapshot) -> Result<(), Error> {
    let excess = snapshot_string_units(snapshot)?.saturating_sub(MAX_STRINGS);
    if excess == 0 {
        return Ok(());
    }
    let mut candidates = Vec::new();
    for (tab, entry) in snapshot.tabs.iter().enumerate() {
        let Tab::Workspace(saved) = entry else {
            continue;
        };
        for (id, text) in &saved.drafts {
            candidates.push((
                tab,
                id.clone(),
                (
                    priority(snapshot.active == Some(tab), saved, id),
                    id.len() + text.encode_utf16().count(),
                ),
            ));
        }
    }
    let weights = candidates
        .iter()
        .map(|(_, _, weight)| *weight)
        .collect::<Vec<_>>();
    for index in choose(&weights, excess).ok_or(Error::Limit)? {
        let (tab, id, _) = &candidates[index];
        if let Tab::Workspace(saved) = &mut snapshot.tabs[*tab] {
            saved.drafts.remove(id);
            if let Some(parts) = saved.attachment_parts.get_mut(id) {
                parts.mark_incomplete();
            }
        }
    }
    Ok(())
}

fn fit_parts(snapshot: &mut Snapshot) -> Result<Vec<u8>, Error> {
    let bytes = snapshot_bytes(snapshot)?;
    let excess = bytes.len().saturating_sub(MAX_BYTES);
    if excess == 0 {
        return Ok(bytes);
    }
    let mut payloads = Vec::new();
    for (tab, entry) in snapshot.tabs.iter().enumerate() {
        let Tab::Workspace(saved) = entry else {
            continue;
        };
        for (id, parts) in &saved.attachment_parts {
            let size = part_bytes(parts)?;
            let mut trimmed = parts.clone();
            let trim = if trimmed.discard_pasted_text() {
                size.saturating_sub(part_bytes(&trimmed)?)
            } else {
                0
            };
            let clear = size.saturating_sub(part_bytes(&SavedParts::missing())?);
            payloads.push((
                tab,
                id.clone(),
                priority(snapshot.active == Some(tab), saved, id),
                trim,
                trimmed,
                clear,
            ));
        }
    }
    let max_tier = payloads.iter().map(|p| p.2).max().unwrap_or(0);
    for tier in 0..=max_tier {
        for only_paste in [true, false] {
            let weights = payloads
                .iter()
                .map(|(_, _, priority, trim, _, clear)| {
                    (
                        *priority,
                        if *priority > tier {
                            0
                        } else if only_paste {
                            *trim
                        } else {
                            *clear
                        },
                    )
                })
                .collect::<Vec<_>>();
            let Some(selected) = choose(&weights, excess) else {
                continue;
            };
            for index in selected {
                let (tab, id, _, _, trimmed, _) = &payloads[index];
                if let Tab::Workspace(saved) = &mut snapshot.tabs[*tab] {
                    saved.attachment_parts.insert(
                        id.clone(),
                        if only_paste {
                            trimmed.clone()
                        } else {
                            SavedParts::missing()
                        },
                    );
                }
            }
            return encode(snapshot);
        }
    }
    Err(Error::Limit)
}

fn part_bytes(parts: &SavedParts) -> Result<usize, Error> {
    serde_json::to_vec(&parts.encode())
        .map(|bytes| bytes.len())
        .map_err(|_| Error::Malformed)
}
