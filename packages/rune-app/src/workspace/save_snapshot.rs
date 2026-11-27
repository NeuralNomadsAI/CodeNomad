use super::{
    Error, MAX_BYTES, MAX_DRAFT, MAX_DRAFTS, MAX_STRINGS, Snapshot, Tab, Workspace, draft_id,
    encode, snapshot_budget::choose, snapshot_bytes, snapshot_string_units, validate,
};
use crate::composer::draft_storage::SavedParts;

pub(super) fn encode_for_save(snapshot: &Snapshot) -> Result<(Vec<u8>, bool), Error> {
    if let Ok(bytes) = encode(snapshot) {
        return Ok((bytes, false));
    }
    let mut valid = snapshot.clone();
    for tab in &mut valid.tabs {
        let Tab::Workspace(saved) = tab else { continue };
        saved.project_name = saved
            .project_name
            .as_deref()
            .and_then(super::normalize_project_name);
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
                .max_by_key(|(_, text)| text.encode_utf16().count())
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            saved.drafts.remove(&id);
        }
        saved
            .attachment_drafts
            .extend(saved.attachment_parts.keys().cloned());
        saved.attachment_drafts.retain(|id| draft_id(id));
        while saved.attachment_drafts.len() > MAX_DRAFTS {
            saved.attachment_drafts.pop_last();
        }
        saved
            .attachment_parts
            .retain(|id, parts| saved.attachment_drafts.contains(id) && parts.valid());
    }
    fit_text(&mut valid)?;
    fit_parts(&mut valid).map(|bytes| (bytes, true))
}

fn priority(active: bool, saved: &Workspace, id: &str) -> u8 {
    if saved.active_session_id.as_deref() == Some(id)
        || id == "__no_session_draft__"
        || id.starts_with("__recovered_draft__")
    {
        if active { 2 } else { 1 }
    } else {
        0
    }
}

fn fit_text(snapshot: &mut Snapshot) -> Result<(), Error> {
    super::drop_excess_project_names(snapshot)?;
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
    let mut bytes = snapshot_bytes(snapshot)?;
    if bytes.len() > MAX_BYTES {
        for index in super::project_name_drop_order(snapshot) {
            let changed = match &mut snapshot.tabs[index] {
                Tab::Workspace(saved) => saved.project_name.take().is_some(),
                Tab::Blank => false,
            };
            if changed {
                bytes = snapshot_bytes(snapshot)?;
                if bytes.len() <= MAX_BYTES {
                    return Ok(bytes);
                }
            }
        }
    }
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
    for tier in 0..=2 {
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
