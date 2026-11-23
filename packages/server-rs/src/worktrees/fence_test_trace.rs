//! Request-local capture of synchronization events in the worktree race test.
use std::sync::{Arc, Mutex};

pub type Trace = Arc<Mutex<Vec<String>>>;
tokio::task_local! { pub static REQUEST: (&'static str, Trace); }
tokio::task_local! { pub static BEFORE_ADMISSION: Arc<Pause>; }

pub struct Pause {
    pub reached: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
}

pub async fn before_admission() {
    if let Ok(pause) = BEFORE_ADMISSION.try_with(Arc::clone) {
        record("admission hook", "waiting for fixture release");
        pause.reached.add_permits(1);
        pause.release.acquire().await.unwrap().forget();
        record("admission hook", "released by fixture");
    }
}

pub fn record(resource: &str, state: &str) {
    let _ = REQUEST.try_with(|(request, log)| log.lock().unwrap().push(format!("{request} {resource} {state}")));
}

pub struct Held {
    resource: &'static str,
    owner: Option<(&'static str, Trace)>,
}

pub fn held(resource: &'static str) -> Held {
    record(resource, "held");
    Held { resource, owner: REQUEST.try_with(Clone::clone).ok() }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some((request, log)) = &self.owner {
            log.lock().unwrap().push(format!("{request} {} released", self.resource));
        }
    }
}
