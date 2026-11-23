mod document;

use crate::{backend::Backend, platform};
pub(super) use codenomad_client::settings::Owner;
use codenomad_client::settings::PreferencesWatch;
use document::{Choice, Document};
use rune_theme_codenomad::palettes::{Palette, built_in};
use serde_json::Value;
#[cfg(any(test, feature = "test-support"))]
use serde_json::json;

#[derive(Default)]
pub(super) struct Preferences {
    pub(super) backend: Option<Backend>,
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) provider_target: Option<super::providers::Target>,
    config: Document,
    state: Document,
    pub(super) window_wake: Option<rune::Waker>,
    pub(super) main_wake: Option<rune::Waker>,
    pub(super) revision: u64,
    stream: Option<PreferencesWatch>,
    closing_stream: Option<codenomad_client::Receiver<()>>,
    authentication_required: bool,
}

impl Preferences {
    pub(super) fn shortcut(&self, action: &str) -> Option<&[Value]> {
        self.config.snapshot.as_ref()?["settings"]["hotkeyOverrides"][action]
            .as_array()
            .map(Vec::as_slice)
    }

    #[cfg(test)]
    pub(super) fn fixture_shortcuts(&mut self, overrides: Value) {
        self.config.snapshot = Some(json!({"settings": {"hotkeyOverrides": overrides}}));
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn flush(&mut self) -> bool {
        use std::time::Duration;
        if self.backend.is_some() && !self.authentication_required {
            self.take_invalidations();
            self.config.prepare_drain();
            self.state.prepare_drain();
            // Each lane can finish a PATCH/readback, a retry preflight, and one trailing PATCH/readback.
            if self.config.draining() || self.state.draining() {
                platform::block_on(async {
                    let _ = tokio::time::timeout(
                        codenomad_client::http::REQUEST_TIMEOUT * 5 + Duration::from_millis(100),
                        async {
                            while self.config.draining() || self.state.draining() {
                                self.poll_documents();
                                if self.config.draining() || self.state.draining() {
                                    platform::sleep(Duration::from_millis(10)).await;
                                }
                            }
                        },
                    )
                    .await;
                });
            }
        }
        !self.config.has_unconfirmed() && !self.state.has_unconfirmed()
    }
    pub fn bind(&mut self, owner: Option<Backend>) -> bool {
        if self.backend.as_ref().map(|b| &b.client_id) == owner.as_ref().map(|b| &b.client_id) {
            return false;
        }
        let same_address = self
            .backend
            .as_ref()
            .zip(owner.as_ref())
            .is_some_and(|(old, new)| {
                old.base == new.base
                    && old.client.server_identity().is_some()
                    && old.client.server_identity() == new.client.server_identity()
            });
        self.config.rebind(same_address);
        self.state.rebind(same_address);
        self.backend = owner;
        self.authentication_required = false;
        self.unwatch();
        self.refresh();
        self.revision += 1;
        true
    }

    pub fn refresh(&mut self) {
        self.config.invalidate();
        self.state.invalidate();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn retry(&mut self) {
        self.config.retry();
        self.state.retry();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn can_retry(&self) -> bool {
        self.backend.is_some() && !self.authentication_required
    }

    pub fn watch(&mut self, wake: &rune::Waker) {
        if self.authentication_required {
            return;
        }
        if self
            .closing_stream
            .as_ref()
            .is_some_and(|reader| !reader.is_closed())
        {
            return;
        }
        self.closing_stream = None;
        if self.stream.is_none()
            && let Some(backend) = &self.backend
        {
            let (watch, task) = PreferencesWatch::task(backend.clone(), wake.clone());
            self.stream = Some(watch);
            platform::spawn(task);
        }
    }

    pub fn unwatch(&mut self) {
        if let Some(watch) = self.stream.take() {
            self.closing_stream = Some(watch.stop());
        }
    }

    pub fn stop_before_conversation(&mut self) -> Option<codenomad_client::Receiver<()>> {
        self.unwatch();
        self.closing_stream
            .clone()
            .filter(|reader| !reader.is_closed())
    }

    pub fn require_authentication(&mut self) {
        self.authentication_required = true;
        self.unwatch();
        self.revision += 1;
        if let Some(wake) = &self.window_wake {
            wake();
        }
    }

    pub fn observe_authentication(&mut self) -> bool {
        if self
            .stream
            .as_ref()
            .is_some_and(PreferencesWatch::take_authentication_required)
        {
            self.require_authentication();
            true
        } else {
            false
        }
    }

    pub fn invalidate(&mut self, owner: Owner) {
        self.doc_mut(owner).invalidate();
    }

    fn doc_mut(&mut self, owner: Owner) -> &mut Document {
        match owner {
            Owner::Config => &mut self.config,
            Owner::State => &mut self.state,
        }
    }

    fn doc(&self, owner: Owner) -> &Document {
        match owner {
            Owner::Config => &self.config,
            Owner::State => &self.state,
        }
    }

    pub fn saved(&self, owner: Owner) -> Option<&Value> {
        self.doc(owner).snapshot.as_ref()
    }

    pub fn error(&self) -> Option<&'static str> {
        if self.authentication_required {
            Some("rune.connect_error")
        } else if self.config.write_failed() || self.state.write_failed() {
            Some("settings.preferenceSaveFailed")
        } else if self.config.read_failed() || self.state.read_failed() {
            Some("rune.connect_error")
        } else {
            None
        }
    }

    pub fn poll(&mut self) -> bool {
        self.take_invalidations();
        self.poll_documents()
    }

    fn take_invalidations(&mut self) {
        if let Some(stream) = &self.stream {
            let (config, state) = stream.take();
            if config {
                self.config.invalidate();
            }
            if state {
                self.state.invalidate();
            }
        }
    }

    fn poll_documents(&mut self) -> bool {
        if self.authentication_required {
            return false;
        }
        let Some(backend) = &self.backend else {
            return false;
        };
        let (main, window) = (self.main_wake.clone(), self.window_wake.clone());
        let changed = self.config.poll(backend, Owner::Config, &main, &window)
            | self.state.poll(backend, Owner::State, &main, &window);
        if changed {
            self.revision += 1;
        }
        changed
    }

    pub fn locale(&self) -> Option<&'static str> {
        let id = self.saved(Owner::Config)?["settings"]["locale"].as_str()?;
        Some(rune_theme_codenomad::catalogue::canonical_locale(id))
    }

    pub fn locale_display(&self) -> Option<&'static str> {
        self.config
            .requested(Choice::Locale)
            .map(rune_theme_codenomad::catalogue::canonical_locale)
            .or_else(|| self.locale())
    }

