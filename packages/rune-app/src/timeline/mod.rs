//! The visible conversation owns structure and selection; the reader owns bodies.
#[cfg(test)]
mod filter_jump_tests;
mod filters;
mod navigation;
mod preview;
mod reading_line;
pub(crate) mod search;
#[cfg(test)]
pub(crate) mod tests;
mod view;
pub(crate) use navigation::{
    admit, cancel_jump, failed, input_precedes_admission, poll_reveal, restore_search,
};
pub(crate) use preview::{ExcerptCache, window_layout as preview_window_layout};
pub(crate) use preview::{dismiss as dismiss_preview, overlay as preview_overlay};
pub(crate) use reading_line::watch as watch_block;
pub(crate) use view::{notice_key, observe_history_scroll, observe_history_wheel, poll_edge, view};

use crate::{State, backend::Backend, platform, transport::Event};
use codenomad_client::{
    Receiver, Sender, bounded,
    timeline::{
        self, MarkerKind, Outline, OutlineIdentityChanged, OutlineRevision, Resident,
        WindowPosition,
    },
};
use std::{
    cell::Cell,
    collections::{BTreeSet, HashMap},
    rc::Rc,
    sync::Arc,
};

#[derive(Clone, PartialEq, Eq)]
struct Marker {
    id: String,
    message: String,
    kind: MarkerKind,
    ordinal: u64,
    continued: bool,
    omitted_before: bool,
    tool: Option<String>,
}

impl From<timeline::Marker<'_>> for Marker {
    fn from(m: timeline::Marker<'_>) -> Self {
        Self {
            id: format!("{}:{:?}:{}:{}", m.message, m.kind, m.ordinal, m.continued),
            message: m.message.into(),
            kind: m.kind,
            ordinal: m.ordinal,
            continued: m.continued,
            omitted_before: m.omitted_before,
            tool: m.tool_name.map(str::to_owned),
        }
    }
}

enum ScanUpdate {
    Seed(Option<Arc<Outline>>),
    Complete(crate::history::Result<Outline>),
}
type Scan = (Sender<()>, Receiver<ScanUpdate>);

struct RailBounds(rune_theme_codenomad::layout::DrawnRect);

impl Default for RailBounds {
    fn default() -> Self {
        Self(rune_theme_codenomad::layout::DrawnRect::new([0.0; 4]))
    }
}

#[derive(Default)]
pub(crate) struct Timeline {
    backend: Option<Backend>,
    outline: Option<Arc<Outline>>,
    mutation: Option<(Rc<Cell<u64>>, u64)>,
    cold_only: bool,
    scan: Option<Scan>,
    revision: Arc<OutlineRevision>,
    refresh: bool,
    changed: bool,
    index_changed: bool,
    online: bool,
    running: bool,
    visible: bool,
    rail_shown: bool,
    poll_input_waiting: bool,
    keep_passage_deferred: Option<(String, f32)>,
    live: bool,
    width: f32,
    markers: Vec<Marker>,
    folded: HashMap<String, String>,
    filters_changed: bool,
    filter_revision: u64,
    has_raw_markers: bool,
    pending: BTreeSet<crate::agent_api::ToolSource>,
    version: u64,
    outline_error: bool,
    jump: navigation::Navigation,
    scroll: Rc<Cell<view::Scroll>>,
    rail_bounds: RailBounds,
    resident: Vec<(String, Vec<Marker>)>,
    detached: bool,
    pub(crate) paging: Option<(Sender<()>, crate::transport::HistoryEdge)>,
    pub(crate) page_retry: Option<crate::transport::HistoryEdge>,
    reading_line: reading_line::Blocks,
    previews: preview::Previews,
    search: search::Search,
}

impl Timeline {
    pub(crate) fn excerpt_scope(&self) -> Option<u64> {
        self.previews.cache_scope()
    }

    /// Resolves the hovered/focused marker ID to the message ID key used by `ExcerptCache`.
    pub(crate) fn excerpt_target_message(&self) -> Option<&str> {
        let marker_id = self.previews.active_target()?;
        self.markers
            .iter()
            .find(|marker| marker.id == marker_id)
            .map(|marker| marker.message.as_str())
    }

