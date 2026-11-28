use super::{Pairing, Preferences, Remote};
use crate::strings::t;
use rune::{El, col, el, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct Copy {
    #[cfg(target_arch = "wasm32")]
    reply: Option<(String, codenomad_client::Receiver<bool>)>,
    target: Option<String>,
    result: Option<bool>,
}

impl Copy {
    pub fn poll(&mut self) -> bool {
        #[cfg(target_arch = "wasm32")]
        if let Some((target, result)) = self
            .reply
            .as_ref()
            .and_then(|(target, reply)| reply.try_recv().ok().map(|ok| (target.clone(), ok)))
        {
            self.reply = None;
            self.target = Some(target);
            self.result = Some(result);
            return true;
        }
        false
    }

    pub fn copied(&self, url: &str) -> bool {
        self.result == Some(true) && self.target.as_deref() == Some(url)
    }

    pub fn failed(&self, url: &str) -> bool {
        self.result == Some(false) && self.target.as_deref() == Some(url)
    }

    pub fn write(&mut self, url: &str, _prefs: &Preferences, _tx: &mut rune::Tx) {
        crate::chat::tools::children::note_clipboard_write();
        #[cfg(not(target_arch = "wasm32"))]
        {
            _tx.copy(url.to_owned());
            self.target = Some(url.to_owned());
            self.result = Some(true);
        }
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
                self.target = Some(url.to_owned());
                self.result = Some(false);
                return;
            };
            let result = clipboard.write_text(url);
            let (out, reply) = codenomad_client::bounded(1);
            self.reply = Some((url.to_owned(), reply));
            self.target = Some(url.to_owned());
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
    let label = t(if copy.copied(&pairing.url) {
        "remoteControl.pairing.copied"
    } else {
        "remoteControl.pairing.copy"
    });
    let expires = t("remoteControl.pairing.expires")
        .replace("{time}", &expiry_time(&pairing.expires_at_rfc3339));
    col()
        .full_width()
        .separate(Space::Sm)
        .child(
            text(t("remoteControl.pairing.title"))
                .text_role(TextRole::Title)
                .role("heading"),
        )
        .child(
            text(t("remoteControl.pairing.description"))
                .text_role(TextRole::Small)
                .wrap(),
        )
        .child(
            el().full_width().inset_surface().pad(Space::Sm).child(
                text(&pairing.url)
                    .text_role(TextRole::Mono)
                    .wrap()
                    .literal_direction()
                    .selectable(true),
            ),
        )
        .child(
            layout::action_row().child(layout::button_tx(label, busy, move |s, tx| {
                let Some(state) = access(s) else {
                    return;
                };
                let prefs = shared.borrow();
                if let Some(active) = state.pairing.as_ref()
                    && prefs.can_retry()
                    && state.owner.as_ref()
                        == prefs.backend.as_ref().map(|backend| &backend.client_id)
                    && !active.pairing.remaining().is_zero()
                {
                    let url = active.pairing.url.clone();
                    state.copy.write(&url, &prefs, tx);
                }
            })),
        )
        .child(text(&expires).text_role(TextRole::Small).wrap())
        .children(
            copy.failed(&pairing.url)
                .then(|| chrome::palette::save_error(t("messageSection.quote.copyFailed"))),
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

fn expiry_time(stamp: &str) -> String {
    #[cfg(target_arch = "wasm32")]
    {
        use js_sys::{Date, Object};
        let date = Date::new(&stamp.into());
        if date.get_time().is_finite()
            && let Some(value) = date
                .to_locale_time_string(crate::strings::locale())
                .as_string()
        {
            let _ = Object::new();
            return value;
        }
    }
    stamp.to_owned()
}
