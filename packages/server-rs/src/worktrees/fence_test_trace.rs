//! Request-local capture of synchronization events in the worktree race test.
use std::sync::{Arc, Mutex};

pub type Trace = Arc<Mutex<Vec<String>>>;
tokio::task_local! { pub static REQUEST: (&'static str, Trace); }
tokio::task_local! { pub static BEFORE_ADMISSION: Arc<Pause>; }
tokio::task_local! { pub static AFTER_PROMPT_RESOLVE: Arc<Pause>; }
tokio::task_local! { pub static AFTER_RECHECK_BEFORE_ADMIT: Arc<Pause>; }

pub struct Pause {
    pub reached: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
}

async fn wait_pause(slot: &'static tokio::task::LocalKey<Arc<Pause>>, name: &str) {
    if let Ok(pause) = slot.try_with(Arc::clone) {
        record(name, "waiting for fixture release");
        pause.reached.add_permits(1);
        pause.release.acquire().await.unwrap().forget();
        record(name, "released by fixture");
    }
}

pub async fn before_admission() {
    wait_pause(&BEFORE_ADMISSION, "admission hook").await;
}

pub async fn after_prompt_resolve() {
    wait_pause(&AFTER_PROMPT_RESOLVE, "prompt resolve hook").await;
}

pub async fn after_recheck_before_admit() {
    wait_pause(&AFTER_RECHECK_BEFORE_ADMIT, "recheck hook").await;
}

pub fn record(resource: &str, state: &str) {
    let _ = REQUEST.try_with(|(request, log)| {
        log.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{request} {resource} {state}"));
    });
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
            log.lock().unwrap_or_else(|e| e.into_inner()).push(format!("{request} {} released", self.resource));
        }
    }
}
