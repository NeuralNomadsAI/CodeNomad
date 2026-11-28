use super::task_rows::TaskRows;
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
        DetailRead, DirectoryChanged, MapHeader, Report, RevisionChanged, Task, TaskWindow,
    },
    runtime::{Instant, timeout},
};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const BUDGET: Duration = Duration::from_secs(30);

/// Two-phase cancellation token shared by Missions background reads.
///
/// Calling `mark_aborted()` flags all flights aborted before any channel closes and wakes workers,
/// so a worker releasing a `Reads::background` permit on a multi-threaded executor cannot wake a
/// queued sibling flight into opening a new socket before its own cancellation runs.
pub(super) struct CancelToken {
    aborted: Arc<AtomicBool>,
    tx: Sender<()>,
}

#[derive(Clone)]
pub(super) struct CancelSignal {
    aborted: Arc<AtomicBool>,
    rx: Receiver<()>,
}

impl CancelToken {
    pub(super) fn new() -> (Self, CancelSignal) {
        let aborted = Arc::new(AtomicBool::new(false));
        let (tx, rx) = bounded(1);
        (
            Self {
                aborted: aborted.clone(),
                tx,
            },
            CancelSignal { aborted, rx },
        )
    }

    pub(super) fn mark_aborted(&self) {
        self.aborted.store(true, Ordering::Release);
    }

    pub(super) fn cancel(self) {
        self.mark_aborted();
        self.tx.close();
    }
}

impl Drop for CancelToken {
    fn drop(&mut self) {
        self.aborted.store(true, Ordering::Release);
        self.tx.close();
    }
}

impl CancelSignal {
    pub(super) fn is_cancelled(&self) -> bool {
        self.aborted.load(Ordering::Acquire) || self.rx.is_closed()
    }

    pub(super) async fn with_background<T>(
        &self,
        reads: &Reads,
        fut: impl Future<Output = T>,
    ) -> Option<T> {
        if self.is_cancelled() {
            return None;
        }
        let _permit = reads.background(&self.rx).await?;
        if self.is_cancelled() {
            return None;
        }
        reads::cancellable(&self.rx, fut).await
    }

    pub(super) async fn run<T>(&self, fut: impl Future<Output = T>) -> Option<T> {
        if self.is_cancelled() {
            return None;
        }
        reads::cancellable(&self.rx, fut).await
    }
}

#[derive(Default)]
pub(super) struct Detail {
    id: String,
    observed: Option<u64>,
    pub snapshot: Option<Snapshot>,
    active: Option<(Demand, CancelToken, Receiver<Result<Answer>>)>,
    staged: Option<(Demand, Result<Answer>)>,
    pending: Option<Demand>,
    retry: Option<Demand>,
    looked_up: HashSet<(String, String)>,
    lookup_failed: Option<(String, String)>,
    auth_expired: Option<Backend>,
    pub failed: bool,
    pub map_reads: u64,
}

#[derive(Clone)]
enum Demand {
    Refresh,
    More,
    Attention,
    Lookup {
        task_id: Option<String>,
        task_key: Option<String>,
    },
}

pub(super) struct Snapshot {
    pub header: MapHeader,
    pub tasks: Rc<TaskRows>,
    pub reports: HashMap<String, Report>,
    pub end: u64,
    pub attention_end: u64,
}

enum Answer {
    New(MapHeader, Vec<Task>, HashMap<String, Report>, u64),
    Same(MapHeader),
    More(TaskWindow, u64),
    Attention(TaskWindow, u64),
    Lookup(TaskWindow, u64, String, String),
}

impl Answer {
    fn revision(&self) -> u64 {
        match self {
            Self::New(header, _, _, _) => header.root.revision,
            Self::Same(header) => header.root.revision,
            Self::More(_, revision)
            | Self::Attention(_, revision)
            | Self::Lookup(_, revision, _, _) => *revision,
        }
    }
}

