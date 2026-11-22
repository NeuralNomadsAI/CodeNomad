use crate::{backend::Backend, platform};
pub(super) use codenomad_client::settings::Owner;
use codenomad_client::{Receiver, bounded, settings::PreferencesWatch};
use rune_theme_codenomad::palettes::{Palette, built_in};
use serde_json::{Value, json};
#[derive(Default)]
struct Document {
    snapshot: Option<Value>,
    pending: Option<Value>,
    writing: Option<Value>,
    read: bool,
    error: Option<&'static str>,
    flight: Option<Receiver<Reply>>,
    barrier: Option<Receiver<Reply>>,
    uncertain: bool,
    read_failed: bool,
}
struct Reply {
    snapshot: Option<Value>,
    error: Option<&'static str>,
    uncertain: bool,
}

#[derive(Default)]
pub(super) struct Preferences {
    pub(super) backend: Option<Backend>,
    config: Document,
    state: Document,
    pub(super) window_wake: Option<rune::Waker>,
    pub(super) main_wake: Option<rune::Waker>,
    pub(super) revision: u64,
    stream: Option<PreferencesWatch>,
}

impl Preferences {
    pub fn bind(&mut self, owner: Option<Backend>) -> bool {
        if self.backend.as_ref().map(|b| &b.client_id) == owner.as_ref().map(|b| &b.client_id) {
            return false;
        }
        let same_address = self
            .backend
            .as_ref()
            .zip(owner.as_ref())
            .is_some_and(|(old, new)| old.base == new.base);
        for document in [&mut self.config, &mut self.state] {
            let barrier = same_address
                .then(|| document.barrier.take().or_else(|| document.flight.take()))
                .flatten();
            *document = Document {
                barrier,
                ..Document::default()
            };
        }
        self.backend = owner;
        self.stream = None;
        self.refresh();
        self.revision += 1;
        true
    }

    pub fn refresh(&mut self) {
        self.config.read = true;
        self.state.read = true;
    }

    pub fn watch(&mut self, wake: &rune::Waker) {
        if self.stream.is_none()
            && let Some(backend) = &self.backend
        {
            self.stream = Some(PreferencesWatch::start(backend.clone(), wake.clone()));
        }
    }

    pub fn unwatch(&mut self) {
        self.stream = None;
    }

