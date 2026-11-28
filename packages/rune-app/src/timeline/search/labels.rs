use crate::{State, platform};
use codenomad_client::{Receiver, Sender, bounded};
use std::collections::{HashMap, HashSet, VecDeque};

type Label = (String, String);

#[derive(Default)]
pub(super) struct Labels {
    queue: VecDeque<String>,
    loaded: HashMap<String, Option<Label>>,
    active: Vec<(String, Sender<()>, Receiver<Option<Option<Label>>>)>,
}

impl Labels {
    pub(super) fn get(&self, id: &str) -> Option<&Option<Label>> {
        self.loaded.get(id)
    }

    #[cfg(test)]
    pub(super) fn fixture_set(&mut self, id: &str, title: &str, slug: &str) {
        self.loaded
            .insert(id.to_owned(), Some((title.to_owned(), slug.to_owned())));
    }

    pub(super) fn update(&mut self, ids: Vec<String>) {
        let wanted: HashSet<_> = ids.iter().map(String::as_str).collect();
        self.active
            .retain(|(id, _, _)| wanted.contains(id.as_str()));
        self.loaded.retain(|id, _| wanted.contains(id.as_str()));
        self.queue.clear();
        let mut seen = HashSet::new();
        for id in ids {
            if seen.insert(id.clone())
                && !self.loaded.contains_key(&id)
                && !self.active.iter().any(|(current, _, _)| current == &id)
            {
                self.queue.push_back(id);
            }
        }
    }
}

pub(super) fn poll(s: &mut State) -> bool {
    let Some(backend) = s.transcript_display.timeline.backend.clone() else {
        return false;
    };
    let Some(project) = s.screen.launcher().and_then(|l| l.project.clone()) else {
        return false;
    };
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let labels = &mut super::state(s).labels;
    let mut changed = false;
    labels.active.retain(|(id, _, inbox)| {
        let Ok(result) = inbox.try_recv() else {
            return !inbox.is_closed();
        };
        if let Some(label) = result {
            labels.loaded.insert(id.clone(), label);
            changed = true;
        }
        false
    });
    while labels.active.len() < 4
        && let Some(id) = labels.queue.pop_front()
    {
        let (signal, cancelled) = bounded(1);
        let (out, inbox) = bounded(1);
        labels.active.push((id.clone(), signal, inbox));
        let (backend, project, reads, wake) = (
            backend.clone(),
            project.clone(),
            reads.clone(),
            wake.clone(),
        );
        platform::spawn(async move {
            let Some(_permit) = reads.background(&cancelled).await else {
                return;
            };
            let request = backend.bind_session_placed(&project, &id, false);
            if let Some(result) = platform::reads::cancellable(&cancelled, request).await {
                let label = match result {
                    Ok((_, session, slug)) => Some(Some((session.title, slug))),
                    Err(error) if error.is::<codenomad_client::catalog::SessionMissing>() => {
                        Some(None)
                    }
                    Err(_) => None,
                };
                if out.send(label).await.is_ok() {
                    wake();
                }
            }
        });
    }
    changed
}
