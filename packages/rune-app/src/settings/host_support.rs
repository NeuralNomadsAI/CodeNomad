use super::{Preferences, ServerOwner};
use crate::platform;
use codenomad_client::{Receiver, Sender, bounded, settings::info::metadata};
use std::sync::atomic::Ordering;

#[derive(Clone, Copy, Default)]
struct Capabilities {
    local: bool,
    config_files: bool,
}

#[derive(Default)]
pub(super) struct HostSupport {
    owner: Option<String>,
    stamp: Option<(u64, u64)>,
    flight: Option<((u64, u64), Sender<()>, Receiver<Option<Capabilities>>)>,
    capabilities: Capabilities,
    loaded: bool,
    failed: bool,
}

impl HostSupport {
    pub fn retry(&mut self) {
        self.owner = None;
        self.stamp = None;
        self.flight = None;
        self.failed = false;
    }

    fn current_stamp(prefs: &Preferences, backend: &crate::backend::Backend) -> (u64, u64) {
        (
            prefs.authority_handle().load(Ordering::SeqCst),
            backend.client.drop_generation(),
        )
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &rune::Waker, shown: bool) -> bool {
        let backend = prefs.backend.as_ref().filter(|b| {
            shown
                && prefs.can_retry()
                && !prefs.transport_lost()
                && ServerOwner::backend_verified(b)
        });
        let owner = backend.map(|backend| backend.client_id.as_str());
        let stamp = backend.map(|backend| Self::current_stamp(prefs, backend));
        if owner != self.owner.as_deref() || stamp != self.stamp {
            *self = Self::default();
            if let (Some(backend), Some(stamp)) = (backend, stamp) {
                let (cancel, cancelled) = bounded(1);
                let (out, reply) = bounded(1);
                self.owner = Some(backend.client_id.clone());
                self.stamp = Some(stamp);
                self.flight = Some((stamp, cancel, reply));
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
        if let Some((flight_stamp, _, rx)) = self.flight.as_ref() {
            let flight_stamp = *flight_stamp;
            match rx.try_recv() {
                Ok(Some(capabilities)) if Some(flight_stamp) == stamp => {
                    self.flight = None;
                    self.capabilities = capabilities;
                    self.loaded = true;
                    self.failed = false;
                    return true;
                }
                Ok(Some(_)) => {
                    self.flight = None;
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
            && !prefs.transport_lost()
            && prefs.backend.as_ref().is_some_and(|backend| {
                ServerOwner::backend_verified(backend)
                    && Some(backend.client_id.as_str()) == self.owner.as_deref()
                    && Some(Self::current_stamp(prefs, backend)) == self.stamp
            })
    }

    #[cfg(target_arch = "wasm32")]
    pub fn local(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.loaded && self.capabilities.local
    }

    #[cfg(target_arch = "wasm32")]
    pub fn local_unsupported(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.loaded && !self.capabilities.local
    }

    #[cfg(target_arch = "wasm32")]
    pub fn local_failed(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.failed
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
