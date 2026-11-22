use super::{Result, Url, reject_svgz};
use js_sys::{Array, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AbortController, AbortSignal, ReadableStreamDefaultReader, ReferrerPolicy, Request,
    RequestCredentials, RequestInit, Response,
};

struct Abort(AbortController);
impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn browser_error(_: JsValue) -> Box<dyn std::error::Error + Send + Sync> {
    "unavailable Markdown image".into()
}

pub(super) async fn read(url: Url, maximum: usize) -> Result<Vec<u8>> {
    // Reqwest's browser builder does not expose a per-request ReferrerPolicy.
    let abort = Abort(AbortController::new().map_err(browser_error)?);
    let signals = Array::of2(&abort.0.signal(), &AbortSignal::timeout_with_u32(15_000));
    let init = RequestInit::new();
    init.set_credentials(RequestCredentials::Omit);
    init.set_referrer_policy(ReferrerPolicy::NoReferrer);
    init.set_signal(Some(&AbortSignal::any(&signals)));
    let request = Request::new_with_str_and_init(url.as_str(), &init).map_err(browser_error)?;
    let window = web_sys::window().ok_or("missing browser window")?;
    let response: Response = JsFuture::from(window.fetch_with_request(&request))
        .await
        .and_then(JsCast::dyn_into)
        .map_err(browser_error)?;
    if !response.ok()
        || response
            .headers()
            .get("content-length")
            .map_err(browser_error)?
            .and_then(|length| length.parse::<usize>().ok())
            .is_some_and(|length| length > maximum)
    {
        return Err("unavailable Markdown image".into());
    }
    let stream = response.body().ok_or("missing Markdown image body")?;
    let reader: ReadableStreamDefaultReader = stream
        .get_reader()
        .dyn_into()
        .map_err(|_| "unavailable Markdown image body")?;
    let mut bytes = Vec::new();
    loop {
        let chunk = JsFuture::from(reader.read()).await.map_err(browser_error)?;
        if Reflect::get(&chunk, &"done".into())
            .map_err(browser_error)?
            .as_bool()
            == Some(true)
        {
            return Ok(bytes);
        }
        let chunk: Uint8Array = Reflect::get(&chunk, &"value".into())
            .and_then(JsCast::dyn_into)
            .map_err(browser_error)?;
        if chunk.length() as usize > maximum.saturating_sub(bytes.len()) {
            return Err("oversized Markdown image".into());
        }
        bytes.extend_from_slice(&chunk.to_vec());
        reject_svgz(&bytes)?;
    }
}
