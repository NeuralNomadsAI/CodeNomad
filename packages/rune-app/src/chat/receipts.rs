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

const MAX_PAGES: usize = 8;

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
    suspended: bool,
    job: Option<Job>,
    dirty: bool,
    failed: bool,
    pages: usize,
    retry_more: bool,
}

struct Job {
    _cancel: Sender<()>,
    result: Receiver<Option<(ReceiptPage, usize)>>,
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

    pub(super) fn suspend(&mut self) {
        for (message, entry) in &mut self.entries {
            entry.on_screen = message.is_none();
            entry.suspended = message.is_some();
            entry.dirty |= entry.job.take().is_some();
        }
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
            entry.visible = Some(Rc::downgrade(lease));
            entry.suspended = false;
            if !visible {
                entry.dirty |= entry.job.take().is_some();
            }
            visible && entry.dirty
        } else if visible && receipts.backend.is_some() {
            if receipts.entries.len() >= 24
                && let Some(victim) = receipts.entries.iter().find_map(|(key, entry)| {
                    (key.is_some() && !entry.on_screen && entry.suspended).then(|| key.clone())
                })
            {
                receipts.entries.remove(&victim);
            }
            if receipts.entries.len() >= 24 {
                return false;
            }
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
            if entry.dirty || entry.pages >= MAX_PAGES {
                return;
            }
            let Some(next) = entry.next.clone() else {
                return;
            };
            Some(next)
        } else {
            None
        };
        let pages = if more { 1 } else { entry.pages.max(1) };
        entry.dirty = false;
        entry.failed = false;
        entry.retry_more = more;
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
                read_pages(&backend, key.as_deref(), cursor, pages),
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

    pub(crate) fn poll(s: &mut State, visible: bool) -> bool {
        let active = visible
            && s.screen.launcher().is_none()
            && !crate::git::has_preview(s)
            && !crate::files::has_preview(s)
            && matches!(s.phase, crate::Phase::Ready | crate::Phase::Streaming);
        let receipts = &mut s.transcript_display.receipts;
        if !visible {
            receipts.suspend();
            return false;
        }
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
            entry.suspended
                || entry
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
                    if let Some((page, pages)) = result {
                        if !more {
                            entry.receipt.clear();
                        }
                        entry.pages = if more { entry.pages + pages } else { pages };
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
                        entry.next = (entry.pages < MAX_PAGES).then_some(page.next).flatten();
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

async fn read_pages(
    backend: &Backend,
    message: Option<&str>,
    mut cursor: Option<String>,
    pages: usize,
) -> crate::history::Result<(ReceiptPage, usize)> {
    let mut receipts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(cursor) = &cursor {
        seen.insert(cursor.clone());
    }
    for fetched in 1..=pages {
        let page = backend
            .permission_receipts(message, cursor.as_deref())
            .await?;
        receipts.extend(page.receipts);
        cursor = page.next;
        if let Some(next) = &cursor
            && !seen.insert(next.clone())
        {
            return Err("permission receipt cursor repeated".into());
        }
        if cursor.is_none() || fetched == pages {
            return Ok((
                ReceiptPage {
                    receipts,
                    next: cursor,
                },
                fetched,
            ));
        }
    }
    Err("no permission receipt pages requested".into())
}
