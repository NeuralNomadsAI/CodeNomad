use super::{Pairing, Preferences, Remote};
use crate::strings::t;
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct Copy {
    #[cfg(target_arch = "wasm32")]
    reply: Option<codenomad_client::Receiver<bool>>,
    result: Option<bool>,
}

impl Copy {
    pub fn poll(&mut self) -> bool {
        #[cfg(target_arch = "wasm32")]
        if let Some(result) = self.reply.as_ref().and_then(|reply| reply.try_recv().ok()) {
            self.reply = None;
            self.result = Some(result);
            return true;
        }
        false
    }

    fn write(&mut self, url: &str, _prefs: &Preferences, _tx: &mut rune::Tx) {
        crate::chat::tools::children::note_clipboard_write();
        #[cfg(not(target_arch = "wasm32"))]
        _tx.copy(url.to_owned());
        #[cfg(target_arch = "wasm32")]
        {
            use wasm_bindgen::JsCast;
            if self.reply.is_some() {
                return;
            }
            let Some(clipboard) = web_sys::window().and_then(|window| {
                js_sys::Reflect::get(window.navigator().as_ref(), &"clipboard".into())
                    .ok()?
                    .dyn_into::<web_sys::Clipboard>()
                    .ok()
            }) else {
                self.result = Some(false);
                return;
            };
            let result = clipboard.write_text(url);
            let (out, reply) = codenomad_client::bounded(1);
            self.reply = Some(reply);
            self.result = None;
            let wake = _prefs.main_wake.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let copied = wasm_bindgen_futures::JsFuture::from(result).await.is_ok();
                if out.try_send(copied).is_ok()
                    && let Some(wake) = wake
                {
                    wake();
                }
            });
        }
    }
}

pub(super) fn view<S: 'static>(
    pairing: &Pairing,
    copy: &Copy,
    busy: bool,
    shared: &Rc<RefCell<Preferences>>,
    access: fn(&mut S) -> Option<&mut Remote>,
) -> El {
    let shared = shared.clone();
    let label = t(if copy.result == Some(true) {
        "remoteControl.pairing.copied"
    } else {
        "remoteControl.pairing.copy"
    });
    col()
        .full_width()
        .separate(Space::Sm)
        .child(
            text(t("remoteControl.pairing.title"))
                .text_role(TextRole::Title)
                .role("heading"),
        )
        .child(text(&pairing.url).wrap().literal_direction())
        .child(layout::button_tx(label, busy, move |s, tx| {
            let Some(state) = access(s) else {
                return;
            };
            let prefs = shared.borrow();
            if let Some(pairing) = state.pairing.as_ref()
                && prefs.can_retry()
                && state.owner.as_ref() == prefs.backend.as_ref().map(|backend| &backend.client_id)
                && !pairing.remaining().is_zero()
            {
                state.copy.write(&pairing.url, &prefs, tx);
            }
        }))
        .children(
            (copy.result == Some(false))
                .then(|| text(t("messageSection.quote.copyFailed")).role("alert")),
        )
}

pub(super) fn last_seen(stamp: &str) -> String {
    #[cfg(target_arch = "wasm32")]
    {
        use js_sys::{Date, Object};
        let date = Date::new(&stamp.into());
        if date.get_time().is_finite()
            && let Some(value) = date
                .to_locale_string(crate::strings::locale(), &Object::new())
                .as_string()
        {
            return value;
        }
    }
    stamp.to_owned()
}
