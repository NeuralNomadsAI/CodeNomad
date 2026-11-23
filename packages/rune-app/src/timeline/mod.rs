//! The visible conversation owns structure and selection; the reader owns bodies.
#[cfg(test)]
mod filter_jump_tests;
mod filters;
mod navigation;
mod preview;
mod reading_line;
pub(crate) mod search;
#[cfg(test)]
mod tests;
mod view;
pub(crate) use navigation::{admit, cancel_jump, failed, input_precedes_admission, restore_search};
pub(crate) use preview::{ExcerptCache, window_layout as preview_window_layout};
pub(crate) use preview::{dismiss as dismiss_preview, overlay as preview_overlay};
pub(crate) use reading_line::watch as watch_block;
pub(crate) use view::poll_edge;
pub(crate) use view::{view, watch};

use crate::{State, backend::Backend, platform, transport::Event};
use codenomad_client::{
    Receiver, Sender, bounded,
    timeline::{self, MarkerKind, Outline, OutlineRevision, Resident, WindowPosition},
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
    Seed(Arc<Outline>),
    Complete(crate::history::Result<Outline>),
}
type Scan = (Sender<()>, Receiver<ScanUpdate>);

#[derive(Default)]
pub(crate) struct Timeline {
    backend: Option<Backend>,
    outline: Option<Arc<Outline>>,
    provisional: bool,
    cold_only: bool,
    scan: Option<Scan>,
    revision: Arc<OutlineRevision>,
    refresh: bool,
    changed: bool,
    index_changed: bool,
    online: bool,
    running: bool,
    visible: bool,
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
    resident: Vec<(String, Vec<Marker>)>,
    detached: bool,
    pub(crate) paging: Option<(Sender<()>, crate::transport::HistoryEdge)>,
    pub(crate) page_retry: Option<crate::transport::HistoryEdge>,
    reading_line: reading_line::Blocks,
    previews: preview::Previews,
    search: search::Search,
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
    if std::mem::take(&mut t.provisional) {
        t.outline = None;
        t.changed = true;
        t.index_changed = true;
    }
}

pub(crate) fn suspend(s: &mut State) {
    search::close(s);
    cancel_jump(s);
    let t = owner(s);
    t.visible = false;
    t.previews.hide();
    cancel_scan(t);
    t.refresh = true;
    // A departed view can retain only a cache-sized completed index.
    if t.outline.as_ref().is_some_and(|index| !index.cacheable) {
        t.outline = None;
        t.markers.clear();
        t.has_raw_markers = false;
        t.resident.clear();
        t.changed = true;
    }
}

pub(crate) fn observe(s: &mut State, event: &Event) {
    if matches!(event, Event::HistoryInvalidated)
        && let Some(backend) = s.transcript_display.timeline.backend.clone()
        && let Some(project) = project_root(s).map(str::to_owned)
    {
        crate::workspace::outlines::invalidate(s, &backend, &project);
    }
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
            t.backend = Some(backend.clone());
            t.refresh = true;
        }
        Event::HistoryInvalidated => {
            cancel_scan(t);
            t.previews = Default::default();
            t.outline = None;
            t.provisional = false;
            t.cold_only = true;
            t.markers.clear();
            t.has_raw_markers = false;
            t.version = t.version.wrapping_add(1);
            t.resident.clear();
            t.refresh = true;
            t.changed = true;
            cancel_jump(s);
            search::invalidate(s);
        }
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

pub(crate) fn demanded(s: &State) -> bool {
    let t = &s.transcript_display.timeline;
    !s.screen.is_launcher()
        && !crate::files::has_preview(s)
        && !crate::git::has_preview(s)
        && crate::settings::show_timeline(s)
        && rune_theme_codenomad::timeline::fits(t.width)
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

pub(crate) fn poll(s: &mut State, tx: &mut rune::Tx) -> bool {
    if !demanded(s) {
        owner(s).previews.hide();
        if std::mem::take(&mut owner(s).visible) {
            if search::is_open(s) {
                cancel_scan(owner(s));
                owner(s).refresh = true;
            } else {
                suspend(s);
            }
        }
        return if search::is_open(s) {
            navigation::poll(s, tx)
        } else {
            navigation::apply_alignment(s, tx)
        };
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
    let mut changed = false;
    let mut remember = None;
    while let Some(update) = t.scan.as_ref().and_then(|(_, in_)| in_.try_recv().ok()) {
        changed = true;
        match update {
            ScanUpdate::Seed(seed) if t.outline.is_none() => {
                t.outline = Some(seed);
                t.provisional = true;
                t.changed = true;
                t.index_changed = true;
            }
            ScanUpdate::Seed(_) => {}
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
                    Err(_) if t.provisional => t.outline = None,
                    Err(_) => continue,
                }
                t.provisional = false;
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
    changed | navigation::poll(s, tx) | preview::poll(s, tx)
}
