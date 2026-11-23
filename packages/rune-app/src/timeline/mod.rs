//! The visible conversation owns structure and selection; the reader owns bodies.
mod navigation;
#[cfg(test)]
mod tests;
mod view;
pub(crate) use navigation::{admit, cancel_jump, failed};
pub(crate) use view::{view, watch};

use crate::{State, backend::Backend, platform, transport::Event};
use codenomad_client::{
    Receiver, Sender, bounded,
    timeline::{self, MarkerKind, Outline, OutlineRevision, Resident, WindowPosition},
};
use std::{cell::Cell, rc::Rc, sync::Arc};

#[derive(Clone, PartialEq, Eq)]
struct Marker {
    id: String,
    message: String,
    kind: MarkerKind,
    ordinal: u64,
    continued: bool,
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
            tool: m.tool_name.map(str::to_owned),
        }
    }
}

type Scan = (Sender<()>, Receiver<crate::history::Result<Outline>>);

#[derive(Default)]
pub(crate) struct Timeline {
    backend: Option<Backend>,
    outline: Option<Outline>,
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
    version: u64,
    outline_error: bool,
    jump: navigation::Navigation,
    scroll: Rc<Cell<view::Scroll>>,
    resident: Vec<(String, Vec<Marker>)>,
    detached: bool,
}

fn owner(s: &mut State) -> &mut Timeline {
    &mut s.transcript_display.timeline
}

pub(crate) fn reading_changed(s: &State) {
    if demanded(s) {
        (s.wake)();
    }
}

pub(crate) fn structure_changed(s: &mut State) {
    owner(s).changed = true;
}

fn cancel_scan(t: &mut Timeline) {
    t.revision.invalidate();
    t.scan = None;
}

pub(crate) fn suspend(s: &mut State) {
    cancel_jump(s);
    let t = owner(s);
    t.visible = false;
    cancel_scan(t);
    t.refresh = true;
    // A departed view can retain only a cache-sized completed index.
    if t.outline.as_ref().is_some_and(|index| !index.cacheable) {
        t.outline = None;
        t.markers.clear();
        t.resident.clear();
        t.changed = true;
    }
}

pub(crate) fn observe(s: &mut State, event: &Event) {
    let t = owner(s);
    match event {
        Event::Connected(backend) => {
            let same = t.backend.as_ref().is_some_and(|old| {
                old.client_id == backend.client_id
                    && old.workspace == backend.workspace
                    && old.session == backend.session
            });
            if !same {
                *t = Timeline::default();
            }
            t.backend = Some(backend.clone());
            t.refresh = true;
        }
        Event::HistoryInvalidated => {
            cancel_scan(t);
            t.outline = None;
            t.markers.clear();
            t.version = t.version.wrapping_add(1);
            t.resident.clear();
            t.refresh = true;
            t.changed = true;
            cancel_jump(s);
        }
        Event::ConnectionLost
        | Event::Reconnecting
        | Event::AuthenticationRequired(_)
        | Event::WorkspaceMissing => {
            cancel_scan(t);
            t.online = false;
            t.refresh = true;
            cancel_jump(s);
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

fn demanded(s: &State) -> bool {
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
    if !t.index_changed && owned == t.resident && t.detached == s.history_detached {
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
    let projected = timeline::project(index, &rows, position)
        .map(|markers| markers.into_iter().map(Marker::from).collect::<Vec<_>>());
    let detached = s.history_detached;
    let t = owner(s);
    let new_index = std::mem::take(&mut t.index_changed);
    t.detached = detached;
    t.resident = owned;
    match projected {
        Ok(markers) if markers != t.markers => {
            t.markers = markers;
            t.version = t.version.wrapping_add(1);
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
        if std::mem::take(&mut owner(s).visible) {
            suspend(s);
        }
        return false;
    }
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let t = owner(s);
    t.visible = true;
    let complete = t.scan.as_ref().and_then(|(_, in_)| in_.try_recv().ok());
    let mut changed = complete.is_some();
    if let Some(result) = complete {
        t.scan = None;
        t.outline_error = result.is_err();
        if let Ok(index) = result {
            t.outline = Some(index);
            t.changed = true;
            t.index_changed = true;
        }
    }
    if t.online
        && t.refresh
        && t.scan.is_none()
        && let Some(backend) = t.backend.clone()
    {
        t.refresh = false;
        let revision = t.revision.clone();
        let (cancel, cancelled) = bounded(1);
        let (out, in_) = bounded(1);
        t.scan = Some((cancel, in_));
        platform::spawn(async move {
            if let Some(_permit) = reads.background(&cancelled).await
                && let Some(result) =
                    platform::reads::cancellable(&cancelled, backend.outline(&revision)).await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }
    if std::mem::take(&mut t.changed) {
        changed |= reproject(s);
    }
    changed | navigation::poll(s, tx)
}
