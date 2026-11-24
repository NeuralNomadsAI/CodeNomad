use wasm_bindgen::JsCast;

pub(super) fn copy_path(
    path: &str,
    out: codenomad_client::Sender<(crate::shell::notifications::Category, bool, String)>,
    wake: codenomad_client::Wake,
) {
    let Some(window) = web_sys::window() else {
        return;
    };
    let navigator = window.navigator();
    let pending = js_sys::Reflect::get(navigator.as_ref(), &"clipboard".into())
        .ok()
        .and_then(|value| value.dyn_into::<web_sys::Clipboard>().ok())
        .map(|clipboard| clipboard.write_text(path));
    let (path, locale) = (path.to_owned(), crate::strings::locale().to_owned());
    let fallback = pending.is_none().then(|| fallback(&window, &path));
    crate::platform::spawn(async move {
        let copied = match pending {
            Some(pending) => {
                wasm_bindgen_futures::JsFuture::from(pending).await.is_ok()
                    || self::fallback(&window, &path)
            }
            None => fallback.unwrap_or(false),
        };
        if out.try_send(super::copy_feedback(&locale, copied)).is_ok() {
            wake();
        }
    });
}

pub(super) fn fallback(window: &web_sys::Window, path: &str) -> bool {
    let run = || -> Option<bool> {
        let document = window.document()?;
        let prior = document
            .active_element()
            .and_then(|node| node.dyn_into::<web_sys::HtmlElement>().ok());
        let field = document
            .create_element("textarea")
            .ok()?
            .dyn_into::<web_sys::HtmlTextAreaElement>()
            .ok()?;
        field.set_value(path);
        field.set_read_only(true);
        field
            .style()
            .set_css_text("position:fixed;left:-9999px;top:-9999px;opacity:0");
        document.body()?.append_child(&field).ok()?;
        let _ = field.focus();
        field.select();
        let copied = js_sys::Reflect::get(document.as_ref(), &"execCommand".into())
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
            .and_then(|exec| exec.call1(document.as_ref(), &"copy".into()).ok())
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        field.remove();
        if let Some(prior) = prior {
            let _ = prior.focus();
        }
        Some(copied)
    };
    run().unwrap_or(false)
}