    #[cfg(test)]
    pub(crate) fn fixture_set_excerpt_scope(
        &mut self,
        scope: u64,
        target: Option<(String, String)>,
    ) {
        let marker_id = target.map(|(marker_id, message_id)| {
            self.markers.push(Marker {
                id: marker_id.clone(),
                message: message_id,
                kind: MarkerKind::Assistant,
                ordinal: 0,
                continued: false,
                omitted_before: false,
                tool: None,
            });
            marker_id
        });
        self.previews.fixture_set_scope(scope, marker_id);
    }

    pub(crate) fn outline_ptr(&self) -> Option<usize> {
        self.outline
            .as_ref()
            .map(|outline| Arc::as_ptr(outline) as usize)
    }

    pub(crate) fn outline_retained_bytes(
        &self,
        seen_outlines: &mut std::collections::HashSet<usize>,
    ) -> usize {
        self.outline.as_ref().map_or(0, |outline| {
            if seen_outlines.insert(Arc::as_ptr(outline) as usize) {
                outline_weight(outline)
            } else {
                0
            }
        })
    }

    pub(crate) fn evictable_outline_bytes(&self, active_outline_ptr: Option<usize>) -> usize {
        self.outline.as_ref().map_or(0, |outline| {
            let ptr = Arc::as_ptr(outline) as usize;
            if active_outline_ptr == Some(ptr) {
                0
            } else {
                outline_weight(outline)
            }
        })
    }

    pub(crate) fn evict_inactive_outline(&mut self) {
        if self.outline.is_none() && self.markers.is_empty() && self.resident.is_empty() {
            return;
        }
        self.outline = None;
        self.markers.clear();
        self.folded.clear();
        self.has_raw_markers = false;
        self.resident.clear();
        self.refresh = true;
        self.version = self.version.wrapping_add(1);
        self.changed = true;
    }

    #[cfg(test)]
    pub(crate) fn fixture_set_outline(&mut self, outline: Arc<Outline>) {
        self.outline = Some(outline);
    }

    #[cfg(test)]
    pub(crate) fn has_outline(&self) -> bool {
        self.outline.is_some()
    }
}

#[cfg(test)]
impl Timeline {
    pub(crate) fn is_online(&self) -> bool {
        self.online
    }
}

pub(crate) fn outline_weight(outline: &Outline) -> usize {
    outline.saved_weight().unwrap_or_else(|| {
        outline.entries.iter().fold(0usize, |total, entry| {
            total
                .saturating_add(size_of::<codenomad_client::timeline::Entry>())
                .saturating_add(entry.id.len())
                .saturating_add(entry.layout.as_ref().map_or(0, String::len))
                .saturating_add(entry.tool_name.as_ref().map_or(0, String::len))
        })
    })
}

fn owner(s: &mut State) -> &mut Timeline {
    &mut s.transcript_display.timeline
}

pub(crate) fn structure_changed(s: &mut State) {
    owner(s).changed = true;
}

pub(crate) fn filters_changed(s: &mut State) {
    s.rail_filter_revision = s.rail_filter_revision.wrapping_add(1);
    (s.wake)();
}

fn cancel_scan(t: &mut Timeline) {
    t.revision.invalidate();
    t.scan = None;
}

fn revoke_outline(t: &mut Timeline) {
    t.outline = None;
    t.markers.clear();
    t.folded.clear();
    t.has_raw_markers = false;
    t.version = t.version.wrapping_add(1);
    t.index_changed = true;
    t.changed = true;
}

fn invalidate_outline(s: &mut State) {
    let t = owner(s);
    cancel_scan(t);
    revoke_outline(t);
    t.previews = Default::default();
    t.cold_only = true;
    t.refresh = true;
    t.outline_error = false;
    if let Some((clock, seen)) = &mut t.mutation {
        *seen = clock.get();
    }
    cancel_jump(s);
    search::invalidate(s);
}

pub(crate) fn sync_outline_mutation(s: &mut State) -> bool {
    if owner(s)
        .mutation
        .as_ref()
        .is_some_and(|(clock, seen)| clock.get() != *seen)
    {
        invalidate_outline(s);
        true
    } else {
        false
    }
}