    pub fn locale_ready(&self) -> bool {
        !self.authentication_required
            && self.config.snapshot.is_some()
            && !self.config.read_failed()
    }

    pub fn set_locale(&mut self, locale: &'static str) {
        if self.locale_ready() && self.backend.is_some() && Some(locale) != self.locale_display() {
            self.config.stage(Choice::Locale, locale);
        }
    }

    pub fn mode(&self) -> &'static str {
        let Some(state) = self.saved(Owner::State) else {
            return "system";
        };
        match state["appearancePreferences"]["mode"].as_str() {
            Some("light") => "light",
            Some("dark") => "dark",
            Some("system") => "system",
            _ => self
                .legacy(state)
                .map_or("system", |(appearance, _)| appearance),
        }
    }

    pub(super) fn dark(&self, system_dark: bool) -> bool {
        match self.mode() {
            "light" => false,
            "dark" => true,
            _ => system_dark,
        }
    }

    pub fn set_mode(&mut self, mode: &'static str) {
        if !self.mode_ready() || self.backend.is_none() || self.mode_display() == mode {
            return;
        }
        // The legacy selection still supplies a missing slot. Only update the
        // mode, so neither defaults nor another window's palette move with it.
        self.state.stage(Choice::Mode, mode);
    }

    pub fn mode_ready(&self) -> bool {
        !self.authentication_required && self.state.snapshot.is_some() && !self.state.read_failed()
    }

    pub fn mode_display(&self) -> &'static str {
        self.state
            .requested(Choice::Mode)
            .unwrap_or_else(|| self.mode())
    }

    fn legacy(&self, state: &Value) -> Option<(&'static str, &'static str)> {
        let config = self.saved(Owner::Config).unwrap_or(&Value::Null);
        let scheme = state
            .get("colorScheme")
            .or_else(|| config.get("colorScheme"));
        if let Some(scheme) = scheme {
            let id = scheme.as_str().or_else(|| scheme["id"].as_str());
            if id == Some("system") {
                return None;
            }
            if id == Some("custom") {
                let appearance = if scheme["appearance"] == "light" {
                    "light"
                } else {
                    "dark"
                };
                return Some((appearance, "custom"));
            }
            if let Some(palette) = built_in().iter().find(|p| Some(p.id) == id) {
                let appearance = if palette.dark { "dark" } else { "light" };
                return Some((appearance, palette.id));
            }
        }
        let (appearance, id) = match state
            .get("theme")
            .or_else(|| config.get("theme"))
            .and_then(Value::as_str)
        {
            Some("light") => ("light", "light"),
            Some("dark") => ("dark", "classic"),
            _ => return None,
        };
        Some((appearance, id))
    }

    pub fn palette(&self, dark: bool) -> Option<&'static Palette> {
        let state = self.saved(Owner::State)?;
        let mode = if dark { "dark" } else { "light" };
        let legacy = self
            .legacy(state)
            .filter(|(appearance, _)| *appearance == mode);
        let id = state["appearancePreferences"][mode]["scheme"]["id"]
            .as_str()
            .or_else(|| legacy.map(|(_, id)| id));
        let palettes = built_in();
        palettes
            .iter()
            .find(|p| p.dark == dark && Some(p.id) == id)
            .or_else(|| {
                palettes
                    .iter()
                    .find(|p| p.id == if dark { "mist" } else { "porcelain" })
            })
    }

    pub fn set_palette(&mut self, palette: &'static Palette) {
        if !self.palette_ready() || self.backend.is_none() {
            return;
        }
        if self.state.requested(Choice::Palette(palette.dark)) != Some(palette.id) {
            self.state.stage(Choice::Palette(palette.dark), palette.id);
        }
    }

    pub fn palette_ready(&self) -> bool {
        self.mode_ready()
            && (self.config.snapshot.is_some()
                || self.config.read_failed()
                || self.state.snapshot.as_ref().is_some_and(|state| {
                    state["appearancePreferences"]["mode"].is_string()
                        || state.get("theme").is_some()
                        || state.get("colorScheme").is_some()
                }))
            && self.state.requested(Choice::Mode).is_none()
    }

    pub fn palette_display(&self, dark: bool) -> Option<&'static Palette> {
        self.state
            .requested(Choice::Palette(dark))
            .and_then(|id| built_in().iter().find(|p| p.dark == dark && p.id == id))
            .or_else(|| self.palette(dark))
    }

    pub fn step_palette(&mut self, dark: bool, step: isize) {
        let options: Vec<_> = built_in().iter().filter(|p| p.dark == dark).collect();
        let Some(current) = self.palette_display(dark) else {
            return;
        };
        let next = options
            .iter()
            .position(|p| p.id == current.id)
            .and_then(|index| index.checked_add_signed(step))
            .and_then(|index| options.get(index));
        if let Some(palette) = next {
            self.set_palette(palette);
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn fixture(&mut self) {
        self.fixture_locale("en");
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(super) fn fixture_locale(&mut self, locale: &str) {
        self.config.snapshot = Some(json!({"settings":{"locale":locale}}));
        self.state.snapshot = Some(
            json!({"appearancePreferences":{"mode":"system","light":{"scheme":{"id":"light"}},"dark":{"scheme":{"id":"classic"}}}}),
        );
    }

    #[cfg(test)]
    pub(super) fn fixture_mode(&mut self, mode: &'static str) {
        if let Some(state) = &mut self.state.snapshot {
            state["appearancePreferences"]["mode"] = json!(mode);
            self.revision += 1;
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