impl Detail {
    pub fn authoritative(&self) -> bool {
        !self.busy()
            && !self.failed
            && self
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| Some(snapshot.header.root.revision) >= self.observed)
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn retained_bytes(&self) -> usize {
        let Some(snapshot) = &self.snapshot else {
            return 0;
        };
        let tasks = snapshot.tasks.iter().fold(0usize, |total, task| {
            total
                .saturating_add(task.id.len())
                .saturating_add(task.key.len())
                .saturating_add(task.title.len())
                .saturating_add(task.role().len())
                .saturating_add(128)
        });
        let reports = snapshot.reports.iter().fold(0usize, |total, (id, report)| {
            total
                .saturating_add(id.len())
                .saturating_add(report.task_key.len())
                .saturating_add(report.session_id.len())
                .saturating_add(report.excerpt().map_or(0, str::len))
                .saturating_add(128)
        });
        tasks.saturating_add(reports)
    }

    pub fn evict_snapshot(&mut self) -> usize {
        let before = self.retained_bytes();
        if before == 0 {
            return 0;
        }
        self.cancel();
        self.snapshot = None;
        self.looked_up.clear();
        if !self.id.is_empty() {
            self.pending = Some(Demand::Refresh);
        }
        before
    }
    pub fn mark_cancel(&self) {
        if let Some((_, cancel, _)) = &self.active {
            cancel.mark_aborted();
        }
    }
    pub fn cancel(&mut self) {
        self.active = None;
        self.staged = None;
        self.pending = None;
    }
    pub fn busy(&self) -> bool {
        self.active.is_some() || self.pending.is_some()
    }
    pub fn refresh(&mut self) {
        self.pending = Some(Demand::Refresh);
    }

    pub fn observe(&mut self, id: &str, revision: u64) {
        if self.id != id {
            self.clear();
            self.id = id.into();
        }
        self.observed = self.observed.max(Some(revision));
    }

