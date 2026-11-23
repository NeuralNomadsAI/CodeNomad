use crate::{
    State,
    backend::Backend,
    screen,
    strings::{locale, t},
};
use codenomad_client::{
    Receiver, Sender, bounded,
    interruption_receipts::{Decision, Origin, Receipt, ReceiptPage},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
};
use std::{
    collections::HashMap,
    rc::{Rc, Weak},
};

#[cfg(test)]
mod tests;
mod view;
pub(super) use view::{for_message, session};

#[derive(Default)]
pub(crate) struct Receipts {
    backend: Option<Backend>,
    entries: HashMap<Option<String>, Entry>,
}

#[derive(Default)]
struct Entry {
    receipt: Vec<Receipt>,
    next: Option<String>,
    visible: Option<Weak<()>>,
    on_screen: bool,
    job: Option<Job>,
    dirty: bool,
    failed: bool,
}

struct Job {
    _cancel: Sender<()>,
    result: Receiver<Option<ReceiptPage>>,
    more: bool,
}

impl Receipts {
    #[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
    pub(crate) fn session_count(&self) -> usize {
        self.entries
            .get(&None)
            .map_or(0, |entry| entry.receipt.len())
    }

    pub(crate) fn bind(&mut self, backend: Backend) {
        self.clear();
        self.backend = backend.session.starts_with("ses").then_some(backend);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn invalidate(&mut self, message: Option<String>) {
        if let Some(entry) = self.entries.get_mut(&message) {
            entry.dirty = true;
        }
    }

    pub(crate) fn reconnect(&mut self) {
        for entry in self.entries.values_mut() {
            entry.dirty = true;
        }
    }

    pub(super) fn lease(s: &State, message: &str) -> Rc<()> {
        s.transcript_display
            .receipts
            .entries
            .get(&Some(message.into()))
            .and_then(|entry| entry.visible.as_ref())
            .and_then(Weak::upgrade)
            .unwrap_or_default()
    }

    pub(super) fn demand(s: &mut State, message: &str, visible: bool, lease: &Rc<()>) -> bool {
        let key = Some(message.to_owned());
        let receipts = &mut s.transcript_display.receipts;
        if let Some(entry) = receipts.entries.get_mut(&key) {
            entry.on_screen = visible;
            if !visible {
                entry.dirty |= entry.job.take().is_some();
            }
            visible && entry.dirty
        } else if visible && receipts.backend.is_some() && receipts.entries.len() < 24 {
            receipts.entries.entry(key).or_insert_with(|| Entry {
                visible: Some(Rc::downgrade(lease)),
                on_screen: true,
                dirty: true,
                ..Entry::default()
            });
            true
        } else {
            false
        }
    }

    fn start(
        &mut self,
        key: &Option<String>,
        more: bool,
        reads: &crate::platform::reads::Reads,
        wake: &rune::Waker,
    ) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let Some(entry) = self
            .entries
            .get_mut(key)
            .filter(|entry| entry.job.is_none())
        else {
            return;
        };
        let cursor = if more {
            let Some(next) = entry.next.clone() else {
                return;
            };
            Some(next)
        } else {
            None
        };
        entry.dirty = false;
        entry.failed = false;
        let (cancel, cancelled) = bounded(1);
        let (out, result) = bounded(1);
        entry.job = Some(Job {
            _cancel: cancel,
            result,
            more,
        });
        let (key, reads, wake) = (key.clone(), reads.clone(), wake.clone());
        crate::platform::spawn(async move {
            let Some(_slot) = reads.background(&cancelled).await else {
                return;
            };
            let Some(result) = crate::platform::reads::cancellable(
                &cancelled,
                backend.permission_receipts(key.as_deref(), cursor.as_deref()),
            )
            .await
            else {
                return;
            };
            if out.send(result.ok()).await.is_ok() {
                wake();
            }
        });
    }

    pub(crate) fn poll(s: &mut State) -> bool {
        let active = s.screen.launcher().is_none()
            && !crate::git::has_preview(s)
            && !crate::files::has_preview(s)
            && matches!(s.phase, crate::Phase::Ready | crate::Phase::Streaming);
        let receipts = &mut s.transcript_display.receipts;
        if !active || receipts.backend.is_none() {
            for entry in receipts.entries.values_mut() {
                entry.dirty |= entry.job.take().is_some();
            }
            return false;
        }
        receipts.entries.entry(None).or_insert_with(|| Entry {
            on_screen: true,
            dirty: true,
            ..Entry::default()
        });
        receipts.entries.retain(|_, entry| {
            entry
                .visible
                .as_ref()
                .is_none_or(|lease| lease.strong_count() != 0)
        });
        let mut changed = false;
        let mut load = Vec::new();
        for (key, entry) in &mut receipts.entries {
            if let Some((more, result)) = entry
                .job
                .as_ref()
                .and_then(|job| job.result.try_recv().ok().map(|result| (job.more, result)))
            {
                entry.job = None;
                if !entry.dirty {
                    if let Some(page) = result {
                        if !more {
                            entry.receipt.clear();
                        }
                        for row in page.receipts {
                            if !entry
                                .receipt
                                .iter()
                                .any(|prior| prior.request_id == row.request_id)
                                && entry.receipt.len() < 128
                            {
                                entry.receipt.push(row);
                            }
                        }
                        entry.next = (entry.receipt.len() < 128).then_some(page.next).flatten();
                    } else {
                        entry.failed = true;
                    }
                    changed = true;
                }
            }
            if entry.on_screen && entry.dirty && entry.job.is_none() {
                load.push(key.clone());
            }
        }
        for key in load {
            receipts.start(&key, false, &s.reads, &s.wake);
        }
        changed
    }
}
