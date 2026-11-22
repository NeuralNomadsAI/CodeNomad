use wasm_bindgen::{JsCast, JsValue};
use web_sys::{Blob, BlobPropertyBag, HtmlAnchorElement, Url};

pub fn download(name: &str, bytes: &[u8]) -> Result<(), JsValue> {
    let document = web_sys::window()
        .and_then(|w| w.document())
        .ok_or("document unavailable")?;
    let body = document.body().ok_or("document body unavailable")?;
    let link = document
        .create_element("a")?
        .dyn_into::<HtmlAnchorElement>()?;
    let parts = js_sys::Array::of1(&js_sys::Uint8Array::from(bytes));
    let options = BlobPropertyBag::new();
    options.set_type("application/octet-stream");
    let blob = Blob::new_with_u8_array_sequence_and_options(&parts, &options)?;
    let url = Url::create_object_url_with_blob(&blob)?;
    link.set_href(&url);
    link.set_download(name);
    link.set_hidden(true);
    if let Err(error) = body.append_child(&link) {
        let _ = Url::revoke_object_url(&url);
        return Err(error);
    }
    link.click();
    link.remove();
    crate::platform::spawn(async move {
        crate::platform::sleep(std::time::Duration::ZERO).await;
        let _ = Url::revoke_object_url(&url);
    });
    Ok(())
}
