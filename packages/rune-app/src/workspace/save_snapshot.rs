use super::{Error, MAX_DRAFT, MAX_DRAFTS, Snapshot, Tab, draft_id, encode, validate};

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
    let mut candidates = Vec::new();
    for (tab, entry) in valid.tabs.iter().enumerate() {
        let Tab::Workspace(saved) = entry else {
            continue;
        };
        for (id, text) in &saved.drafts {
            candidates.push((text.encode_utf16().count(), tab, id.clone()));
        }
    }
    candidates.sort_unstable();
    while validate(&valid).is_err() {
        let (_, tab, id) = candidates.pop().ok_or(Error::Limit)?;
        if let Tab::Workspace(saved) = &mut valid.tabs[tab] {
            saved.drafts.remove(&id);
        }
    }
    if let Ok(bytes) = encode(&valid) {
        return Ok((bytes, true));
    }
    // Keep draft text and the missing-parts marker when shedding attachment payloads.
    let mut payloads = Vec::new();
    for (tab, entry) in valid.tabs.iter().enumerate() {
        let Tab::Workspace(saved) = entry else {
            continue;
        };
        for (id, parts) in &saved.attachment_parts {
            let bytes = serde_json::to_vec(&parts.encode())
                .map_err(|_| Error::Malformed)?
                .len();
            payloads.push((bytes, tab, id.clone()));
        }
    }
    payloads.sort_unstable();
    for (_, tab, id) in payloads.iter().rev() {
        let Tab::Workspace(saved) = &mut valid.tabs[*tab] else {
            continue;
        };
        if saved
            .attachment_parts
            .get_mut(id)
            .is_some_and(|parts| parts.discard_pasted_text())
            && let Ok(bytes) = encode(&valid)
        {
            return Ok((bytes, true));
        }
    }
    while let Some((_, tab, id)) = payloads.pop() {
        if let Tab::Workspace(saved) = &mut valid.tabs[tab] {
            saved.attachment_parts.remove(&id);
        }
        if let Ok(bytes) = encode(&valid) {
            return Ok((bytes, true));
        }
    }
    encode(&valid).map(|bytes| (bytes, true))
}
