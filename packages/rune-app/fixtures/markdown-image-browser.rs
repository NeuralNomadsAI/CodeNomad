// cdylib probe for markdown-image-browser.mjs; it calls the product HTTP client.
use codenomad_client::files::images::Images;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn read_image(origin: &str, url: &str, limit: usize) -> Result<Vec<u8>, JsValue> {
    let report = |error: codenomad_client::history::Error| JsValue::from_str(&error.to_string());
    Images::new().map_err(report)?.read(origin, url, limit).await.map_err(report)
}
