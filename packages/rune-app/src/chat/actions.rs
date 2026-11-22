//! Session-owned transcript disclosure actions.
use crate::State;

pub fn toggle_tool(s: &mut State, key: &str) {
    if !s.expanded_tools.remove(key) {
        s.expanded_tools.insert(key.into());
    }
    s.revision += 1;
}
pub fn reveal_tool_output(s: &mut State, key: &str) {
    s.expanded_tools.insert(key.into());
    s.revision += 1;
}
