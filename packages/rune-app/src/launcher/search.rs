use crate::{
    State,
    catalog::Session,
    history::Result,
    platform::{self, reads},
};
use codenomad_client::{Receiver, Sender, bounded};
use std::time::Duration;

#[derive(Default)]
pub(crate) struct Search {
    scope: Option<(String, String)>,
    result: Option<(Sender<()>, Receiver<Result<Vec<Session>>>)>,
    pub rows: Vec<Session>,
    pub failed: bool,
}
impl Search {
    pub fn pending(&self) -> bool {
        self.result.is_some()
    }
}

pub(super) fn poll(s: &mut State) -> bool {
    let reads = s.reads.clone();
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
    let scope = l
        .project
        .as_ref()
        .zip(l.connection.as_ref())
        .filter(|_| l.show_search && !l.search.text.trim().is_empty())
        .map(|(p, _)| (p.id.clone(), l.search.text.trim().to_owned()));
    if l.search_results.scope != scope {
        l.search_results = Search {
            scope: scope.clone(),
            ..Default::default()
        };
        if let (Some((_, query)), Some(project), Some(backend)) =
            (scope, l.project.clone(), l.connection.clone())
        {
            let (cancel, cancelled) = bounded(1);
            let (out, input) = bounded(1);
            l.search_results.result = Some((cancel, input));
            let wake = l.wake.clone();
            platform::spawn(async move {
                let search = async {
                    platform::sleep(Duration::from_millis(240)).await;
                    let Some(_slot) = reads.background(&cancelled).await else {
                        return;
                    };
                    let _ = out
                        .send(backend.search_sessions(&project, &query).await)
                        .await;
                    wake();
                };
                reads::cancellable(&cancelled, search).await;
            });
        }
        return true;
    }
    let Some(result) = l
        .search_results
        .result
        .as_ref()
        .and_then(|(_, r)| r.try_recv().ok())
    else {
        return false;
    };
    l.search_results.result = None;
    match result {
        Ok(rows) => l.search_results.rows = rows,
        Err(_) => {
            l.search_results.failed = true;
            #[cfg(target_arch = "wasm32")]
            if !crate::platform::pairing::required(s) {
                crate::platform::pairing::observe(s);
            }
        }
    }
    true
}
