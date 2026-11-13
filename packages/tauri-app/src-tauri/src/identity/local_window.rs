pub(crate) const LOCAL_WINDOW_PREFIX: &str = "local-";

pub(crate) fn local_window_label(window_id: &str) -> Result<String, String> {
    let uuid =
        uuid::Uuid::parse_str(window_id).map_err(|_| "Invalid local window UUID".to_string())?;
    let normalized = uuid.to_string();
    if normalized != window_id {
        return Err("Local window UUID must be lowercase".to_string());
    }
    Ok(format!("{LOCAL_WINDOW_PREFIX}{normalized}"))
}

pub(crate) fn local_window_id(label: &str) -> Result<String, String> {
    let id = label
        .strip_prefix(LOCAL_WINDOW_PREFIX)
        .ok_or_else(|| "Native operation is limited to local windows".to_string())?;
    local_window_label(id)?;
    Ok(id.to_string())
}
