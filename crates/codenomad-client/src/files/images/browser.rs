use super::{Result, Url, reject_svgz};
use js_sys::{Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AbortController, ReadableStreamDefaultReader, ReferrerPolicy, Request, RequestCredentials,
    RequestInit, Response, Window,
};

struct Abort {
    controller: AbortController,
    window: Window,
    timer: i32,
    _on_timeout: Closure<dyn FnMut()>,
}
impl Drop for Abort {
    fn drop(&mut self) {
        self.window.clear_timeout_with_handle(self.timer);
        self.controller.abort();
    }
}

fn browser_error(_: JsValue) -> Box<dyn std::error::Error + Send + Sync> {
    "unavailable Markdown image".into()
}

pub(super) async fn read(url: Url, maximum: usize) -> Result<Vec<u8>> {
    // Reqwest's browser builder does not expose a per-request ReferrerPolicy.
    let window = web_sys::window().ok_or("missing browser window")?;
    let controller = AbortController::new().map_err(browser_error)?;
    let deadline = controller.clone();
    let on_timeout = Closure::wrap(Box::new(move || deadline.abort()) as Box<dyn FnMut()>);
    let timer = window
        .set_timeout_with_callback_and_timeout_and_arguments_0(
            on_timeout.as_ref().unchecked_ref(),
            15_000,
        )
        .map_err(browser_error)?;
    let abort = Abort {
        controller,
        window,
        timer,
        _on_timeout: on_timeout,
    };
    let init = RequestInit::new();
    init.set_credentials(RequestCredentials::Omit);
    init.set_referrer_policy(ReferrerPolicy::NoReferrer);
    Reflect::set(&init, &"cache".into(), &"no-store".into()).map_err(browser_error)?;
    init.set_signal(Some(&abort.controller.signal()));
    let request = Request::new_with_str_and_init(url.as_str(), &init).map_err(browser_error)?;
    let response: Response = JsFuture::from(abort.window.fetch_with_request(&request))
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
