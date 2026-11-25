use crate::platform::{
    self,
    reads::{self, Reads},
};
use codenomad_client::{
    Receiver, Sender, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{
        BodyDescriptor, ContentOutcome, ContentRefusal, ContentSelector, ContentSlice,
        READER_PAGE_SIZE, body_covers, body_need, utf16_len,
    },
};
use std::collections::{HashMap, HashSet};

pub(super) const MAX_BODY_CACHE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_WHOLE_BODY_UNITS: u64 = (MAX_BODY_CACHE_BYTES / 2) as u64;
const MAX_RETAINED_BODIES: usize = 128;
const MAX_RESTARTS: u8 = 4;

pub(crate) type BodyKey = (String, String, ContentSelector);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BodyStatus {
    Loading,
    Ready,
    Missing,
    Error,
}

#[derive(Clone, Debug)]
pub(crate) struct LoadedBody {
    pub digest: String,
    pub revision: u64,
    pub characters: u64,
    pub json: bool,
    pub text: String,
    pub utf16_len: u64,
}

#[derive(Clone, Copy)]
pub(crate) struct BodyView<'a> {
    pub status: BodyStatus,
    pub body: Option<&'a LoadedBody>,
}

struct BodyFlight {
    epoch: u64,
    offset: u64,
    digest: Option<String>,
    cancel: Sender<()>,
    inbox: Receiver<Result<ContentOutcome>>,
}

struct BodyEntry {
    status: BodyStatus,
    display: Option<LoadedBody>,
    pending: Option<LoadedBody>,
    expected: Option<(u64, String)>,
    need: u64,
    epoch: u64,
    stale: bool,
    parked: bool,
    restarts: u8,
    flight: Option<BodyFlight>,
    last_used: u64,
}

impl Default for BodyEntry {
    fn default() -> Self {
        Self {
            status: BodyStatus::Loading,
            display: None,
            pending: None,
            expected: None,
            need: 0,
            epoch: 0,
            stale: false,
            parked: false,
            restarts: 0,
            flight: None,
            last_used: 0,
        }
    }
}

impl BodyEntry {
    fn cancel(&mut self) {
        if let Some(flight) = self.flight.take() {
            flight.cancel.close();
        }
    }

    fn utf16_bytes(&self) -> usize {
        let a = self.display.as_ref().map_or(0, |b| b.utf16_len as usize);
        let b = self.pending.as_ref().map_or(0, |b| b.utf16_len as usize);
        (a + b).saturating_mul(2)
    }

    fn covers(&self, body: &LoadedBody) -> bool {
        body.utf16_len >= body.characters || body.utf16_len >= self.need
    }

    fn fresh(&self) -> bool {
        if self.stale {
            return false;
        }
        let Some((exp_rev, exp_digest)) = &self.expected else {
            return true;
        };
        self.display
            .as_ref()
            .is_some_and(|b| &b.digest == exp_digest && b.revision >= *exp_rev)
    }

    fn promote(&mut self) {
        let should_promote = self.pending.as_ref().is_some_and(|pending| {
            let need_met = self.covers(pending);
            let digest_ok = self
                .expected
                .as_ref()
                .is_none_or(|(_, d)| d == &pending.digest);
            need_met && digest_ok
        });
        if should_promote {
            self.display = self.pending.take();
            self.stale = false;
        }
    }

    fn next_query(&self) -> Option<(u64, Option<String>)> {
        if self.flight.is_some() || self.parked || self.need == 0 {
            return None;
        }
        if let Some(pending) = &self.pending {
            if !self.covers(pending) && pending.utf16_len < pending.characters {
                return Some((pending.utf16_len, Some(pending.digest.clone())));
            }
            return None;
        }
        if !self.fresh() {
            return Some((0, None));
        }
        match &self.display {
            None => Some((0, None)),
            Some(display) if !self.covers(display) && display.utf16_len < display.characters => {
                Some((display.utf16_len, Some(display.digest.clone())))
            }
            Some(_) => None,
        }
    }
}

#[derive(Default)]
pub(super) struct BodyCache {
    entries: HashMap<BodyKey, BodyEntry>,
    use_clock: u64,
    auth_expired: Option<Backend>,
}

impl BodyCache {
    pub(super) fn suspend(&mut self) {
        self.cancel_all_flights();
    }

    pub(super) fn invalidate_all(&mut self) {
        for entry in self.entries.values_mut() {
            entry.cancel();
            entry.epoch = entry.epoch.wrapping_add(1);
            entry.stale = true;
            entry.parked = false;
            entry.restarts = 0;
            entry.pending = None;
        }
    }

