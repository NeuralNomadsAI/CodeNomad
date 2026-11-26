use super::Preferences;
use crate::platform;
use codenomad_client::{Receiver, Sender, bounded, settings::info::metadata};

#[derive(Clone, Copy, Default)]
struct Capabilities {
    local: bool,
    config_files: bool,
}

#[derive(Default)]
pub(super) struct HostSupport {
    owner: Option<String>,
    flight: Option<(Sender<()>, Receiver<Option<Capabilities>>)>,
    capabilities: Capabilities,
    loaded: bool,
    failed: bool,
}

impl HostSupport {
    pub fn retry(&mut self) {
        self.owner = None;
        self.flight = None;
        self.failed = false;
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &rune::Waker, shown: bool) -> bool {
        let backend = prefs
            .backend
            .as_ref()
            .filter(|_| shown && prefs.can_retry());
        let owner = backend.map(|backend| backend.client_id.as_str());
        if owner != self.owner.as_deref() {
            *self = Self::default();
            if let Some(backend) = backend {
                let (cancel, cancelled) = bounded(1);
                let (out, reply) = bounded(1);
                self.owner = Some(backend.client_id.clone());
                self.flight = Some((cancel, reply));
                let (backend, wake) = (backend.clone(), wake.clone());
                platform::spawn(async move {
                    if let Some(meta) =
                        platform::reads::cancellable(&cancelled, metadata(&backend)).await
                    {
                        let caps = meta.ok().map(|meta| Capabilities {
                            local: meta["localRequest"] == true,
                            config_files: meta["capabilities"].as_array().is_some_and(|items| {
                                items.iter().any(|capability| capability == "config-files")
                            }),
                        });
                        if out.try_send(caps).is_ok() {
                            wake();
                        }
                    }
                });
            }
            return true;
        }
        if let Some((_, rx)) = self.flight.as_ref() {
            match rx.try_recv() {
                Ok(Some(capabilities)) => {
                    self.flight = None;
                    self.capabilities = capabilities;
                    self.loaded = true;
                    self.failed = false;
                    return true;
                }
                Ok(None) => {
                    self.flight = None;
                    self.loaded = false;
                    self.failed = true;
                    return true;
                }
                Err(_) if rx.is_closed() => {
                    self.flight = None;
                    self.loaded = false;
                    self.failed = true;
                    return true;
                }
                Err(_) => {}
            }
        }
        false
    }

    fn current(&self, prefs: &Preferences) -> bool {
        prefs.can_retry()
            && prefs
                .backend
                .as_ref()
                .is_some_and(|backend| Some(backend.client_id.as_str()) == self.owner.as_deref())
    }

    #[cfg(target_arch = "wasm32")]
    pub fn local(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.loaded && self.capabilities.local
    }

    pub fn config_files(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.loaded && self.capabilities.config_files
    }

    pub fn config_files_failed(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.failed
    }

    pub fn config_files_unsupported(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.loaded && !self.capabilities.config_files
    }
}
