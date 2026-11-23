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

#[cfg(not(target_arch = "wasm32"))]
pub type Source = std::path::PathBuf;
#[cfg(target_arch = "wasm32")]
pub type Source = web_sys::File;

#[cfg(not(target_arch = "wasm32"))]
pub fn drop_files(s: &mut State, paths: &[Source]) {
    device::enqueue(
        s,
        paths.iter().take(MAX_FILES + 1).filter_map(|path| {
            Some(Offer {
                name: path.file_name()?.to_string_lossy().into_owned(),
                mime: super::device_file::mime(path).into(),
                source: path.clone(),
            })
        }),
    );
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
    #[cfg(not(target_arch = "wasm32"))]
    return super::device_file::read(source.clone(), limit.min(MAX_FILE)).await;
    #[cfg(target_arch = "wasm32")]
    {
        let limit = limit.min(MAX_FILE);
        let over = if limit == MAX_FILE {
            Error::TooLarge
        } else {
            Error::Limit
        };
        let length = js_sys::Reflect::get(source, &wasm_bindgen::JsValue::from_str("size"))
            .ok()
            .and_then(|value| value.as_f64())
            .ok_or(Error::Unreadable)?;
        if length > limit as f64 {
            return Err(over);
        }
        let buffer = wasm_bindgen_futures::JsFuture::from(source.array_buffer())
            .await
            .map_err(|_| Error::Unreadable)?;
        let bytes = js_sys::Uint8Array::new(&buffer);
        if bytes.length() as usize > limit {
            return Err(over);
        }
        Ok(bytes.to_vec().into())
    }
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
                        let mime = source.type_();
                        Offer {
                            name: source.name(),
                            mime: if mime.is_empty() {
                                "application/octet-stream".into()
                            } else {
                                mime
                            },
                            source,
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
        choice.input.click();
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