    pub fn revision_floor(&mut self, id: &str, summary: Option<u64>) -> Option<u64> {
        if self.id != id {
            return summary;
        }
        if self.staged.is_none() {
            self.staged = self.active.as_ref().and_then(|(demand, _, inbox)| {
                inbox.try_recv().ok().map(|answer| (demand.clone(), answer))
            });
        }
        let answer = self.staged.as_ref().and_then(|(_, answer)| match answer {
            Ok(answer) => Some(answer.revision()),
            Err(error) => error
                .downcast_ref::<RevisionChanged>()
                .map(|changed| changed.0),
        });
        self.observed.max(summary).max(answer)
    }
    pub fn retry(&mut self) {
        self.pending = self.retry.clone();
    }
    pub fn lookup_task(&mut self, task_id: Option<&str>, task_key: Option<&str>) {
        if self.busy() || self.failed {
            return;
        }
        let Some(snapshot) = &self.snapshot else {
            return;
        };
        if snapshot.tasks.len() >= snapshot.header.tasks.page.total {
            return;
        }
        let key_pair = (
            task_id.unwrap_or_default().to_owned(),
            task_key.unwrap_or_default().to_owned(),
        );
        if self.looked_up.contains(&key_pair) {
            return;
        }
        self.lookup_failed = None;
        self.pending = Some(Demand::Lookup {
            task_id: task_id.filter(|s| !s.is_empty()).map(str::to_owned),
            task_key: task_key.filter(|s| !s.is_empty()).map(str::to_owned),
        });
    }
    pub fn lookup_settled(&self, task_id: &str, task_key: &str) -> bool {
        self.looked_up
            .contains(&(task_id.to_owned(), task_key.to_owned()))
    }
    pub fn take_lookup_failed(&mut self, task_id: &str, task_key: &str) -> bool {
        if self
            .lookup_failed
            .as_ref()
            .is_some_and(|(id, key)| id == task_id && key == task_key)
        {
            self.lookup_failed = None;
            true
        } else {
            false
        }
    }
    pub fn clear_lookup_cache(&mut self) {
        self.looked_up.clear();
        self.lookup_failed = None;
    }
    pub fn cancel_lookup(&mut self) {
        if matches!(self.active.as_ref(), Some((Demand::Lookup { .. }, _, _))) {
            self.active = None;
        }
        if matches!(self.staged.as_ref(), Some((Demand::Lookup { .. }, _))) {
            self.staged = None;
        }
        if matches!(self.pending.as_ref(), Some(Demand::Lookup { .. })) {
            self.pending = None;
        }
    }
    pub fn take_auth_expired(&mut self) -> Option<Backend> {
        self.auth_expired.take()
    }
    #[cfg(test)]
    pub fn fixture_snapshot_and_lookup(
        &mut self,
        header: MapHeader,
        task_id: String,
        task_key: String,
    ) {
        self.id.clone_from(&header.root.id);
        self.snapshot = Some(Snapshot {
            header,
            tasks: Rc::new(TaskRows::new(Vec::new())),
            reports: HashMap::new(),
            end: 0,
            attention_end: 0,
        });
        self.pending = Some(Demand::Lookup {
            task_id: Some(task_id),
            task_key: Some(task_key),
        });
    }
    pub fn more(&mut self) {
        if !self.busy()
            && self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.end < s.header.tasks.page.total)
        {
            self.pending = Some(Demand::More);
        }
    }

    pub fn attention(&mut self) {
        if !self.busy()
            && self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.attention_remaining().0 > 0)
        {
            self.pending = Some(Demand::Attention);
        }
    }

    pub fn poll(
        &mut self,
        backend: &Backend,
        project: &str,
        id: &str,
        revision: Option<u64>,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        let mut changed = false;
        if self.id != id {
            self.clear();
            self.id = id.into();
            self.refresh();
            changed = true;
        }
        if revision > self.observed {
            self.observed = revision;
            self.refresh();
        }
        self.revision_floor(id, revision);
        if let Some((demand, result)) = self.staged.take() {
            self.active = None;
            let is_lookup = matches!(demand, Demand::Lookup { .. });
            if !is_lookup {
                self.retry = None;
            }
            let failed = match result {
                Ok(answer) if Some(answer.revision()) < self.observed => {
                    if !is_lookup {
                        self.retry = Some(Demand::Refresh);
                    }
                    !is_lookup
                }
                Ok(answer) => {
                    self.observed = self.observed.max(Some(answer.revision()));
                    match answer {
                        Answer::New(header, tasks, reports, end) => {
                            self.map_reads = self.map_reads.saturating_add(1);
                            self.looked_up.clear();
                            self.snapshot = Some(Snapshot {
                                header,
                                tasks: Rc::new(TaskRows::new(tasks)),
                                reports,
                                end,
                                attention_end: 0,
                            });
                            false
                        }
                        Answer::Same(header) => {
                            self.map_reads = self.map_reads.saturating_add(1);
                            if let Some(old) = &mut self.snapshot {
                                old.header = header;
                            }
                            false
                        }
                        Answer::More(window, _) => self
                            .snapshot
                            .as_mut()
                            .is_none_or(|snapshot| !snapshot.extend(window)),
                        Answer::Attention(window, _) => {
                            self.snapshot.as_mut().is_none_or(|snapshot| {
                                let Some(end) =
                                    window.task_page.attention.and_then(|page| page.end)
                                else {
                                    return true;
                                };
                                if !Rc::make_mut(&mut snapshot.tasks).extend(window.tasks, 0, 0) {
                                    return true;
                                }
                                snapshot.merge_reports(window.reports);
                                snapshot.attention_end = end;
                                false
                            })
                        }
                        Answer::Lookup(window, _, req_id, req_key) => {
                            self.looked_up.insert((req_id, req_key));
                            if let Some(snapshot) = self.snapshot.as_mut()
                                && Rc::make_mut(&mut snapshot.tasks).extend(window.tasks, 0, 0)
                            {
                                snapshot.merge_reports(window.reports);
                            }
                            false
                        }
                    }
                }
                Err(error) => {
                    if codenomad_client::missions::is_auth_expired(&error) {
                        self.auth_expired = Some(backend.clone());
                    }
                    if let Some(changed) = error.downcast_ref::<RevisionChanged>() {
                        self.observed = self.observed.max(Some(changed.0));
                    }
                    if let Demand::Lookup { task_id, task_key } = demand {
                        if error.is::<DirectoryChanged>() || error.is::<RevisionChanged>() {
                            self.refresh();
                        } else {
                            self.lookup_failed =
                                Some((task_id.unwrap_or_default(), task_key.unwrap_or_default()));
                        }
                        false
                    } else {
                        self.retry = Some(
                            if error.is::<DirectoryChanged>() || error.is::<RevisionChanged>() {
                                Demand::Refresh
                            } else {
                                demand
                            },
                        );
                        true
                    }
                }
            };
            if !is_lookup {
                self.failed = failed;
                if self.failed && self.retry.is_none() {
                    self.retry = Some(Demand::Refresh);
                }
            }
            changed = true;
        }
        if self.active.is_some() {
            return changed;
        }
        let Some(demand) = self.pending.take() else {
            return changed;
        };
        let (out, inbox) = bounded(1);
        let backend = backend.clone();
        let project = project.to_owned();
        let id = self.id.clone();
        let reads = reads.clone();
        let wake = wake.clone();
        let previous = self.snapshot.as_ref().map(|s| {
            let source = &s.header.tasks;
            (
                source.version.clone(),
                source.page.order.clone(),
                source.pins.clone(),
                source.report_pins.clone(),
                source
                    .page
                    .attention
                    .as_ref()
                    .map(|page| page.sequence.clone()),
            )
        });
        let more = self.snapshot.as_ref().and_then(|s| {
            let read = match &demand {
                Demand::More => backend.mission_task_window(&project, &s.header, s.end),
                Demand::Attention => {
                    backend.mission_task_attention(&project, &s.header, s.attention_end)
                }
                Demand::Lookup { task_id, task_key } => backend.mission_task_lookup(
                    &project,
                    &s.header,
                    task_id.as_deref(),
                    task_key.as_deref(),
                ),
                Demand::Refresh => return None,
            };
            Some((read, s.header.root.revision))
        });
        let started = Instant::now();
        let floor = self.observed;
        let (cancel, signal) = CancelToken::new();
        self.active = Some((demand.clone(), cancel, inbox));
        platform::spawn(async move {
            let operation = async {
                match (demand, more) {
                    (Demand::More, Some((read, revision))) => {
                        let window = read_window(read?, &reads, &signal)
                            .await
                            .ok_or("cancelled Mission task read")??;
                        Ok(Answer::More(window, revision))
                    }
                    (Demand::Attention, Some((read, revision))) => {
                        let window = read_window(read?, &reads, &signal)
                            .await
                            .ok_or("cancelled Mission task read")??;
                        Ok(Answer::Attention(window, revision))
                    }
                    (Demand::Lookup { task_id, task_key }, Some((read, revision))) => {
                        let window = read_window(read?, &reads, &signal)
                            .await
                            .ok_or("cancelled Mission task lookup")??;
                        Ok(Answer::Lookup(
                            window,
                            revision,
                            task_id.unwrap_or_default(),
                            task_key.unwrap_or_default(),
                        ))
                    }
                    _ => refresh(&backend, &project, &id, previous, floor, &reads, &signal).await,
                }
            };
            let task = async {
                let answer = timeout(BUDGET.saturating_sub(started.elapsed()), operation)
                    .await
                    .ok_or("Mission detail read timed out")?;
                if started.elapsed() >= BUDGET {
                    Err("Mission detail read timed out".into())
                } else {
                    answer
                }
            };
            if let Some(answer) = signal.run(task).await
                && !signal.is_cancelled()
                && out.send(answer).await.is_ok()
            {
                wake();
            }
        });
        true
    }
}

