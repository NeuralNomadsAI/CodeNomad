use crate::{
    State,
    composer::{
        device::{self, Error, Offer},
        draft::{MAX_FILE, MAX_FILES},
    },
    strings::t,
};
use rune::Tx;
use std::sync::Arc;

pub enum Source {
    #[cfg(not(target_arch = "wasm32"))]
    Path(std::path::PathBuf),
    #[cfg(target_arch = "wasm32")]
    File(web_sys::File),
    #[cfg(target_arch = "wasm32")]
    WebFile(rune::clipboard::WebFile),
    Png(rune::clipboard::ClipboardImage),
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    Drop,
    Paste,
}

#[cfg(any(target_arch = "wasm32", test))]
fn valid_mime(mime: &str) -> Option<&str> {
    let mime = mime.trim();
    let (kind, subtype) = mime.split_once('/')?;
    let token = |part: &str| {
        !part.is_empty()
            && part.bytes().all(|b| {
                b.is_ascii_alphanumeric()
                    || matches!(
                        b,
                        b'!' | b'#' | b'$' | b'&' | b'-' | b'^' | b'_' | b'.' | b'+'
                    )
            })
    };
    (token(kind) && token(subtype)).then_some(mime)
}

#[cfg(any(target_arch = "wasm32", test))]
fn web_file_metadata(name: &str, mime: &str) -> (String, String) {
    let mime = valid_mime(mime).unwrap_or("application/octet-stream");
    let name = if !name.trim().is_empty() {
        name.to_owned()
    } else if mime == "image/png" {
        "clipboard.png".into()
    } else {
        t("messageItem.attachment.defaultName").into()
    };
    (name, mime.into())
}