    pub fn invalidate(&mut self, owner: Owner) {
        match owner {
            Owner::Config => self.config.read = true,
            Owner::State => self.state.read = true,
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

    pub fn ready(&self, owner: Owner) -> bool {
        let doc = self.doc(owner);
        doc.snapshot.is_some()
            && doc.flight.is_none()
            && doc.pending.is_none()
            && !doc.read
            && !doc.uncertain
            && !doc.read_failed
    }

    pub fn error(&self) -> Option<&'static str> {
        self.config.error.or(self.state.error)
    }

    pub fn change(&mut self, owner: Owner, patch: Value) {
        // Reject captured clicks from before this owner's current display was ready.
        if !self.ready(owner) || self.backend.is_none() {
            return;
        }
        let doc = match owner {
            Owner::Config => &mut self.config,
            Owner::State => &mut self.state,
        };
        doc.pending = Some(patch);
    }

    pub fn poll(&mut self) -> bool {
        let Some(backend) = &self.backend else {
            return false;
        };
        let (main, window) = (self.main_wake.clone(), self.window_wake.clone());
        if let Some(stream) = &self.stream {
            let (config, state) = stream.take();
            self.config.read |= config;
            self.state.read |= state;
        }
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
        [&self.config.pending, &self.config.writing]
            .into_iter()
            .flatten()
            .find_map(|patch| patch["settings"]["locale"].as_str())
            .map(rune_theme_codenomad::catalogue::canonical_locale)
            .or_else(|| self.locale())
    }

    pub fn locale_ready(&self) -> bool {
        self.config.snapshot.is_some() && !self.config.read_failed && !self.config.uncertain
    }

    pub fn set_locale(&mut self, locale: &'static str) {
        if self.locale_ready() && self.backend.is_some() && Some(locale) != self.locale_display() {
            self.config.pending = Some(json!({"settings":{"locale":locale}}));
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

    pub fn set_mode(&mut self, mode: &'static str) {
        if self.saved(Owner::Config).is_none() || self.mode() == mode {
            return;
        }
        // The legacy selection still supplies a missing slot. Only update the
        // mode, so neither defaults nor another window's palette move with it.
        self.change(Owner::State, json!({"appearancePreferences":{"mode":mode}}));
    }

    fn legacy(&self, state: &Value) -> Option<(&'static str, Value)> {
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
                return Some((appearance, scheme.clone()));
            }
            if let Some(palette) = built_in().iter().find(|p| Some(p.id) == id) {
                let appearance = if palette.dark { "dark" } else { "light" };
                return Some((
                    appearance,
                    json!({"id":palette.id,"appearance":appearance,"colors":scheme["colors"]}),
                ));
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
        Some((appearance, json!({"id":id,"appearance":appearance})))
    }

    pub fn palette(&self, dark: bool) -> Option<&'static Palette> {
        let state = self.saved(Owner::State)?;
        let mode = if dark { "dark" } else { "light" };
        let legacy = self
            .legacy(state)
            .filter(|(appearance, _)| *appearance == mode);
        let id = state["appearancePreferences"][mode]["scheme"]["id"]
            .as_str()
            .or_else(|| {
                legacy
                    .as_ref()
                    .and_then(|(_, scheme)| scheme["id"].as_str())
            });
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
        let mode = if palette.dark { "dark" } else { "light" };
        let patch = self.state.pending.get_or_insert_with(|| json!({}));
        patch["appearancePreferences"][mode] = json!({
            "scheme":{"id":palette.id,"appearance":mode,"colors":null},"presetId":null
        });
    }

    pub fn palette_ready(&self) -> bool {
        self.state.snapshot.is_some()
            && !self.state.uncertain
            && !self.state.read_failed
            && [&self.state.pending, &self.state.writing]
                .into_iter()
                .flatten()
                .all(|patch| patch["appearancePreferences"]["mode"].is_null())
    }

    pub fn palette_display(&self, dark: bool) -> Option<&'static Palette> {
        let mode = if dark { "dark" } else { "light" };
        [&self.state.pending, &self.state.writing]
            .into_iter()
            .flatten()
            .find_map(|patch| {
                let id = patch["appearancePreferences"][mode]["scheme"]["id"].as_str()?;
                built_in().iter().find(|p| p.dark == dark && p.id == id)
            })
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
        self.config.snapshot = Some(json!({"settings":{"locale":"en"}}));
        self.state.snapshot = Some(
            json!({"appearancePreferences":{"mode":"system","light":{"scheme":{"id":"light"}},"dark":{"scheme":{"id":"classic"}}}}),
        );
    }
}

impl Document {
    fn poll(
        &mut self,
        backend: &Backend,
        owner: Owner,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        if self
            .barrier
            .as_ref()
            .is_some_and(|barrier| barrier.try_recv().is_err() && !barrier.is_closed())
        {
            return false;
        }
        self.barrier = None;
        let mut changed = false;
        if let Some(reply) = self.flight.as_ref().and_then(|r| r.try_recv().ok()) {
            self.flight = None;
            if self.writing.take().is_some() || !self.read {
                self.error = reply.error;
                self.uncertain = reply.uncertain || self.uncertain && reply.snapshot.is_none();
                self.read_failed = reply.snapshot.is_none();
                if self.uncertain || self.read_failed {
                    self.pending = None;
                }
                if let Some(snapshot) = reply.snapshot {
                    self.snapshot = Some(snapshot);
                }
            }
            changed = true;
        }
        if self.flight.is_some() {
            return changed;
        }
        let patch = self.pending.take();
        if patch.is_none() && !self.read {
            return changed;
        }
        if patch.is_none() {
            self.read = false;
        }
        self.writing.clone_from(&patch);
        let (sender, receiver) = bounded(1);
        self.flight = Some(receiver);
        let backend = backend.clone();
        let (main, window) = (main.clone(), window.clone());
        platform::spawn(async move {
            let reply = if let Some(patch) = patch {
                match owner.patch(&backend, &patch).await {
                    Ok(snapshot) => Reply {
                        snapshot: Some(snapshot),
                        error: None,
                        uncertain: false,
                    },
                    // An unconfirmed PATCH is never sent twice.
                    Err(_) => {
                        let snapshot = owner.read(&backend).await.ok();
                        Reply {
                            uncertain: snapshot.is_none(),
                            snapshot,
                            error: Some("settings.preferenceSaveFailed"),
                        }
                    }
                }
            } else {
                let snapshot = owner.read(&backend).await.ok();
                Reply {
                    error: snapshot.is_none().then_some("rune.connect_error"),
                    snapshot,
                    uncertain: false,
                }
            };
            let _ = sender.send(reply).await;
            if let Some(wake) = main {
                wake();
            }
            if let Some(wake) = window {
                wake();
            }
        });
        true
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;