impl Snapshot {
    pub fn attention_remaining(&self) -> (u64, bool) {
        self.header
            .tasks
            .page
            .attention
            .as_ref()
            .map_or((0, true), |a| {
                let (remaining, exact) =
                    a.unread_after(self.attention_end, |key| self.tasks.contains(key));
                (
                    remaining.min(
                        self.header
                            .tasks
                            .page
                            .total
                            .saturating_sub(self.tasks.len()),
                    ),
                    exact,
                )
            })
    }

    pub fn report(&self, id: &str) -> Option<&Report> {
        self.reports.get(id)
    }

    pub fn task_reports(&self, task_key: &str) -> Vec<&Report> {
        let mut list: Vec<&Report> = self
            .reports
            .values()
            .filter(|report| report.task_key == task_key)
            .collect();
        list.sort_unstable_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        list
    }

    fn merge_reports(&mut self, reports: Vec<Report>) {
        for report in reports {
            if self
                .reports
                .get(&report.id)
                .is_some_and(|existing| existing.task_key != report.task_key)
            {
                continue;
            }
            self.reports.insert(report.id.clone(), report);
        }
    }

    fn extend(&mut self, page: TaskWindow) -> bool {
        if page.task_page.offset != self.end
            || !Rc::make_mut(&mut self.tasks).extend(page.tasks, self.end, page.task_page.end)
        {
            return false;
        }
        self.merge_reports(page.reports);
        self.end = page.task_page.end;
        true
    }
}