#[cfg(any(target_arch = "wasm32", test))]
fn web_files_keep_text(
    origin: Option<Origin>,
    file_count: usize,
    first_mime: Option<&str>,
    has_image: bool,
    has_text: bool,
) -> bool {
    if !has_text {
        return false;
    }
    match origin {
        Some(Origin::Drop) => false,
        Some(Origin::Paste) => true,
        None => has_image || (file_count == 1 && first_mime == Some("image/png")),
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn set_composer_epoch(epoch: u64) {
    web_fence::set_epoch(epoch);
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn sync_web_input_fence(epoch: u64) {
    web_fence::sync(epoch);
}

#[cfg(target_arch = "wasm32")]
fn web_file_offer(
    index: usize,
    origin: Option<Origin>,
    file: &rune::clipboard::WebFile,
    reused_png: &mut Option<&rune::clipboard::ClipboardImage>,
) -> Offer {
    let (name, mime) = web_file_metadata(file.name(), file.mime());
    let match_png = mime == "image/png" && (origin != Some(Origin::Drop) || index == 0);
    let source = if match_png && let Some(image) = reused_png.take() {
        Source::Png(image.clone())
    } else {
        Source::WebFile(file.clone())
    };
    Offer { name, mime, source }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn drop_files(s: &mut State, paths: &[std::path::PathBuf]) {
    device::enqueue(
        s,
        paths.iter().take(MAX_FILES + 1).filter_map(|path| {
            Some(Offer {
                name: path.file_name()?.to_string_lossy().into_owned(),
                mime: super::device_file::mime(path).into(),
                source: Source::Path(path.clone()),
            })
        }),
    );
}

pub fn paste(s: &mut State, content: &rune::clipboard::ClipboardContent) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    if !content.files().is_empty() {
        drop_files(s, content.files());
        return true;
    }
    #[cfg(target_arch = "wasm32")]
    if !content.web_files().is_empty() {
        let files = content.web_files();
        let mut origin = None;
        for file in files {
            if let Some((seen_origin, epoch)) = web_fence::inspect(file) {
                if epoch != s.web_composer_input_epoch {
                    return true;
                }
                origin.get_or_insert(seen_origin);
            }
        }
        let mut reused_png = content.image();
        device::enqueue(
            s,
            files
                .iter()
                .take(MAX_FILES + 1)
                .enumerate()
                .map(|(index, file)| web_file_offer(index, origin, file, &mut reused_png)),
        );
        return !web_files_keep_text(
            origin,
            files.len(),
            files.first().map(|file| file.mime()),
            content.image().is_some(),
            !content.text().is_empty(),
        );
    }
    let Some(image) = content.image() else {
        return false;
    };
    if !device::available(s) {
        return content.text().is_empty();
    }
    let name = "clipboard.png";
    if image.png().len() > MAX_FILE {
        s.composer.device.notice = Some(device::notice(name, Error::TooLarge));
    } else {
        device::enqueue(
            s,
            [Offer {
                name: name.into(),
                mime: "image/png".into(),
                source: Source::Png(image.clone()),
            }],
        );
    }
    content.text().is_empty()
}

pub fn choose(s: &mut State, tx: &mut Tx) {
    if !device::available(s) || s.composer.device.busy() {
        return;
    }
    s.composer.device.choosing = true;
    s.composer.device.notice = None;
    #[cfg(not(target_arch = "wasm32"))]
    {
        let scope = s.input_scope.clone();
        let generation = s.composer.device.generation;
        tx.open_file(
            rune::file_dialog::FileDialogOptions {
                title: t("promptInput.attachFiles.ariaLabel").into(),
                ..Default::default()
            },
            move |s: &mut State, result, _| {
                if !s.current_scope(&scope) || s.composer.device.generation != generation {
                    return;
                }
                s.composer.device.choosing = false;
                match result {
                    Ok(Some(path)) => drop_files(s, &[path]),
                    Ok(None) => {}
                    Err(_) => {
                        s.composer.device.notice =
                            Some(t("promptInput.attachFiles.errorTitle").into())
                    }
                }
            },
        );
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = tx;
        match Choice::open(s.wake.clone()) {
            Some(choice) => s.composer.device.browser = Some(choice),
            None => {
                s.composer.device.choosing = false;
                s.composer.device.notice = Some(t("promptInput.attachFiles.errorTitle").into());
            }
        }
    }
}

pub async fn read(source: &Source, limit: usize) -> Result<Arc<[u8]>, Error> {
    let limit = limit.min(MAX_FILE);
    match source {
        #[cfg(not(target_arch = "wasm32"))]
        Source::Path(path) => super::device_file::read(path.clone(), limit).await,
        Source::Png(image) if image.png().len() <= limit => Ok(image.png().into()),
        Source::Png(_) => Err(if limit == MAX_FILE {
            Error::TooLarge
        } else {
            Error::Limit
        }),
        #[cfg(target_arch = "wasm32")]
        Source::WebFile(file) => {
            let over = if limit == MAX_FILE {
                Error::TooLarge
            } else {
                Error::Limit
            };
            let js = file.js_file().ok_or(Error::Unreadable)?;
            // rune-style-policy reserves .size() for layout; read File.size from the JS handle.
            if js_file_size(&js)? > limit as f64 {
                return Err(over);
            }
            file.read(limit)
                .await
                .map(Arc::from)
                .ok_or(Error::Unreadable)
        }
        #[cfg(target_arch = "wasm32")]
        Source::File(file) => {
            let over = if limit == MAX_FILE {
                Error::TooLarge
            } else {
                Error::Limit
            };
            if js_file_size(file)? > limit as f64 {
                return Err(over);
            }
            let buffer = wasm_bindgen_futures::JsFuture::from(file.array_buffer())
                .await
                .map_err(|_| Error::Unreadable)?;
            let bytes = js_sys::Uint8Array::new(&buffer);
            if bytes.length() as usize > limit {
                return Err(over);
            }
            Ok(bytes.to_vec().into())
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn js_file_size(file: &wasm_bindgen::JsValue) -> Result<f64, Error> {
    js_sys::Reflect::get(file, &wasm_bindgen::JsValue::from_str("size"))
        .ok()
        .and_then(|value| value.as_f64())
        .ok_or(Error::Unreadable)
}

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, closure::Closure};

#[cfg(target_arch = "wasm32")]
pub struct Choice {
    input: web_sys::HtmlInputElement,
    change: Closure<dyn FnMut(web_sys::Event)>,
    cancel: Closure<dyn FnMut(web_sys::Event)>,
    pub result: codenomad_client::Receiver<Vec<Offer>>,
}

#[cfg(target_arch = "wasm32")]
impl Choice {
    fn open(wake: rune::Waker) -> Option<Self> {
        let document = web_sys::window()?.document()?;
        let input = document
            .create_element("input")
            .ok()?
            .dyn_into::<web_sys::HtmlInputElement>()
            .ok()?;
        input.set_type("file");
        input.set_multiple(true);
        input.set_hidden(true);
        let (out, result) = codenomad_client::bounded(1);
        let cancel = {
            let out = out.clone();
            let wake = wake.clone();
            Closure::new(move |_: web_sys::Event| {
                if out.try_send(Vec::new()).is_ok() {
                    wake();
                }
            })
        };
        let change = {
            let input = input.clone();
            Closure::new(move |_: web_sys::Event| {
                let offers = input
                    .files()
                    .into_iter()
                    .flat_map(|files| {
                        (0..files.length().min((MAX_FILES + 1) as u32))
                            .filter_map(move |index| files.get(index))
                    })
                    .map(|source| {
                        let (name, mime) = web_file_metadata(&source.name(), &source.type_());
                        Offer {
                            name,
                            mime,
                            source: Source::File(source),
                        }
                    })
                    .collect();
                if out.try_send(offers).is_ok() {
                    wake();
                }
            })
        };
        let choice = Self {
            input,
            change,
            cancel,
            result,
        };
        choice
            .input
            .add_event_listener_with_callback("change", choice.change.as_ref().unchecked_ref())
            .ok()?;
        choice
            .input
            .add_event_listener_with_callback("cancel", choice.cancel.as_ref().unchecked_ref())
            .ok()?;
        document.body()?.append_child(&choice.input).ok()?;
        choice.input.show_picker().ok()?;
        Some(choice)
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for Choice {
    fn drop(&mut self) {
        let _ = self
            .input
            .remove_event_listener_with_callback("change", self.change.as_ref().unchecked_ref());
        let _ = self
            .input
            .remove_event_listener_with_callback("cancel", self.cancel.as_ref().unchecked_ref());
        self.input.remove();
    }
}

#[cfg(target_arch = "wasm32")]
mod web_fence {
    use super::Origin;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};

    static EPOCH: AtomicU64 = AtomicU64::new(0);
    static INSTALLED: AtomicBool = AtomicBool::new(false);

    fn map() -> Option<js_sys::WeakMap> {
        let global = js_sys::global();
        let key = js_sys::Symbol::for_("codenomad.composerWebFileOrigins");
        if let Ok(existing) = js_sys::Reflect::get(&global, &key)
            && let Ok(map) = existing.dyn_into::<js_sys::WeakMap>()
        {
            return Some(map);
        }
        let map = js_sys::WeakMap::new();
        js_sys::Reflect::set(&global, &key, &map).ok()?;
        Some(map)
    }

    fn stamp_files(event: &web_sys::Event, prop: &str, origin: Origin) {
        let Ok(transfer) = js_sys::Reflect::get(event, &JsValue::from_str(prop)) else {
            return;
        };
        if transfer.is_null() || transfer.is_undefined() {
            return;
        }
        let Ok(files) = js_sys::Reflect::get(&transfer, &JsValue::from_str("files")) else {
            return;
        };
        let Ok(files) = files.dyn_into::<web_sys::FileList>() else {
            return;
        };
        let Some(map) = map() else {
            return;
        };
        let epoch = EPOCH.load(Ordering::SeqCst);
        let entry = js_sys::Array::of2(
            &JsValue::from_f64(match origin {
                Origin::Drop => 1.0,
                Origin::Paste => 2.0,
            }),
            &JsValue::from_f64(epoch as f64),
        );
        for index in 0..files.length().min(rune::clipboard::MAX_WEB_FILES as u32) {
            if let Some(file) = files.get(index) {
                let _ = map.set(file.as_ref(), &entry);
            }
        }
    }

    pub(crate) fn set_epoch(epoch: u64) {
        EPOCH.store(epoch, Ordering::SeqCst);
    }

    pub(crate) fn sync(epoch: u64) {
        set_epoch(epoch);
        if INSTALLED.load(Ordering::SeqCst) {
            return;
        }
        let Some(window) = web_sys::window() else {
            return;
        };
        let drop = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            stamp_files(&event, "dataTransfer", Origin::Drop);
        });
        let paste = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            stamp_files(&event, "clipboardData", Origin::Paste);
        });
        let target: &web_sys::EventTarget = window.as_ref();
        if target
            .add_event_listener_with_callback_and_bool("drop", drop.as_ref().unchecked_ref(), true)
            .is_err()
        {
            return;
        }
        if target
            .add_event_listener_with_callback_and_bool(
                "paste",
                paste.as_ref().unchecked_ref(),
                true,
            )
            .is_err()
        {
            let _ = target.remove_event_listener_with_callback_and_bool(
                "drop",
                drop.as_ref().unchecked_ref(),
                true,
            );
            return;
        }
        drop.forget();
        paste.forget();
        INSTALLED.store(true, Ordering::SeqCst);
    }

    pub(crate) fn inspect(file: &rune::clipboard::WebFile) -> Option<(Origin, u64)> {
        let js = file.js_file()?;
        let obj = js.dyn_ref::<js_sys::Object>()?;
        let value = map()?.get(obj);
        let pair = value.dyn_into::<js_sys::Array>().ok()?;
        let origin = match pair.get(0).as_f64()? as u8 {
            1 => Origin::Drop,
            2 => Origin::Paste,
            _ => return None,
        };
        let epoch = pair.get(1).as_f64()? as u64;
        Some((origin, epoch))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_file_metadata_preserves_names_and_validates_mime() {
        let fallback_name = t("messageItem.attachment.defaultName").to_owned();
        assert_eq!(
            web_file_metadata("capture.png", "image/png"),
            ("capture.png".into(), "image/png".into())
        );
        assert_eq!(
            web_file_metadata("  spaced name.txt ", "text/plain"),
            ("  spaced name.txt ".into(), "text/plain".into())
        );
        assert_eq!(
            web_file_metadata("   ", "image/png"),
            ("clipboard.png".into(), "image/png".into())
        );
        assert_eq!(
            web_file_metadata("\t ", ""),
            (fallback_name.clone(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("notes.txt", "text/plain;base64,evil"),
            ("notes.txt".into(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("notes.txt", "image/png,evil"),
            ("notes.txt".into(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("diagram.svg", "image/svg+xml"),
            ("diagram.svg".into(), "image/svg+xml".into())
        );
        assert_eq!(
            web_file_metadata("", "   "),
            (fallback_name, "application/octet-stream".into())
        );
    }

    #[test]
    fn web_files_keep_text_on_paste_and_suppress_synthesized_drop_text() {
        assert!(web_files_keep_text(
            Some(Origin::Paste),
            1,
            Some("image/png"),
            true,
            true
        ));
        assert!(web_files_keep_text(
            Some(Origin::Paste),
            1,
            Some("image/png"),
            false,
            true
        ));
        assert!(!web_files_keep_text(
            Some(Origin::Paste),
            1,
            Some("image/png"),
            true,
            false
        ));
        assert!(!web_files_keep_text(
            Some(Origin::Drop),
            1,
            Some("text/plain"),
            false,
            true
        ));
        assert!(!web_files_keep_text(
            Some(Origin::Drop),
            1,
            Some("image/png"),
            true,
            true
        ));
        assert!(web_files_keep_text(None, 1, Some("image/png"), false, true));
        assert!(!web_files_keep_text(
            None,
            1,
            Some("text/plain"),
            false,
            true
        ));
    }
}