fn drop_uncacheable_outline(t: &mut Timeline) -> bool {
    // A departed view can retain only a cache-sized completed index.
    if t.outline.as_ref().is_some_and(|index| !index.cacheable) {
        t.outline = None;
        t.markers = Vec::new();
        t.folded = HashMap::new();
        t.has_raw_markers = false;
        t.resident = Vec::new();
        t.version = t.version.wrapping_add(1);
        t.changed = true;
        true
    } else {
        false
    }
}

pub(crate) fn suspend(s: &mut State) {
    search::close(s);
    cancel_jump(s);
    navigation::clear_browse(s);
    let t = owner(s);
    t.visible = false;
    t.live = false;
    t.keep_passage_deferred = None;
    t.previews.hide();
    cancel_scan(t);
    t.refresh = true;
    drop_uncacheable_outline(t);
}

pub(crate) fn observe(s: &mut State, event: &Event) {
    if matches!(event, Event::HistoryInvalidated)
        && let Some(backend) = s.transcript_display.timeline.backend.clone()
    {
        crate::workspace::outlines::invalidate(s, &backend);
    }
    let mutation = match event {
        Event::Connected(backend) => s.saved_outlines.mutation(backend),
        _ => None,
    };
    let detached = s.history_detached;
    let t = owner(s);
    match event {
        Event::Connected(backend) => {
            let same = t.backend.as_ref().is_some_and(|old| {
                old.client_id == backend.client_id
                    && old.workspace == backend.workspace
                    && old.session == backend.session
                    && old.session_directory == backend.session_directory
            });
            if !same {
                *t = Timeline::default();
            }
            if t.mutation.is_none() {
                t.mutation = mutation.map(|clock| {
                    let seen = clock.get();
                    (clock, seen)
                });
            }
            t.backend = Some(backend.clone());
            t.refresh = true;
        }
        Event::HistoryInvalidated => invalidate_outline(s),
        Event::ConnectionLost
        | Event::Reconnecting
        | Event::AuthenticationRequired(_)
        | Event::WorkspaceMissing => {
            cancel_scan(t);
            t.previews = Default::default();
            t.online = false;
            t.refresh = true;
            cancel_jump(s);
            search::invalidate(s);
        }
        Event::AgentHint(true) if detached => {
            t.refresh |= !t.online;
            t.online = true;
        }
        Event::ReaderSync { .. } | Event::Sync(_) => {
            t.refresh |= !t.online;
            t.online = true;
            t.changed = true;
        }
        Event::Older(_) | Event::Message(_) | Event::History(_) => t.changed = true,
        Event::Text(_, event) if event.is_end() => t.changed = true,
        Event::ObservedRunning { running, .. } => {
            t.refresh |= t.running && !running;
            t.running = *running;
        }
        Event::Done => t.refresh = true,
        _ => {}
    }
}

fn project_root(s: &State) -> Option<&str> {
    Some(s.screen.launcher()?.project.as_ref()?.path.as_str())
}

pub(super) fn conversation_shown(s: &State) -> bool {
    !s.screen.is_launcher()
        && !crate::files::has_preview(s)
        && !crate::git::has_preview(s)
        && !crate::workspace::mission_has_reader(s)
}

pub(crate) fn demanded(s: &State) -> bool {
    let t = &s.transcript_display.timeline;
    conversation_shown(s)
        && crate::settings::show_timeline(s)
        && rune_theme_codenomad::timeline::fits(t.width)
}

pub(crate) fn rail_layout_pending(s: &State, history_w: f32) -> bool {
    if !history_w.is_finite() || history_w <= 0.0 || !conversation_shown(s) {
        return false;
    }
    let t = &s.transcript_display.timeline;
    let enabled = crate::settings::show_timeline(s);
    let container_w = if t.width.is_finite() && t.width > 0.0 {
        t.width
    } else {
        history_w
    };
    let rail_should_mount = enabled
        && rune_theme_codenomad::timeline::fits(container_w)
        && (t.has_raw_markers || !t.markers.is_empty());
    if enabled
        && rune_theme_codenomad::timeline::fits(history_w)
        && (!rune_theme_codenomad::timeline::fits(t.width)
            || ((!t.visible || t.changed) && !s.messages.is_empty()))
    {
        return true;
    }
    if rail_should_mount && history_w >= container_w - 1.0 {
        return true;
    }
    !rail_should_mount && t.width.is_finite() && t.width > 0.0 && history_w < t.width - 1.0
}