    pub(super) fn retry(&mut self, key: &BodyKey) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.cancel();
            entry.epoch = entry.epoch.wrapping_add(1);
            entry.parked = false;
            entry.restarts = 0;
            entry.pending = None;
            entry.status = if entry.display.is_some() {
                BodyStatus::Ready
            } else {
                BodyStatus::Loading
            };
        }
    }

    pub(super) fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
    }

    pub(super) fn body_view(&self, key: &BodyKey) -> BodyView<'_> {
        self.entries.get(key).map_or(
            BodyView {
                status: BodyStatus::Loading,
                body: None,
            },
            |entry| BodyView {
                status: entry.status,
                body: entry.display.as_ref(),
            },
        )
    }

    pub(super) fn complete_text(&self, key: &BodyKey) -> Option<&str> {
        let entry = self.entries.get(key)?;
        if !entry.fresh() {
            return None;
        }
        let body = entry.display.as_ref()?;
        (body.utf16_len >= body.characters.min(MAX_WHOLE_BODY_UNITS)).then_some(body.text.as_str())
    }

    pub(super) fn need_for_paged(&self, key: &BodyKey, desc: &BodyDescriptor, page: usize) -> u64 {
        let existing = self.entries.get(key).and_then(|entry| {
            entry
                .pending
                .as_ref()
                .filter(|b| b.digest == desc.digest)
                .or_else(|| entry.display.as_ref().filter(|b| b.digest == desc.digest))
        });
        match existing {
            Some(body) => {
                let covers = body_covers(&body.text, body.characters, page, READER_PAGE_SIZE);
                body_need(
                    Some(body.utf16_len),
                    body.characters,
                    covers,
                    page,
                    READER_PAGE_SIZE,
                )
            }
            None => body_need(None, desc.characters, false, page, READER_PAGE_SIZE),
        }
    }

    pub(super) fn poll_flights(&mut self, backend: &Backend) -> bool {
        let mut changed = false;
        let mut completed = Vec::new();
        for (key, entry) in &self.entries {
            if let Some(flight) = &entry.flight
                && let Ok(outcome) = flight.inbox.try_recv()
            {
                completed.push((
                    key.clone(),
                    flight.epoch,
                    flight.offset,
                    flight.digest.clone(),
                    outcome,
                ));
            }
        }
        for (key, epoch, offset, expected_digest, outcome) in completed {
            let Some(entry) = self.entries.get_mut(&key) else {
                continue;
            };
            let is_current = entry.flight.as_ref().is_some_and(|f| {
                f.epoch == epoch && f.offset == offset && f.digest == expected_digest
            });
            if !is_current {
                continue;
            }
            entry.flight = None;
            if entry.epoch != epoch {
                continue;
            }
            changed = true;
            match outcome {
                Ok(ContentOutcome::AuthExpired) => {
                    entry.status = BodyStatus::Error;
                    entry.parked = true;
                    entry.pending = None;
                    self.auth_expired = Some(backend.clone());
                }
                Ok(ContentOutcome::Refused { refusal, .. }) => match refusal {
                    ContentRefusal::ContentChanged => {
                        entry.pending = None;
                        if entry.restarts < MAX_RESTARTS {
                            entry.restarts += 1;
                            entry.stale = true;
                        } else {
                            entry.status = BodyStatus::Error;
                            entry.parked = true;
                        }
                    }
                    ContentRefusal::MissionNotFound | ContentRefusal::ContentNotFound => {
                        entry.display = None;
                        entry.pending = None;
                        entry.status = BodyStatus::Missing;
                        entry.parked = true;
                    }
                },
                Ok(ContentOutcome::Slice { revision, slice }) => {
                    accept_slice(entry, offset, revision, slice);
                }
                Err(_) => {
                    entry.status = BodyStatus::Error;
                    entry.parked = true;
                    entry.pending = None;
                }
            }
        }
        changed
    }

    pub(super) fn drive(
        &mut self,
        backend: &Backend,
        revision: u64,
        demands: Vec<(BodyKey, BodyDescriptor, u64)>,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let mut changed = false;
        let active_keys: HashSet<BodyKey> = demands.iter().map(|(k, _, _)| k.clone()).collect();
        for (key, entry) in &mut self.entries {
            if !active_keys.contains(key) {
                entry.cancel();
            }
        }

        for (key, descriptor, need) in demands {
            self.use_clock = self.use_clock.wrapping_add(1);
            let now = self.use_clock;
            let entry = self.entries.entry(key.clone()).or_default();
            entry.last_used = now;

            if descriptor.characters == 0 {
                entry.cancel();
                let empty = LoadedBody {
                    digest: descriptor.digest.clone(),
                    revision,
                    characters: 0,
                    json: false,
                    text: String::new(),
                    utf16_len: 0,
                };
                if entry.status != BodyStatus::Ready
                    || entry
                        .display
                        .as_ref()
                        .is_none_or(|b| b.digest != empty.digest)
                {
                    changed = true;
                }
                entry.expected = Some((revision, descriptor.digest));
                entry.display = Some(empty);
                entry.pending = None;
                entry.status = BodyStatus::Ready;
                entry.stale = false;
                entry.parked = false;
                entry.restarts = 0;
                continue;
            }

            let new_expected = Some((revision, descriptor.digest.clone()));
            let digest_changed = entry
                .expected
                .as_ref()
                .is_some_and(|(_, old)| old != &descriptor.digest);
            if entry
                .expected
                .as_ref()
                .is_none_or(|(old_rev, old_d)| revision > *old_rev || old_d != &descriptor.digest)
            {
                entry.expected = new_expected;
                if digest_changed {
                    entry.parked = false;
                    entry.restarts = 0;
                    if entry
                        .pending
                        .as_ref()
                        .is_some_and(|p| p.digest != descriptor.digest)
                    {
                        entry.pending = None;
                    }
                    if entry
                        .flight
                        .as_ref()
                        .is_some_and(|f| f.digest.as_deref() != Some(descriptor.digest.as_str()))
                    {
                        entry.cancel();
                    }
                }
            }

            let capped = need.min(MAX_WHOLE_BODY_UNITS);
            if capped > entry.need {
                entry.need = capped;
                entry.parked = false;
            } else {
                entry.need = capped;
            }
            entry.promote();

            if let Some((offset, digest)) = entry.next_query() {
                if entry.status == BodyStatus::Error {
                    entry.status = if entry.display.is_some() {
                        BodyStatus::Ready
                    } else {
                        BodyStatus::Loading
                    };
                }
                let epoch = entry.epoch;
                let (cancel_tx, cancelled) = bounded(1);
                let (out, inbox) = bounded(1);
                entry.flight = Some(BodyFlight {
                    epoch,
                    offset,
                    digest: digest.clone(),
                    cancel: cancel_tx,
                    inbox,
                });
                let backend = backend.clone();
                let reads = reads.clone();
                let wake = wake.clone();
                let (project, mission, selector) = key;
                platform::spawn(async move {
                    let Some(permit) = reads.preview(&cancelled).await else {
                        return;
                    };
                    let outcome = reads::cancellable(
                        &cancelled,
                        backend.mission_content(
                            &project,
                            &mission,
                            &selector,
                            offset,
                            digest.as_deref(),
                        ),
                    )
                    .await;
                    drop(permit);
                    if let Some(outcome) = outcome
                        && out.send(outcome).await.is_ok()
                    {
                        wake();
                    }
                });
                changed = true;
            }
        }

        self.evict_unused(&active_keys);
        changed
    }

    pub(super) fn cancel_all_flights(&mut self) {
        for entry in self.entries.values_mut() {
            entry.cancel();
        }
    }

    pub(super) fn evict_unused(&mut self, active: &HashSet<BodyKey>) {
        let mut total_bytes: usize = self.entries.values().map(BodyEntry::utf16_bytes).sum();
        while self.entries.len() > MAX_RETAINED_BODIES || total_bytes > MAX_BODY_CACHE_BYTES {
            let victim = self
                .entries
                .iter()
                .filter(|(k, e)| !active.contains(*k) && e.flight.is_none())
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone());
            let Some(victim) = victim else {
                break;
            };
            if let Some(removed) = self.entries.remove(&victim) {
                total_bytes = total_bytes.saturating_sub(removed.utf16_bytes());
            }
        }
    }
}

