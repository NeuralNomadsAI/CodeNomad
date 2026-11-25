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
    WebFile {
        file: rune::clipboard::WebFile,
        validate_png: bool,
    },
    Png(rune::clipboard::ClipboardImage),
    #[cfg(any(target_arch = "wasm32", test))]
    Rejected(Error),
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Origin {
    Foreign,
    Paste,
}

#[cfg(any(target_arch = "wasm32", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    origin: Origin,
    epoch: u64,
    draft_rev: u64,
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
fn web_file_metadata(name: &str, mime: &str, default_name: &str) -> (String, String) {
    let mime = valid_mime(mime).unwrap_or("application/octet-stream");
    let name = if !name.trim().is_empty() {
        name.to_owned()
    } else if mime == "image/png" {
        "clipboard.png".into()
    } else {
        default_name.to_owned()
    };
    (name, mime.into())
}

#[cfg(any(target_arch = "wasm32", test))]
fn draft_signature(edit: &rune::edit::TextEdit) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &byte in edit.text.as_bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    for value in [edit.anchor as u64, edit.focus as u64] {
        for byte in value.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

#[cfg(any(target_arch = "wasm32", test))]
fn paste_stamp_allowed(stamp: Option<Stamp>, epoch: u64, draft_rev: u64) -> bool {
    match stamp {
        None => true,
        Some(Stamp {
            origin: Origin::Paste,
            epoch: seen_epoch,
            draft_rev: seen_rev,
        }) => seen_epoch == epoch && seen_rev == draft_rev,
        Some(Stamp {
            origin: Origin::Foreign,
            ..
        }) => false,
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn classify_pasted_png(decoded_len: Option<usize>, size: Option<f64>) -> Result<(), Error> {
    if size.is_some_and(|bytes| bytes > MAX_FILE as f64)
        || decoded_len.is_some_and(|len| len > MAX_FILE)
    {
        Err(Error::TooLarge)
    } else if decoded_len.is_some() {
        Ok(())
    } else {
        Err(Error::Unreadable)
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn set_composer_epoch(epoch: u64) {
    web_fence::set_epoch(epoch);
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn bump_draft_revision(edit: &rune::edit::TextEdit) {
    web_fence::bump_draft_revision(edit);
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn sync_web_input_fence(s: &State) {
    web_fence::sync(s);
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn take_pending_drops(s: &State) -> Vec<Offer> {
    let default_name = crate::strings::with_locale(crate::settings::app_locale(s), || {
        t("messageItem.attachment.defaultName")
    });
    web_fence::take_drops(s.web_composer_input_epoch, default_name)
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn discard_pending_drops() {
    web_fence::discard_drops();
}

#[cfg(target_arch = "wasm32")]
fn web_file_offer(
    file: &rune::clipboard::WebFile,
    default_name: &str,
    handled_png: &mut bool,
    reused_png: Option<&rune::clipboard::ClipboardImage>,
) -> Offer {
    let (name, mime) = web_file_metadata(file.name(), file.mime(), default_name);
    let source = if mime == "image/png" && !*handled_png {
        *handled_png = true;
        let size = file.js_file().and_then(|js| js_file_size(&js).ok());
        let decoded_len = reused_png.map(|image| image.png().len());
        match classify_pasted_png(decoded_len, size) {
            Ok(()) => Source::Png(reused_png.expect("classified png").clone()),
            Err(error) => Source::Rejected(error),
        }
    } else {
        Source::WebFile {
            file: file.clone(),
            validate_png: mime == "image/png",
        }
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
        let current_rev = web_fence::current_draft_revision(&s.draft);
        for file in files {
            if !paste_stamp_allowed(
                web_fence::inspect(file),
                s.web_composer_input_epoch,
                current_rev,
            ) {
                return true;
            }
        }
        if device::available(s) {
            let default_name = crate::strings::with_locale(crate::settings::app_locale(s), || {
                t("messageItem.attachment.defaultName")
            });
            let mut handled_png = false;
            let reused_png = content.image();
            device::enqueue(
                s,
                files
                    .iter()
                    .take(MAX_FILES + 1)
                    .map(|file| web_file_offer(file, default_name, &mut handled_png, reused_png)),
            );
        }
        return content.text().is_empty();
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
        let default_name = crate::strings::with_locale(crate::settings::app_locale(s), || {
            t("messageItem.attachment.defaultName")
        });
        match Choice::open(s.wake.clone(), default_name) {
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
        #[cfg(any(target_arch = "wasm32", test))]
        Source::Rejected(error) => Err(*error),
        #[cfg(target_arch = "wasm32")]
        Source::WebFile { file, validate_png } => {
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
            let bytes = file.read(limit).await.ok_or(Error::Unreadable)?;
            if *validate_png {
                let image =
                    rune::clipboard::ClipboardImage::from_png(bytes).ok_or(Error::Unreadable)?;
                return Ok(image.png().into());
            }
            Ok(Arc::from(bytes))
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
    fn open(wake: rune::Waker, default_name: &'static str) -> Option<Self> {
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
                        let (name, mime) =
                            web_file_metadata(&source.name(), &source.type_(), default_name);
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
    use super::{MAX_FILES, Offer, Origin, Source, Stamp, draft_signature, web_file_metadata};
    use crate::{State, composer::device};
    use std::sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };
    use wasm_bindgen::{JsCast, JsValue, closure::Closure};

    const MAX_PENDING_DROPS: u32 = 8;

    static EPOCH: AtomicU64 = AtomicU64::new(0);
    static LAST_DRAFT_SIG: AtomicU64 = AtomicU64::new(0);
    static DRAFT_REV: AtomicU64 = AtomicU64::new(0);
    static COMPOSER_FOCUSED: AtomicBool = AtomicBool::new(false);
    static COMPOSER_ATTACH_READY: AtomicBool = AtomicBool::new(false);
    static WAKE: OnceLock<codenomad_client::Wake> = OnceLock::new();
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

    fn pending_drops() -> Option<js_sys::Array> {
        let global = js_sys::global();
        let key = js_sys::Symbol::for_("codenomad.composerWebDrops");
        if let Ok(existing) = js_sys::Reflect::get(&global, &key)
            && let Ok(queue) = existing.dyn_into::<js_sys::Array>()
        {
            return Some(queue);
        }
        let queue = js_sys::Array::new();
        js_sys::Reflect::set(&global, &key, &queue).ok()?;
        Some(queue)
    }

    fn event_files(event: &web_sys::Event, prop: &str) -> Option<web_sys::FileList> {
        let transfer = js_sys::Reflect::get(event, &JsValue::from_str(prop)).ok()?;
        if transfer.is_null() || transfer.is_undefined() {
            return None;
        }
        let files = js_sys::Reflect::get(&transfer, &JsValue::from_str("files")).ok()?;
        files.dyn_into::<web_sys::FileList>().ok()
    }

    fn pack_u64(array: &js_sys::Array, value: u64) {
        array.push(&JsValue::from_f64((value as u32) as f64));
        array.push(&JsValue::from_f64(((value >> 32) as u32) as f64));
    }

    fn unpack_u64(array: &js_sys::Array, offset: u32) -> Option<u64> {
        let lo = array.get(offset).as_f64()? as u32;
        let hi = array.get(offset + 1).as_f64()? as u32;
        Some(u64::from(lo) | (u64::from(hi) << 32))
    }

    fn stamp_file_list(files: &web_sys::FileList, stamp: Stamp) {
        let Some(map) = map() else {
            return;
        };
        let entry = js_sys::Array::new();
        entry.push(&JsValue::from_f64(match stamp.origin {
            Origin::Foreign => 1.0,
            Origin::Paste => 2.0,
        }));
        pack_u64(&entry, stamp.epoch);
        pack_u64(&entry, stamp.draft_rev);
        for index in 0..files.length().min(rune::clipboard::MAX_WEB_FILES as u32) {
            if let Some(file) = files.get(index) {
                let _ = map.set(file.as_ref(), &entry);
            }
        }
    }

    fn handle_drop(event: &web_sys::Event) {
        let Some(files) = event_files(event, "dataTransfer") else {
            return;
        };
        if files.length() == 0 {
            return;
        }
        let is_canvas = event
            .target()
            .and_then(|target| target.dyn_into::<web_sys::Element>().ok())
            .is_some_and(|element| element.tag_name().eq_ignore_ascii_case("CANVAS"));
        if is_canvas && COMPOSER_ATTACH_READY.load(Ordering::SeqCst) {
            event.prevent_default();
            event.stop_immediate_propagation();
            let Some(queue) = pending_drops() else {
                return;
            };
            if queue.length() >= MAX_PENDING_DROPS {
                return;
            }
            let batch = js_sys::Array::new();
            pack_u64(&batch, EPOCH.load(Ordering::SeqCst));
            for index in 0..files.length().min((MAX_FILES + 1) as u32) {
                if let Some(file) = files.get(index) {
                    batch.push(&file);
                }
            }
            queue.push(&batch);
            if let Some(wake) = WAKE.get() {
                wake();
            }
            return;
        }
        stamp_file_list(
            &files,
            Stamp {
                origin: Origin::Foreign,
                epoch: 0,
                draft_rev: 0,
            },
        );
    }

    fn handle_paste(event: &web_sys::Event) {
        let Some(files) = event_files(event, "clipboardData") else {
            return;
        };
        if files.length() == 0 {
            return;
        }
        let stamp = if COMPOSER_FOCUSED.load(Ordering::SeqCst) {
            Stamp {
                origin: Origin::Paste,
                epoch: EPOCH.load(Ordering::SeqCst),
                draft_rev: DRAFT_REV.load(Ordering::SeqCst),
            }
        } else {
            Stamp {
                origin: Origin::Foreign,
                epoch: 0,
                draft_rev: 0,
            }
        };
        stamp_file_list(&files, stamp);
    }

    pub(crate) fn set_epoch(epoch: u64) {
        EPOCH.store(epoch, Ordering::SeqCst);
    }

    pub(crate) fn bump_draft_revision(edit: &rune::edit::TextEdit) {
        LAST_DRAFT_SIG.store(draft_signature(edit), Ordering::SeqCst);
        DRAFT_REV.fetch_add(1, Ordering::SeqCst);
    }

    pub(crate) fn current_draft_revision(edit: &rune::edit::TextEdit) -> u64 {
        let sig = draft_signature(edit);
        if LAST_DRAFT_SIG.swap(sig, Ordering::SeqCst) != sig {
            DRAFT_REV.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            DRAFT_REV.load(Ordering::SeqCst)
        }
    }

    pub(crate) fn sync(s: &State) {
        EPOCH.store(s.web_composer_input_epoch, Ordering::SeqCst);
        let _ = current_draft_revision(&s.draft);
        let focused = s.draft.focused
            && !s.screen.is_launcher()
            && !s.composer.editing_locked()
            && !crate::platform::pairing::required(s);
        COMPOSER_FOCUSED.store(focused, Ordering::SeqCst);
        COMPOSER_ATTACH_READY.store(focused && device::available(s), Ordering::SeqCst);
        let _ = WAKE.set(s.wake.clone());
        if INSTALLED.load(Ordering::SeqCst) {
            return;
        }
        let Some(window) = web_sys::window() else {
            return;
        };
        let drop = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            handle_drop(&event);
        });
        let paste = Closure::<dyn FnMut(web_sys::Event)>::new(move |event: web_sys::Event| {
            handle_paste(&event);
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

    pub(crate) fn take_drops(expected_epoch: u64, default_name: &str) -> Vec<Offer> {
        let Some(queue) = pending_drops() else {
            return Vec::new();
        };
        let count = queue.length();
        if count == 0 {
            return Vec::new();
        }
        let mut offers = Vec::new();
        for index in 0..count {
            let Ok(batch) = queue.get(index).dyn_into::<js_sys::Array>() else {
                continue;
            };
            let Some(epoch) = unpack_u64(&batch, 0) else {
                continue;
            };
            if epoch != expected_epoch {
                continue;
            }
            for item in 2..batch.length() {
                if offers.len() >= MAX_FILES + 1 {
                    break;
                }
                if let Ok(file) = batch.get(item).dyn_into::<web_sys::File>() {
                    let (name, mime) = web_file_metadata(&file.name(), &file.type_(), default_name);
                    offers.push(Offer {
                        name,
                        mime,
                        source: Source::File(file),
                    });
                }
            }
        }
        queue.set_length(0);
        offers
    }

    pub(crate) fn discard_drops() {
        if let Some(queue) = pending_drops() {
            queue.set_length(0);
        }
    }

    pub(crate) fn inspect(file: &rune::clipboard::WebFile) -> Option<Stamp> {
        let js = file.js_file()?;
        let obj = js.dyn_ref::<js_sys::Object>()?;
        let value = map()?.get(obj);
        let entry = value.dyn_into::<js_sys::Array>().ok()?;
        let origin = match entry.get(0).as_f64()? as u8 {
            1 => Origin::Foreign,
            2 => Origin::Paste,
            _ => return None,
        };
        let epoch = unpack_u64(&entry, 1)?;
        let draft_rev = unpack_u64(&entry, 3)?;
        Some(Stamp {
            origin,
            epoch,
            draft_rev,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_file_metadata_preserves_names_validates_mime_and_uses_supplied_locale_fallback() {
        let en = crate::strings::with_locale("en", || t("messageItem.attachment.defaultName"));
        let fr = crate::strings::with_locale("fr", || t("messageItem.attachment.defaultName"));
        assert_ne!(en, fr);
        assert_eq!(
            web_file_metadata("capture.png", "image/png", fr),
            ("capture.png".into(), "image/png".into())
        );
        assert_eq!(
            web_file_metadata("  spaced name.txt ", "text/plain", fr),
            ("  spaced name.txt ".into(), "text/plain".into())
        );
        assert_eq!(
            web_file_metadata("   ", "image/png", fr),
            ("clipboard.png".into(), "image/png".into())
        );
        assert_eq!(
            web_file_metadata("\t ", "", fr),
            (fr.into(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("", "   ", en),
            (en.into(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("notes.txt", "text/plain;base64,evil", fr),
            ("notes.txt".into(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("notes.txt", "image/png,evil", fr),
            ("notes.txt".into(), "application/octet-stream".into())
        );
        assert_eq!(
            web_file_metadata("diagram.svg", "image/svg+xml", fr),
            ("diagram.svg".into(), "image/svg+xml".into())
        );
    }

    #[test]
    fn paste_stamp_fences_foreign_epoch_and_monotonic_revision_changes() {
        let mut draft = rune::edit::TextEdit::new("hello world");
        draft.set_selection(0, 5);
        let sig_a = draft_signature(&draft);
        draft.set_selection(6, 11);
        let sig_b = draft_signature(&draft);
        assert_ne!(sig_a, sig_b);
        draft.replace_text("hello world!");
        let sig_c = draft_signature(&draft);
        assert_ne!(sig_b, sig_c);

        assert!(paste_stamp_allowed(None, 7, 10));
        assert!(paste_stamp_allowed(
            Some(Stamp {
                origin: Origin::Paste,
                epoch: 7,
                draft_rev: 10,
            }),
            7,
            10
        ));
        assert!(!paste_stamp_allowed(
            Some(Stamp {
                origin: Origin::Paste,
                epoch: 6,
                draft_rev: 10,
            }),
            7,
            10
        ));
        assert!(!paste_stamp_allowed(
            Some(Stamp {
                origin: Origin::Paste,
                epoch: 7,
                draft_rev: 10,
            }),
            7,
            12
        ));
        assert!(!paste_stamp_allowed(
            Some(Stamp {
                origin: Origin::Foreign,
                epoch: 7,
                draft_rev: 10,
            }),
            7,
            10
        ));
    }

    #[test]
    fn pasted_png_classification_rejects_corrupt_and_oversized_before_queueing() {
        assert!(classify_pasted_png(Some(128), Some(128.0)).is_ok());
        assert!(matches!(
            classify_pasted_png(Some(MAX_FILE + 1), Some((MAX_FILE + 1) as f64)),
            Err(Error::TooLarge)
        ));
        assert!(matches!(
            classify_pasted_png(Some(MAX_FILE + 1), None),
            Err(Error::TooLarge)
        ));
        assert!(matches!(
            classify_pasted_png(None, Some((MAX_FILE + 1) as f64)),
            Err(Error::TooLarge)
        ));
        assert!(matches!(
            classify_pasted_png(None, Some(16.0)),
            Err(Error::Unreadable)
        ));
        assert!(matches!(
            classify_pasted_png(None, None),
            Err(Error::Unreadable)
        ));
    }
}
