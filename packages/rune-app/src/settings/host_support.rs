use super::Preferences;
use crate::platform;
use codenomad_client::{Receiver, Sender, bounded, settings::info::metadata};
use std::time::Duration;

const RETRY_DELAY: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Default)]
struct Capabilities {
    local: bool,
    config_files: bool,
    missions: bool,
}

#[derive(Default)]
pub(super) struct HostSupport {
    owner: Option<String>,
    flight: Option<(Sender<()>, Receiver<Result<Capabilities, ()>>)>,
    capabilities: Capabilities,
}

fn parse_capabilities(meta: &serde_json::Value) -> Capabilities {
    Capabilities {
        local: meta["localRequest"] == true,
        config_files: meta["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|capability| capability == "config-files")),
        missions: meta["capabilities"]
            .as_array()
            .is_some_and(|items| items.iter().any(|capability| capability == "missions")),
    }
}

impl HostSupport {
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
                    let Some(first) =
                        platform::reads::cancellable(&cancelled, metadata(&backend)).await
                    else {
                        return;
                    };
                    let resolved = match first {
                        Ok(meta) => Ok(parse_capabilities(&meta)),
                        Err(_) => {
                            if platform::reads::cancellable(
                                &cancelled,
                                platform::sleep(RETRY_DELAY),
                            )
                            .await
                            .is_none()
                            {
                                return;
                            }
                            let Some(second) =
                                platform::reads::cancellable(&cancelled, metadata(&backend)).await
                            else {
                                return;
                            };
                            second.map(|meta| parse_capabilities(&meta)).map_err(|_| ())
                        }
                    };
                    if out.try_send(resolved).is_ok() {
                        wake();
                    }
                });
            }
            return true;
        }
        if let Some(result) = self.flight.as_ref().and_then(|(_, rx)| rx.try_recv().ok()) {
            self.flight = None;
            if let Ok(capabilities) = result {
                self.capabilities = capabilities;
            }
            return true;
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
        self.current(prefs) && self.capabilities.local
    }

    pub fn config_files(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.capabilities.config_files
    }

    pub fn missions(&self, prefs: &Preferences) -> bool {
        self.current(prefs) && self.capabilities.missions
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::files::test_http::Http;
    use serde_json::json;

    #[test]
    fn host_support_recovers_from_transient_meta_failure() {
        platform::block_on(async {
            let http = Http::new().await;
            let mut prefs = Preferences::default();
            prefs.bind(Some(http.backend.clone()));
            let mut support = HostSupport::default();
            let wake: rune::Waker = std::sync::Arc::new(|| {});
            assert!(support.poll(&prefs, &wake, true));
            assert!(!support.missions(&prefs));

            // First /api/meta call fails transiently; ignore background config/state reads if any.
            let mut failed_once = false;
            let mut succeeded = false;
            while !succeeded {
                let req = http.accept().await;
                if req.header.starts_with("GET /api/meta ") {
                    if !failed_once {
                        failed_once = true;
                        req.reply(503, json!({"error": "transient"})).await;
                    } else {
                        req.reply(
                            200,
                            json!({"localRequest": true, "capabilities": ["missions", "config-files"]}),
                        )
                        .await;
                        succeeded = true;
                    }
                } else {
                    req.reply(200, json!({})).await;
                }
            }
            for _ in 0..100 {
                support.poll(&prefs, &wake, true);
                if support.missions(&prefs) {
                    break;
                }
                platform::sleep(Duration::from_millis(20)).await;
            }
            assert!(support.missions(&prefs));
            assert!(support.config_files(&prefs));
        });
    }
}
