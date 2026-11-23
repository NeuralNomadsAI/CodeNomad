use crate::platform::{
    self,
    reads::{self, Reads},
};
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{DetailRead, DirectoryChanged, MapHeader, Task, TaskWindow},
    runtime::{Instant, timeout},
};
use std::time::Duration;

const BUDGET: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct Detail {
    id: String,
    observed: Option<u64>,
    pub snapshot: Option<Snapshot>,
    active: Option<(Demand, Receiver<Result<Answer>>)>,
    pending: Option<Demand>,
    retry: Option<Demand>,
    pub failed: bool,
}

#[derive(Clone, Copy)]
enum Demand {
    Refresh,
    More,
}

pub(super) struct Snapshot {
    pub header: MapHeader,
    pub tasks: Vec<Task>,
    pub end: u64,
}

enum Answer {
    New(Snapshot),
    Same(MapHeader),
    More(TaskWindow),
}

impl Detail {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn cancel(&mut self) {
        self.active = None;
        self.pending = None;
    }
    pub fn busy(&self) -> bool {
        self.active.is_some() || self.pending.is_some()
    }
    pub fn refresh(&mut self) {
        self.pending = Some(Demand::Refresh);
    }
    pub fn retry(&mut self) {
        self.pending = self.retry;
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
        if let Some((demand, result)) = self
            .active
            .as_ref()
            .and_then(|(demand, r)| r.try_recv().ok().map(|result| (*demand, result)))
        {
            self.active = None;
            self.retry = None;
            self.failed = match result {
                Ok(Answer::New(snapshot)) => {
                    self.snapshot = Some(snapshot);
                    false
                }
                Ok(Answer::Same(header)) => {
                    if let Some(old) = &mut self.snapshot {
                        old.header = header;
                    }
                    false
                }
                Ok(Answer::More(window)) => self
                    .snapshot
                    .as_mut()
                    .is_none_or(|snapshot| !snapshot.extend(window)),
                Err(error) => {
                    self.retry = Some(if error.is::<DirectoryChanged>() {
                        Demand::Refresh
                    } else {
                        demand
                    });
                    true
                }
            };
            if self.failed && self.retry.is_none() {
                self.retry = Some(Demand::Refresh);
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
            )
        });
        let more = self
            .snapshot
            .as_ref()
            .map(|s| backend.mission_task_window(&project, &s.header, s.end));
        let started = Instant::now();
        self.active = Some((demand, inbox));
        platform::spawn(async move {
            let (_cancel, alive) = bounded(1);
            let operation = async {
                match (demand, more) {
                    (Demand::More, Some(read)) => {
                        let window = read_window(read?, &reads, &alive)
                            .await
                            .ok_or("cancelled Mission task read")??;
                        Ok(Answer::More(window))
                    }
                    _ => refresh(&backend, &project, &id, previous, &reads, &alive).await,
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
            if let Some(answer) = codenomad_client::runtime::until_closed(&out, task).await
                && out.send(answer).await.is_ok()
            {
                wake();
            }
        });
        true
    }
}

impl Snapshot {
    fn extend(&mut self, page: TaskWindow) -> bool {
        if page.task_page.offset != self.end
            || page.tasks.iter().any(|task| {
                self.tasks.iter().any(|old| {
                    old.order != task.order && (old.id == task.id || old.key == task.key)
                        || old.order == task.order && (old.id != task.id || old.key != task.key)
                })
            })
        {
            return false;
        }
        self.end = page.task_page.end;
        self.tasks
            .retain(|task| !(page.task_page.offset..self.end).contains(&task.order));
        self.tasks.extend(page.tasks);
        self.tasks.sort_by_key(|task| task.order);
        true
    }
}

type SourceWitness = (String, String, Vec<String>, Vec<String>);

async fn refresh(
    backend: &Backend,
    project: &str,
    id: &str,
    previous: Option<SourceWitness>,
    reads: &Reads,
    alive: &Receiver<()>,
) -> Result<Answer> {
    for attempt in 0..2 {
        let result = read_map(backend, project, id, previous.as_ref(), reads, alive).await;
        if attempt == 0
            && result
                .as_ref()
                .is_err_and(|error| error.is::<DirectoryChanged>())
        {
            continue;
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
    reads: &Reads,
    alive: &Receiver<()>,
) -> Result<Answer> {
    let read = backend.mission_header(project, id)?;
    let header = read_window(read, reads, alive)
        .await
        .ok_or("cancelled Mission header")??;
    let source = &header.tasks;
    if previous.is_some_and(|(version, order, pins, report_pins)| {
        *version == source.version
            && *order == source.page.order
            && *pins == source.pins
            && *report_pins == source.report_pins
    }) {
        return Ok(Answer::Same(header));
    }
    let end = source.page.end;
    let mut tasks = Vec::new();
    if source.page.total != 0 {
        let read = backend.mission_task_window(project, &header, 0)?;
        tasks = read_window(read, reads, alive)
            .await
            .ok_or("cancelled Mission tasks")??
            .tasks;
    }
    if !source.pins.is_empty() || !source.report_pins.is_empty() {
        let read = backend.mission_task_pins(project, &header)?;
        let pins = read_window(read, reads, alive)
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
    }
    tasks.sort_by_key(|task| task.order);
    Ok(Answer::New(Snapshot { header, tasks, end }))
}

pub(super) async fn read_window<T>(
    mut read: DetailRead<T>,
    reads: &Reads,
    cancelled: &Receiver<()>,
) -> Option<Result<T>> {
    loop {
        let permit = reads.background(cancelled).await?;
        let result = reads::cancellable(cancelled, read.read_next()).await?;
        drop(permit);
        match result {
            Ok(None) => {}
            Ok(Some(page)) => return Some(Ok(page)),
            Err(error) => return Some(Err(error)),
        }
    }
}
