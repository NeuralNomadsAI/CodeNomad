//! Browser fixture: fetch the same bounded outline as the native client.
fn main() {}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn fetch_outline() -> Result<String, wasm_bindgen::JsValue> {
    use codenomad_client::{backend::Backend, timeline::OutlineRevision};
    use wasm_bindgen::JsValue;

    let mut backend =
        Backend::unauthenticated("/").map_err(|error| JsValue::from_str(&error.to_string()))?;
    backend.workspace = "workspace".into();
    backend.session = "session".into();
    let outline = backend
        .read_outline(&OutlineRevision::default())
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(outline
        .entries
        .into_iter()
        .map(|row| row.id)
        .collect::<Vec<_>>()
        .join(","))
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn resolve_anchors() -> Result<String, wasm_bindgen::JsValue> {
    use codenomad_client::{backend::Backend, timeline::AnchorWindow};
    use wasm_bindgen::JsValue;

    let check = |error: codenomad_client::history::Error| JsValue::from_str(&error.to_string());
    let mut backend = Backend::unauthenticated("/").map_err(check)?;
    backend.workspace = "workspace".into();
    backend.session = "session".into();
    let AnchorWindow::Loaded(page) = backend.resolve_anchor("a", &[]).await.map_err(check)? else {
        return Err(JsValue::from_str("out-of-window anchor was not loaded"));
    };
    if !matches!(
        backend
            .resolve_anchor("a", &page.rows)
            .await
            .map_err(check)?,
        AnchorWindow::Resident
    ) {
        return Err(JsValue::from_str("resident anchor was reloaded"));
    }
    if backend.resolve_anchor("missing", &[]).await.is_ok() {
        return Err(JsValue::from_str(
            "an unrelated window cannot settle a jump",
        ));
    }
    Ok(page.rows[0].id.clone())
}
