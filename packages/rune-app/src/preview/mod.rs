mod actions;
mod automation;
#[cfg(feature = "test-support")]
pub(crate) mod test_metrics;
mod view;
#[cfg(not(target_arch = "wasm32"))]
pub use view::{ime, poll, toolbar, viewport, visibility, window_focus};
#[cfg(not(target_arch = "wasm32"))]
use {
    crate::platform::ladybird::Guest,
    rune::edit::TextEdit,
    rune_theme_codenomad::preview::PreviewSurface,
    serde_json::{Value, json},
};

#[derive(Default)]
pub struct Preview {
    #[cfg(not(target_arch = "wasm32"))]
    panel: Option<Panel>,
    owner: Option<(String, String)>,
    requests: Option<std::sync::mpsc::Receiver<crate::platform::browser::Request>>,
    pending: Option<automation::Pending>,
    serial: u64,
    hidden: bool,
}

#[cfg(feature = "test-support")]
impl Preview {
    pub fn owner_for_trial(&self) -> Option<(&str, &str)> {
        self.owner.as_ref().map(|(w, s)| (w.as_str(), s.as_str()))
    }
}

#[cfg(not(target_arch = "wasm32"))]
struct Panel {
    registration: u64,
    guest: Guest,
    surface: PreviewSurface,
    address: TextEdit,
    generation: u64,
    last_frame: u64,
    loaded: bool,
    error: bool,
    viewport_px: (u32, u32, f32),
    focused: bool,
    composing: bool,
    epoch: u64,
    url: String,
}

#[cfg(not(target_arch = "wasm32"))]
impl Panel {
    fn new(guest: Guest) -> Self {
        static REGISTRATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        Self {
            registration: REGISTRATIONS.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            guest,
            surface: PreviewSurface::new(),
            address: TextEdit::new(""),
            generation: 0,
            last_frame: 0,
            loaded: false,
            error: false,
            viewport_px: (0, 0, 1.0),
            focused: false,
            composing: false,
            epoch: 0,
            url: String::new(),
        }
    }

    fn navigate(&mut self, reload: bool) {
        if !reload && !permitted(self.address.text.trim()) {
            self.error = true;
            return;
        }
        self.error = false;
        self.loaded = false;
        self.last_frame = 0;
        self.generation += 1;
        self.surface = PreviewSurface::new();
        self.send(json!({"op":if reload {"reload"} else {"navigate"},
            "url":self.address.text.trim(),"generation":self.generation}));
    }

    fn send(&mut self, message: Value) -> bool {
        let sent = self.guest.send(message);
        self.error |= !sent;
        sent
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn permitted(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        (url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            && url.username().is_empty()
            && url.password().is_none())
            || (url.scheme() == "file"
                && crate::platform::setting("RUNE_LADYBIRD_TEST_FILE").as_deref()
                    == Some(url.as_str()))
    })
}
