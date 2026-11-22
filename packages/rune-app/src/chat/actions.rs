//! Session-owned transcript disclosure actions.
use crate::State;

pub fn toggle_tool(s: &mut State, message: &str, key: &str) {
    let keys = s.expanded_tools.entry(message.into()).or_default();
    if !keys.remove(key) {
        keys.insert(key.into());
    }
    s.revision += 1;
}
pub fn reveal_tool_output(s: &mut State, message: &str, key: &str) {
    s.expanded_tools
        .entry(message.into())
        .or_default()
        .insert(key.into());
    s.revision += 1;
}
pub fn retain_visible(s: &mut State) {
    if !s.expanded_tools.is_empty() {
        let ids: std::collections::HashSet<_> =
            s.messages.iter().map(|row| row.id.as_str()).collect();
        s.expanded_tools.retain(|id, _| ids.contains(id.as_str()));
    }
}