fn accept_slice(entry: &mut BodyEntry, offset: u64, revision: u64, slice: ContentSlice) {
    let slice_units = utf16_len(&slice.text) as u64;
    if offset == 0 {
        if let Some((exp_rev, exp_digest)) = &entry.expected
            && revision < *exp_rev
            && &slice.digest != exp_digest
        {
            entry.pending = None;
            if entry.restarts < MAX_RESTARTS {
                entry.restarts += 1;
                entry.stale = true;
            } else {
                entry.status = BodyStatus::Error;
                entry.parked = true;
            }
            return;
        }
        let body = LoadedBody {
            digest: slice.digest,
            revision,
            characters: slice.characters,
            json: slice.json,
            text: slice.text,
            utf16_len: slice_units,
        };
        if let Some(display) = &mut entry.display
            && display.digest == body.digest
        {
            display.revision = display.revision.max(revision);
            if body.utf16_len > display.utf16_len {
                display.text = body.text;
                display.utf16_len = body.utf16_len;
            }
            entry.pending = None;
            entry.stale = false;
        } else {
            entry.pending = Some(body);
        }
    } else if let Some(pending) = &mut entry.pending
        && pending.digest == slice.digest
        && pending.utf16_len == offset
    {
        if pending.json != slice.json {
            entry.pending = None;
            entry.status = BodyStatus::Error;
            entry.parked = true;
            return;
        }
        pending.revision = pending.revision.max(revision);
        pending.text.push_str(&slice.text);
        pending.utf16_len += slice_units;
    } else if let Some(display) = &mut entry.display
        && display.digest == slice.digest
        && display.utf16_len == offset
    {
        if display.json != slice.json {
            entry.status = BodyStatus::Error;
            entry.parked = true;
            return;
        }
        display.revision = display.revision.max(revision);
        display.text.push_str(&slice.text);
        display.utf16_len += slice_units;
    } else {
        return;
    }

    entry.promote();
    entry.status = if entry.display.is_some() {
        BodyStatus::Ready
    } else {
        BodyStatus::Loading
    };
    if entry.pending.is_none()
        && entry.display.as_ref().is_some_and(|b| entry.covers(b))
        && entry.fresh()
    {
        entry.restarts = 0;
    }
}
