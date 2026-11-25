use crate::{
    backend::Backend,
    history::{Page, Result, Row, valid_id},
};
use serde_json::json;

/// The transcript owns publication and positioning; locating a target never writes its state.
#[derive(Debug)]
pub enum AnchorWindow {
    Resident,
    Loaded(Page),
}

impl Backend {
    /// Resolve a navigation target with at most one bounded read and no fallback scan.
    pub async fn resolve_anchor(&self, message: &str, resident: &[Row]) -> Result<AnchorWindow> {
        if !valid_id(message) || !valid_id(&self.workspace) || !valid_id(&self.session) {
            return Err("invalid history anchor scope".into());
        }
        if resident.iter().any(|row| row.id == message) {
            return Ok(AnchorWindow::Resident);
        }
        let page = self
            .page(json!({"kind":"around","messageID":message}))
            .await?;
        if !page.rows.iter().any(|row| row.id == message) {
            return Err("requested history anchor is missing from its window".into());
        }
        Ok(AnchorWindow::Loaded(page))
    }
}