type SourceWitness = (String, String, Vec<String>, Vec<String>, Option<String>);

async fn refresh(
    backend: &Backend,
    project: &str,
    id: &str,
    previous: Option<SourceWitness>,
    mut floor: Option<u64>,
    reads: &Reads,
    cancel: &CancelSignal,
) -> Result<Answer> {
    for attempt in 0..2 {
        let result = read_map(
            backend,
            project,
            id,
            previous.as_ref(),
            &mut floor,
            reads,
            cancel,
        )
        .await;
        if let Err(error) = &result {
            if let Some(changed) = error.downcast_ref::<RevisionChanged>() {
                floor = floor.max(Some(changed.0));
            }
            if attempt == 0 && (error.is::<DirectoryChanged>() || error.is::<RevisionChanged>()) {
                continue;
            }
            if let Some(revision) = floor
                && (error.is::<DirectoryChanged>() || error.is::<RevisionChanged>())
            {
                return Err(RevisionChanged(revision).into());
            }
        }
        return result;
    }
    Err(DirectoryChanged.into())
}

async fn read_map(
    backend: &Backend,
    project: &str,
    id: &str,
    previous: Option<&SourceWitness>,
    floor: &mut Option<u64>,
    reads: &Reads,
    cancel: &CancelSignal,
) -> Result<Answer> {
    let read = backend.mission_header(project, id)?;
    let header = read_window(read, reads, cancel)
        .await
        .ok_or("cancelled Mission header")??;
    let revision = Some(header.root.revision);
    if revision < *floor {
        return Err(DirectoryChanged.into());
    }
    *floor = revision;
    let source = &header.tasks;
    if previous.is_some_and(|(version, order, pins, report_pins, attention)| {
        *version == source.version
            && *order == source.page.order
            && *pins == source.pins
            && *report_pins == source.report_pins
            && attention.as_ref() == source.page.attention.as_ref().map(|page| &page.sequence)
    }) {
        return Ok(Answer::Same(header));
    }
    let end = source.page.end;
    let mut tasks = Vec::new();
    let mut reports: HashMap<String, codenomad_client::missions::Report> = HashMap::new();
    if source.page.total != 0 {
        let read = backend.mission_task_window(project, &header, 0)?;
        let window = read_window(read, reads, cancel)
            .await
            .ok_or("cancelled Mission tasks")??;
        tasks = window.tasks;
        for report in window.reports {
            if reports
                .get(&report.id)
                .is_some_and(|old| old.task_key != report.task_key)
            {
                continue;
            }
            reports.insert(report.id.clone(), report);
        }
    }
    if !source.pins.is_empty() || !source.report_pins.is_empty() {
        let read = backend.mission_task_pins(project, &header)?;
        let pins = read_window(read, reads, cancel)
            .await
            .ok_or("cancelled Mission pins")??;
        for pin in pins.tasks {
            if pin.order < end
                || tasks
                    .iter()
                    .any(|task| task.id == pin.id || task.key == pin.key || task.order == pin.order)
            {
                return Err("inconsistent Mission pin".into());
            }
            tasks.push(pin);
        }
        for report in pins.reports {
            if reports
                .get(&report.id)
                .is_some_and(|old| old.task_key != report.task_key)
            {
                continue;
            }
            reports.insert(report.id.clone(), report);
        }
    }
    Ok(Answer::New(header, tasks, reports, end))
}