fn reproject(s: &mut State) -> bool {
    let t = &s.transcript_display.timeline;
    let blocks: Vec<_> = s
        .messages
        .iter()
        .map(|r| {
            crate::chat::anchors::blocks(r, crate::chat::anchors::steps(s, &r.id), false)
                .into_iter()
                .map(|b| b.marker)
                .collect::<Vec<_>>()
        })
        .collect();
    let owned: Vec<_> = s
        .messages
        .iter()
        .zip(&blocks)
        .map(|(row, markers)| {
            (
                row.id.clone(),
                markers.iter().copied().map(Marker::from).collect(),
            )
        })
        .collect();
    let rows: Vec<_> = s
        .messages
        .iter()
        .zip(&blocks)
        .map(|(row, markers)| Resident {
            message: &row.id,
            markers,
        })
        .collect();
    if !t.index_changed
        && !t.filters_changed
        && owned == t.resident
        && t.detached == s.history_detached
    {
        return false;
    }
    let index = t
        .outline
        .as_ref()
        .map_or(&[][..], |outline| outline.entries.as_slice());
    let position = if s.history_detached {
        WindowPosition::Historical
    } else {
        WindowPosition::Latest
    };
    let projected = timeline::project(index, &rows, position).map(|markers| {
        let has_raw = !markers.is_empty();
        let (markers, folded) = filters::project(s, markers);
        (has_raw, markers, folded)
    });
    let detached = s.history_detached;
    let t = owner(s);
    let new_index = std::mem::take(&mut t.index_changed);
    t.filters_changed = false;
    t.detached = detached;
    t.resident = owned;
    match projected {
        Ok((has_raw, markers, folded))
            if has_raw != t.has_raw_markers || markers != t.markers || folded != t.folded =>
        {
            t.has_raw_markers = has_raw;
            t.markers = markers;
            t.folded = folded;
            t.version = t.version.wrapping_add(1);
            filters::reselect(s);
            true
        }
        Err(e) if e.is::<timeline::UnplacedWindow>() => {
            let changed = !t.outline_error;
            t.outline_error = true;
            t.refresh |= !new_index;
            changed
        }
        _ => false,
    }
}

pub(super) fn defer_keep_passage(s: &mut State, tx: &mut rune::Tx) {
    if s.reader
        .as_ref()
        .is_some_and(crate::chat::reader::Reader::defers_scroll)
    {
        return;
    }
    if owner(s).keep_passage_deferred.is_none()
        && let Some(target) = crate::chat::reading::passage_target(s)
    {
        owner(s).keep_passage_deferred = Some(target);
    }
    if owner(s).keep_passage_deferred.is_some() {
        tx.wake_after(std::time::Duration::ZERO);
    }
}

fn flush_deferred_keep_passage(s: &mut State, tx: &mut rune::Tx, input_waiting: bool) -> bool {
    let on_conversation = conversation_shown(s);
    let deferring = s
        .reader
        .as_ref()
        .is_some_and(crate::chat::reader::Reader::defers_scroll);
    let t = owner(s);
    if t.keep_passage_deferred.is_none() {
        return false;
    }
    let scroll = t.scroll.get();
    let scrolled =
        scroll.transcript != t.jump.last.transcript || scroll.wheel_last_rail == Some(false);
    if deferring || scrolled || !on_conversation || t.jump.align.is_some() {
        t.keep_passage_deferred = None;
        return false;
    }
    if input_waiting {
        tx.wake_after(std::time::Duration::ZERO);
        return false;
    }
    if let Some((key, offset)) = t.keep_passage_deferred.take() {
        s.transcript_display
            .reading_mut()
            .note_programmatic_scroll();
        tx.scroll_key_to(key, offset);
        true
    } else {
        false
    }
}

