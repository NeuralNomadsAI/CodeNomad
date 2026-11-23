mod labels;
mod preview;
#[cfg(test)]
mod tests;
mod view;
pub(crate) use view::{HOST, overlay, trigger};

use crate::{State, history::Result, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    search::{MIN_QUERY_UNITS, Page, Ranked},
};
use rune::{Key, KeyEvent, Tx, edit::TextEdit};

const DEBOUNCE: f64 = 0.250;
const FIELD: &str = "history-search-query";
const FOCUS: &str = "history-search-query/value/input";
type Destination = (
    crate::backend::Backend,
    String,
    String,
    crate::chat::search_hit::SearchHit,
);

enum Message {
    Progress(Page),
    Complete(Result<Ranked>),
}

struct Frame(rune_theme_codenomad::layout::DrawnRect);

impl Default for Frame {
    fn default() -> Self {
        Self(rune_theme_codenomad::layout::DrawnRect::new([0.; 4]))
    }
}

#[derive(Default)]
pub(super) struct Search {
    open: bool,
    query: TextEdit,
    text: String,
    ranked: bool,
    scope_open: bool,
    frame: Frame,
    position: Option<[f32; 2]>,
    drag: Option<([f32; 2], Option<[f32; 2]>)>,
    technical: bool,
    due: Option<f64>,
    cursor: Option<String>,
    results: Option<Ranked>,
    error: bool,
    flight: Option<(Sender<()>, Receiver<Message>)>,
    selected: Option<usize>,
    destination: Option<(Sender<()>, Receiver<Result<Destination>>)>,
    open_error: bool,
    labels: labels::Labels,
    preview: preview::Preview,
}

fn state(s: &mut State) -> &mut Search {
    &mut super::owner(s).search
}

fn visible(s: &State) -> bool {
    !s.screen.is_launcher()
        && !crate::files::has_preview(s)
        && !crate::git::has_preview(s)
        && s.transcript_display.timeline.backend.is_some()
}

pub(super) fn is_open(s: &State) -> bool {
    s.transcript_display.timeline.search.open && visible(s)
}

pub(crate) fn close(s: &mut State) {
    clear_selection(s);
    *state(s) = Search::default();
}

pub(crate) fn invalidate(s: &mut State) {
    clear_selection(s);
    let model = state(s);
    if model.open {
        model.reset();
    }
}

fn clear_selection(s: &mut State) {
    super::navigation::cancel_search(s);
    s.transcript_display.search_highlight = None;
}

fn query_changed(s: &mut State, tx: &mut Tx) {
    let model = state(s);
    if model.query.text.trim() != model.text {
        let was_short = model.short_query();
        model.text = model.query.text.trim().to_owned();
        if !was_short && let Some(hint) = model.minimum_hint() {
            rune_theme_codenomad::timeline::search::announce(tx, hint);
        }
        model.reset();
        let due = tx.clock() + DEBOUNCE;
        model.due = Some(due);
        tx.wake_at(due);
        clear_selection(s);
    }
}

pub(super) fn retry_selected(s: &mut State, tx: &mut Tx) {
    let model = state(s);
    if model.query.text.trim() == model.text
        && let Some(index) = model.selected
    {
        select(s, index, tx);
    }
}

pub(crate) fn keys(s: &mut State, event: &KeyEvent, tx: &mut Tx) -> bool {
    if event.key == Key::Escape && state(s).open {
        if std::mem::take(&mut state(s).scope_open) {
            return true;
        }
        close(s);
        tx.focus("history-search-toggle", true);
        return true;
    }
    if matches!(event.key, Key::Command(c) if c.eq_ignore_ascii_case(&'f'))
        && (event.mods.ctrl || event.mods.cmd)
        && !event.mods.alt
        && !event.mods.shift
        && visible(s)
    {
        state(s).open = true;
        state(s).query.focused = true;
        tx.focus_when_shown(FOCUS, true);
        return true;
    }
    false
}

impl Search {
    fn short_query(&self) -> bool {
        !self.text.is_empty() && self.text.encode_utf16().count() < MIN_QUERY_UNITS
    }

    fn minimum_hint(&self) -> Option<String> {
        self.short_query().then(|| {
            rune_theme_codenomad::catalogue::format(
                crate::strings::locale(),
                "messageSection.search.count.minChars",
                &[("count", &MIN_QUERY_UNITS.to_string())],
            )
        })
    }

    fn reset(&mut self) {
        self.labels = Default::default();
        self.cursor = None;
        self.run();
    }
    fn run(&mut self) {
        self.flight = None;
        self.results = None;
        self.labels.update(Vec::new());
        self.preview = Default::default();
        self.selected = None;
        self.destination = None;
        self.open_error = false;
        self.error = false;
        self.due = Some(0.0);
    }
    fn page(&self) -> Option<&Page> {
        match self.results.as_ref()? {
            Ranked::Ranked { page, .. } => Some(page),
            _ => None,
        }
    }
}

