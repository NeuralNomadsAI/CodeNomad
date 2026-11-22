//! Host-owned configuration and appearance, independent of any project location.
use crate::{
    Wake,
    backend::{Backend, read_json},
    history::Result,
    recovery::Input,
    runtime, stream,
};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering::SeqCst},
    },
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Config,
    State,
}
impl Owner {
    fn url(self, backend: &Backend) -> String {
        let path = match self {
            Self::Config => "api/storage/config/ui",
            Self::State => "api/storage/state/ui",
        };
        format!("{}{path}", backend.base)
    }

    pub async fn read(self, backend: &Backend) -> Result<Value> {
        let response = backend
            .client
            .get(self.url(backend))
            .query(&[("authoritative", "1")])
            .send()
            .await?
            .error_for_status()?;
        owner(read_json(response).await?)
    }

    pub async fn patch(self, backend: &Backend, patch: &Value) -> Result<Value> {
        let response = backend
            .client
            .patch(self.url(backend))
            .json(patch)
            .send()
            .await?
            .error_for_status()?;
        owner(read_json(response).await?)
    }
}

fn owner(value: Value) -> Result<Value> {
    if value.is_object() {
        Ok(value)
    } else {
        Err("Invalid preferences owner document".into())
    }
}

/// One scope-less subscription per connected host, independent of conversation lifetimes.
pub struct PreferencesWatch {
    _cancel: crate::Sender<()>,
    dirty: Arc<AtomicU8>,
}
impl PreferencesWatch {
    pub fn start(mut backend: Backend, wake: Wake) -> Self {
        let (hold, cancel) = crate::bounded(1);
        let dirty = Arc::new(AtomicU8::new(0));
        let notices = dirty.clone();
        backend.workspace.clear();
        backend.session.clear();
        backend.client_id.push_str("-preferences");
        runtime::spawn(async move {
            futures_lite::future::race(
                async {
                    for epoch in 1u64.. {
                        let (output, events) = crate::bounded(16);
                        stream::start(
                            backend.clone(),
                            epoch,
                            output,
                            Arc::new(stream::State::default()),
                        );
                        while let Ok(event) = events.recv().await {
                            let flag = match event {
                                Input::Closed(_) => break,
                                Input::Opened(_) => 3,
                                Input::Preferences(Owner::Config) => 1,
                                Input::Preferences(Owner::State) => 2,
                                _ => 0,
                            };
                            if flag != 0 && notices.fetch_or(flag, SeqCst) & flag != flag {
                                wake();
                            }
                        }
                        runtime::sleep(Duration::from_millis(250 * (1 << epoch.min(5)))).await;
                    }
                },
                async {
                    let _ = cancel.recv().await;
                },
            )
            .await;
        });
        Self {
            _cancel: hold,
            dirty,
        }
    }

    pub fn take(&self) -> (bool, bool) {
        let bits = self.dirty.swap(0, SeqCst);
        (bits & 1 != 0, bits & 2 != 0)
    }
}