pub(crate) fn poll(s: &mut State, tx: &mut rune::Tx) -> bool {
    let input_waiting = tx.input_waiting();
    owner(s).poll_input_waiting = input_waiting;
    let mut changed = sync_outline_mutation(s) | flush_deferred_keep_passage(s, tx, input_waiting);
    if !demanded(s) {
        let on_conversation = conversation_shown(s);
        owner(s).previews.hide();
        let was_visible = std::mem::take(&mut owner(s).visible);
        let was_shown = std::mem::take(&mut owner(s).rail_shown);
        if was_visible {
            navigation::clear_browse(s);
        }
        if !on_conversation {
            if std::mem::take(&mut owner(s).live)
                || was_visible
                || search::is_open(s)
                || navigation::has_pending_or_locked(s)
            {
                suspend(s);
                changed = true;
            }
            return changed | navigation::apply_alignment(s, tx);
        }
        if was_shown && owner(s).jump.align.is_none() {
            if input_waiting {
                defer_keep_passage(s, tx);
            } else {
                crate::chat::reading::keep_passage(s, tx);
            }
        }
        if std::mem::take(&mut owner(s).live) || was_visible {
            cancel_scan(owner(s));
            owner(s).refresh = true;
            drop_uncacheable_outline(owner(s));
            changed = true;
        }
        changed |= navigation::cancel_rail_jump(s, !crate::settings::show_timeline(s));
        return changed | navigation::poll(s, tx);
    }
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let pending = filters::pending(s);
    let filter_revision = s.rail_filter_revision;
    let project = project_root(s).map(str::to_owned);
    let t = owner(s);
    if t.pending != pending || t.filter_revision != filter_revision {
        t.pending = pending;
        t.filter_revision = filter_revision;
        t.filters_changed = true;
        t.changed = true;
    }
    t.visible = true;
    t.live = true;
    let mut remember = None;
    while let Some(update) = t.scan.as_ref().and_then(|(_, in_)| in_.try_recv().ok()) {
        changed = true;
        match update {
            ScanUpdate::Seed(Some(seed)) if t.outline.is_none() => {
                t.outline = Some(seed);
                t.changed = true;
                t.index_changed = true;
            }
            ScanUpdate::Seed(None) => revoke_outline(t),
            ScanUpdate::Seed(Some(_)) => {}
            ScanUpdate::Complete(result) => {
                t.scan = None;
                t.outline_error = result.is_err();
                match result {
                    Ok(index) => {
                        let index = Arc::new(index);
                        remember = Some(index.clone());
                        t.outline = Some(index);
                        t.cold_only = false;
                    }
                    Err(error) if error.is::<OutlineIdentityChanged>() => revoke_outline(t),
                    Err(_) => continue,
                }
                t.changed = true;
                t.index_changed = true;
            }
        }
    }
    if let Some(index) = remember {
        crate::workspace::outlines::remember(s, index);
    }
    let t = owner(s);
    if t.online
        && t.refresh
        && t.scan.is_none()
        && let Some(backend) = t.backend.clone()
    {
        t.refresh = false;
        let revision = t.revision.clone();
        let (cancel, cancelled) = bounded(1);
        let prior = t.outline.clone();
        let (out, in_) = bounded(2);
        t.scan = Some((cancel, in_));
        let seed = (!t.cold_only)
            .then_some(project.as_deref())
            .flatten()
            .and_then(|root| {
                prior
                    .filter(|o| o.saved_for(&backend, root))
                    .or_else(|| crate::workspace::outlines::seed(s, &backend, root))
            });
        platform::spawn(async move {
            let Some(_permit) = reads.background(&cancelled).await else {
                return;
            };
            let read = backend.read_outline_cached(&revision, project.as_deref(), seed, |index| {
                if out.try_send(ScanUpdate::Seed(index)).is_ok() {
                    wake();
                }
            });
            if let Some(result) = platform::reads::cancellable(&cancelled, read).await
                && out.send(ScanUpdate::Complete(result)).await.is_ok()
            {
                wake();
            }
        });
    }
    let t = owner(s);
    if std::mem::take(&mut t.changed) {
        changed |= reproject(s);
    }
    let shown = owner(s).has_raw_markers || !owner(s).markers.is_empty();
    let was_shown = std::mem::replace(&mut owner(s).rail_shown, shown);
    if shown != was_shown {
        changed = true;
        if owner(s).jump.align.is_none() {
            if input_waiting {
                defer_keep_passage(s, tx);
            } else {
                crate::chat::reading::keep_passage(s, tx);
            }
        }
    }
    changed | navigation::poll(s, tx) | preview::poll(s, tx)
}
