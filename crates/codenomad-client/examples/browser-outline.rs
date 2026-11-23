//! Browser fixture: fetch the same bounded outline as the native client.
fn main() {}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub async fn fetch_outline() -> Result<String, wasm_bindgen::JsValue> {
    use codenomad_client::backend::Backend;
    use wasm_bindgen::JsValue;

    let mut backend =
        Backend::unauthenticated("/").map_err(|error| JsValue::from_str(&error.to_string()))?;
    backend.workspace = "workspace".into();
    backend.session = "session".into();
    let outline = backend
        .outline()
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    Ok(outline
        .entries
        .into_iter()
        .map(|row| row.id)
        .collect::<Vec<_>>()
        .join(","))
}