pub(super) async fn read_window<T>(
    mut read: DetailRead<T>,
    reads: &Reads,
    cancel: &CancelSignal,
) -> Option<Result<T>> {
    loop {
        let result = cancel.with_background(reads, read.read_next()).await?;
        match result {
            Ok(None) => {}
            Ok(Some(page)) => return Some(Ok(page)),
            Err(error) => return Some(Err(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn never_publishes_a_header_or_task_page_below_an_observed_revision() {
        let mut detail = Detail::default();
        detail.observe("mission", 8);
        detail.observe("mission", 7);
        let descriptor = json!({"characters":0,"digest":"","total":0,"array":true});
        let header = |revision| {
            serde_json::from_value(json!({
            "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
                "excerpt":"Fixture","template":"custom","status":"active","coordinatorSessionId":"session",
                "revision":revision,"createdAt":1,"updatedAt":1,"historyTruncated":false,"bodies":{}},
            "collections":{"actors":descriptor,"history":descriptor,"reports":descriptor},
            "tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
                "pins":[],"reportPins":[],"version":""}
        })).unwrap()
        };
        let backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
        let reads = Reads::default();
        let wake: Wake = std::sync::Arc::new(|| {});
        for revision in [7, 8] {
            let (send, inbox) = bounded(1);
            send.try_send(Ok(Answer::New(header(revision), vec![], HashMap::new(), 0)))
                .ok()
                .unwrap();
            detail.active = Some((Demand::Refresh, CancelToken::new().0, inbox));
            assert!(detail.poll(&backend, "project", "mission", None, &reads, &wake));
            assert_eq!(
                detail
                    .snapshot
                    .as_ref()
                    .map(|snapshot| snapshot.header.root.revision),
                (revision == 8).then_some(8)
            );
        }
        detail.observe("mission", 9);
        let (send, inbox) = bounded(1);
        let page = serde_json::from_value(json!({
            "taskPage":{"order":"","offset":0,"end":1,"total":1,"counts":{"ready":1},"reports":0},
            "tasks":[],"reports":[]
        }))
        .unwrap();
        send.try_send(Ok(Answer::More(page, 8))).ok().unwrap();
        detail.active = Some((Demand::More, CancelToken::new().0, inbox));
        assert!(detail.poll(&backend, "project", "mission", None, &reads, &wake));
        assert_eq!(detail.snapshot.as_ref().unwrap().end, 0);
        assert!(detail.failed && matches!(detail.retry, Some(Demand::Refresh)));
        let (send, inbox) = bounded(1);
        send.try_send(Err(RevisionChanged(10).into())).ok().unwrap();
        detail.active = Some((Demand::More, CancelToken::new().0, inbox));
        assert_eq!(detail.revision_floor("mission", Some(8)), Some(10));
        assert_eq!(detail.revision_floor("other", Some(8)), Some(8));
        assert!(detail.poll(&backend, "project", "mission", None, &reads, &wake));
        assert_eq!(detail.revision_floor("mission", Some(8)), Some(10));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn marked_cancel_signal_skips_queued_background_work_when_permit_frees() {
        crate::platform::block_on(async {
            let reads = Reads::default();
            let (_hold1_tx, hold1_rx) = bounded(1);
            let (_hold2_tx, hold2_rx) = bounded(1);
            let p1 = reads.background(&hold1_rx).await.unwrap();
            let p2 = reads.background(&hold2_rx).await.unwrap();

            let (token, signal) = CancelToken::new();
            let entered = Arc::new(AtomicBool::new(false));
            let entered_task = entered.clone();
            let reads_task = reads.clone();
            let (done_tx, done_rx) = bounded(1);
            platform::spawn(async move {
                let res = signal
                    .with_background(&reads_task, async {
                        entered_task.store(true, Ordering::SeqCst);
                    })
                    .await;
                let _ = done_tx.send(res.is_some()).await;
            });

            // Phase 1: mark aborted before releasing any semaphore permit or closing `tx`.
            token.mark_aborted();
            drop(p1);
            drop(p2);
            let ran = tokio::time::timeout(Duration::from_secs(5), done_rx.recv())
                .await
                .expect("queued task must settle once permits free")
                .unwrap();
            assert!(!ran);
            assert!(
                !entered.load(Ordering::SeqCst),
                "marked flight must not run its inner future after acquiring a freed permit"
            );
            token.cancel();
        });
    }
}
