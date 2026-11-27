use super::draft::{Attachment, MAX_FILE, MAX_FILES, MAX_PARTS, MAX_TOTAL};
use crate::{Phase, State, platform, strings::t};
use codenomad_client::{Receiver, bounded};
use std::{collections::VecDeque, sync::Arc};

#[derive(Clone, Copy, Debug)]
pub enum Error {
    TooLarge,
    Limit,
    Unreadable,
}

pub struct Offer {
    pub name: String,
    pub mime: String,
    pub source: platform::device_picker::Source,
}

type Read = Receiver<(Offer, Result<Arc<[u8]>, Error>)>;

#[derive(Default)]
pub struct Device {
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) clipboard: Option<super::clipboard::Read>,
    queued: VecDeque<Offer>,
    read: Option<Read>,
    pub(crate) choosing: bool,
    pub(crate) generation: u64,
    #[cfg(target_arch = "wasm32")]
    pub(crate) browser: Option<platform::device_picker::Choice>,
    pub notice: Option<String>,
}

impl Device {
    pub fn busy(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        if self.clipboard.is_some() {
            return true;
        }
        self.file_work()
    }

    fn file_work(&self) -> bool {
        self.choosing || self.read.is_some() || !self.queued.is_empty()
    }

    pub fn cancel(&mut self) {
        *self = Self {
            generation: self.generation.wrapping_add(1),
            ..Self::default()
        };
    }
}

pub fn available(s: &State) -> bool {
    !s.screen.is_launcher()
        && s.composer.recall.is_none()
        && !s.composer.editing_locked()
        && s.composer.picker.attachments_supported()
        && matches!(
            s.phase,
            Phase::Ready | Phase::Streaming | Phase::StreamDisconnected { .. }
        )
}

pub fn enqueue(s: &mut State, offers: impl IntoIterator<Item = Offer>) {
    if !available(s) {
        return;
    }
    let queue = &mut s.composer.device;
    if !queue.busy() {
        queue.notice = None;
    }
    for offer in offers {
        if queue.queued.len() >= MAX_FILES {
            queue.notice = Some(notice(&offer.name, Error::Limit));
            break;
        }
        queue.queued.push_back(offer);
    }
}

pub fn poll(s: &mut State, tx: &mut rune::Tx) -> bool {
    if !available(s) {
        if s.composer.device.file_work() {
            s.composer.device.cancel();
            return true;
        }
        return false;
    }
    let mut changed = false;
    #[cfg(target_arch = "wasm32")]
    if let Some(offers) = s
        .composer
        .device
        .browser
        .as_ref()
        .and_then(|choice| choice.result.try_recv().ok())
    {
        s.composer.device.browser = None;
        s.composer.device.choosing = false;
        enqueue(s, offers);
        changed = true;
    }
    if let Some(read) = &s.composer.device.read {
        let Ok((offer, result)) = read.try_recv() else {
            return changed;
        };
        s.composer.device.read = None;
        let error = match result {
            Ok(bytes) => {
                let draft = &mut s.composer.draft;
                if !draft.attach_for(
                    &s.draft,
                    Attachment::Device {
                        name: offer.name.clone(),
                        mime: offer.mime,
                        bytes,
                        token: None,
                    },
                ) {
                    Some(Error::Limit)
                } else if crate::workspace::attachment_draft_admissible(s) {
                    crate::workspace::draft_changed(s, tx);
                    None
                } else {
                    s.composer.draft.attachments.pop();
                    Some(Error::Limit)
                }
            }
            Err(error) => Some(error),
        };
        if let Some(error) = error {
            s.composer.device.notice = Some(notice(&offer.name, error));
        }
        changed = true;
    }
    if let Some(offer) = s.composer.device.queued.pop_front() {
        let (count, total) = s.composer.draft.inline_usage();
        if count >= MAX_FILES
            || s.composer.draft.active_count(&s.draft) >= MAX_PARTS
            || total >= MAX_TOTAL
        {
            s.composer.device.notice = Some(notice(&offer.name, Error::Limit));
            s.composer.device.queued.clear();
            return true;
        }
        let limit = (MAX_TOTAL - total).min(MAX_FILE);
        let (out, input) = bounded(1);
        s.composer.device.read = Some(input);
        let wake = s.wake.clone();
        platform::spawn(async move {
            let bytes = platform::device_picker::read(&offer.source, limit).await;
            if out.send((offer, bytes)).await.is_ok() {
                wake();
            }
        });
        return true;
    }
    changed
}

pub fn notice(name: &str, error: Error) -> String {
    t(match error {
        Error::TooLarge => "promptInput.attachFiles.rejected.tooLarge",
        Error::Limit => "promptInput.attachFiles.rejected.limit",
        Error::Unreadable => "promptInput.attachFiles.rejected.unreadable",
    })
    .replace("{name}", name)
}