pub(crate) fn poll(s: &mut State, now: f64, tx: &mut Tx) -> bool {
    if !state(s).open {
        return false;
    }
    if !visible(s) {
        close(s);
        return true;
    }
    let model = state(s);
    if tx.input_waiting() && model.destination.is_some() {
        tx.wake_after(std::time::Duration::ZERO);
        return false;
    }
    let destination = model
        .destination
        .as_ref()
        .and_then(|(_, inbox)| inbox.try_recv().ok());
    if let Some(destination) = destination {
        state(s).destination = None;
        if let Ok((backend, title, slug, mut hit)) = destination
            && crate::launcher::can_change_session(s)
        {
            close(s);
            crate::launcher::bind_search(s, backend, title, &slug, hit.message.clone(), tx);
            hit.restore_pending = true;
            s.transcript_display.search_highlight = Some(hit);
        } else {
            state(s).open_error = true;
        }
        return true;
    }
    let timeline = &s.transcript_display.timeline;
    let backend = timeline.backend.clone().filter(|_| timeline.online);
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let model = state(s);
    let mut changed = false;
    if let Some(due) = model.due {
        if model.text.encode_utf16().count() < MIN_QUERY_UNITS {
            model.due = None;
        } else if now < due {
            tx.wake_at(due);
        } else if let Some(backend) = backend {
            model.due = None;
            let text = model.text.clone();
            let ranked = model.ranked;
            let technical = model.technical;
            let cursor = model.cursor.clone();
            let (cancel, cancelled) = bounded(1);
            let (out, events) = bounded(2);
            model.flight = Some((cancel, events));
            changed = true;
            platform::spawn(async move {
                let Some(_permit) = reads.background(&cancelled).await else {
                    return;
                };
                let work = async {
                    if ranked {
                        backend
                            .rank_history(&text, technical, cursor.as_deref())
                            .await
                    } else {
                        backend
                            .search_history(&text, technical, cursor.as_deref(), |page| {
                                if out.try_send(Message::Progress(page.clone())).is_ok() {
                                    wake();
                                }
                            })
                            .await
                            .map(|page| Ranked::Ranked {
                                version: 1,
                                capped: false,
                                examined_before: 0,
                                exclusions: Vec::new(),
                                page,
                            })
                    }
                };
                if let Some(result) = platform::reads::cancellable(&cancelled, work).await
                    && out.send(Message::Complete(result)).await.is_ok()
                {
                    wake();
                }
            });
        }
    }
    while let Some(event) = model
        .flight
        .as_ref()
        .and_then(|(_, events)| events.try_recv().ok())
    {
        changed = true;
        match event {
            Message::Progress(page) => {
                model.results = Some(Ranked::Ranked {
                    version: 1,
                    capped: false,
                    examined_before: 0,
                    exclusions: Vec::new(),
                    page,
                })
            }
            Message::Complete(result) => {
                model.flight = None;
                match result {
                    Ok(result) => model.results = Some(result),
                    Err(_) => model.error = true,
                }
            }
        }
    }
    if changed && model.ranked {
        let model = &mut s.transcript_display.timeline.search;
        let ids = model
            .page()
            .into_iter()
            .flat_map(|page| &page.hits)
            .map(|hit| hit.session.clone())
            .collect();
        model.labels.update(ids);
    }
    changed | labels::poll(s) | preview::poll(s)
}

fn move_match(s: &mut State, tx: &mut Tx, next: bool) {
    let model = state(s);
    let count = model.page().map_or(0, |page| page.hits.len());
    if count == 0 {
        return;
    }
    let index = match model.selected {
        Some(i) if next => (i + 1) % count,
        Some(i) => (i + count - 1) % count,
        None if next => 0,
        None => count - 1,
    };
    select(s, index, tx);
}

fn select(s: &mut State, index: usize, tx: &mut Tx) {
    let model = state(s);
    if model.query.text.trim() != model.text {
        return;
    }
    let hit = model.page().and_then(|page| page.hits.get(index)).cloned();
    if let Some(hit) = hit {
        clear_selection(s);
        let model = state(s);
        model.destination = None;
        model.open_error = false;
        model.selected = Some(index);
        if s.transcript_display
            .timeline
            .backend
            .as_ref()
            .is_some_and(|b| b.session == hit.session)
        {
            let model = state(s);
            s.transcript_display.search_highlight = Some(crate::chat::search_hit::SearchHit::new(
                &hit,
                &model.text,
                model.ranked,
            ));
            super::navigation::seek_message(s, &hit.message, tx);
            state(s).preview = Default::default();
        } else {
            preview::start(s, hit);
        }
    }
}

fn open_result(s: &mut State, _: &mut Tx) {
    if !crate::launcher::can_change_session(s) {
        return;
    }
    let model = state(s);
    let hit = model
        .selected
        .and_then(|i| model.page()?.hits.get(i))
        .cloned();
    let Some(hit) = hit else { return };
    let target = crate::chat::search_hit::SearchHit::new(&hit, &model.text, true);
    let Some(backend) = s.transcript_display.timeline.backend.clone() else {
        return;
    };
    let Some(project) = s.screen.launcher().and_then(|l| l.project.clone()) else {
        return;
    };
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let (signal, cancelled) = bounded(1);
    let (out, inbox) = bounded(1);
    let model = state(s);
    model.open_error = false;
    model.destination = Some((signal, inbox));
    platform::spawn(async move {
        let Some(_permit) = reads.background(&cancelled).await else {
            return;
        };
        let bind = async {
            let (backend, session, slug) = backend
                .bind_session_placed(&project, &hit.session, false)
                .await?;
            Ok((backend, session.title, slug, target))
        };
        if let Some(result) = platform::reads::cancellable(&cancelled, bind).await
            && out.send(result).await.is_ok()
        {
            wake();
        }
    });
}
