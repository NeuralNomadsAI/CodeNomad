use super::{Entry, MAX_ENTRIES, Project, scope};
use crate::{Phase, State, backend::Backend, platform};
use codenomad_client::{Receiver, Sender, bounded, prompt_history};
use rune::edit::TextEdit;

enum Job {
    Read(Backend, Project),
    Append(Backend, String),
}

#[derive(Default)]
pub(super) struct Storage {
    pipe: Option<(Sender<Job>, Receiver<(Project, Option<Vec<String>>)>)>,
    last_binding: Option<(Project, Backend)>,
    loading: Vec<Project>,
    loaded: Vec<Project>,
}

impl Storage {
    fn enqueue(&mut self, job: Job, wake: codenomad_client::Wake) -> bool {
        let (out, _) = self.pipe.get_or_insert_with(|| {
            let (out, jobs) = bounded(16);
            let (results, read) = bounded(16);
            platform::spawn(async move {
                while let Ok(job) = jobs.recv().await {
                    match job {
                        Job::Read(backend, project) => {
                            let history = prompt_history::read(&backend).await.ok();
                            if results.send((project, history)).await.is_err() {
                                return;
                            }
                            wake();
                        }
                        Job::Append(backend, text) => {
                            let _ = prompt_history::append(&backend, &text).await;
                            wake();
                        }
                    }
                }
            });
            (out, read)
        });
        out.try_send(job).is_ok()
    }
}

fn connect(s: &mut State) {
    let Some((project, _, _)) = scope(s) else {
        return;
    };
    let Some(backend) = s.composer.picker.backend() else {
        return;
    };
    let storage = &mut s.prompt_history.persistence;
    if !backend.workspace.is_empty()
        && !storage.loading.contains(&project)
        && !storage.loaded.contains(&project)
        && !storage.last_binding.as_ref().is_some_and(|(p, b)| {
            *p == project
                && b.workspace == backend.workspace
                && b.client.same_connection(&backend.client)
        })
        && storage.enqueue(Job::Read(backend.clone(), project.clone()), s.wake.clone())
    {
        storage.last_binding = Some((project.clone(), backend.clone()));
        storage.loading.push(project);
    }
}

pub(super) fn append(s: &mut State, text: &str) {
    if text.is_empty() || text.len() > prompt_history::MAX_ENTRY_BYTES {
        return;
    }
    connect(s);
    let Some(backend) = s.composer.picker.backend() else {
        return;
    };
    if !backend.workspace.is_empty() {
        // The picker is bound to the active conversation, unlike host Preferences.
        s.prompt_history
            .persistence
            .enqueue(Job::Append(backend.clone(), text.into()), s.wake.clone());
    }
}

pub(crate) fn poll(s: &mut State) -> bool {
    if s.draft.focused
        && !s.screen.is_launcher()
        && matches!(s.phase, Phase::Ready | Phase::Streaming)
    {
        connect(s);
    }
    let history = &mut s.prompt_history;
    let mut changed = false;
    while let Some((project, texts)) = history
        .persistence
        .pipe
        .as_ref()
        .and_then(|(_, read)| read.try_recv().ok())
    {
        history.persistence.loading.retain(|p| p != &project);
        let Some(texts) = texts else { continue };
        history.persistence.loaded.push(project.clone());
        let available = MAX_ENTRIES.saturating_sub(history.count(&project));
        for resolved in texts
            .into_iter()
            .filter(|text| !text.is_empty())
            .take(available)
        {
            if history.full(resolved.len()) {
                break;
            }
            history.bytes += resolved.len();
            history.oldest -= 1;
            history.entries.push_back(Entry {
                project: project.clone(),
                origin: None,
                edit: TextEdit::default(),
                draft: Default::default(),
                bytes: resolved.len(),
                resolved,
                id: history.oldest,
            });
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::{Env, Runtime};

    #[test]
    fn reopened_history_is_older_than_local_attempts_and_scoped_to_its_project() {
        let mut s = crate::init();
        s.draft = TextEdit::new("retained draft");
        assert!(super::super::record(&mut s, "local".into(), false));
        let (jobs, _worker) = bounded(1);
        let (results, read) = bounded(2);
        s.prompt_history.persistence.pipe = Some((jobs, read));
        results
            .try_send((
                Project::Direct("different".into(), "project".into()),
                Some(vec!["foreign".into()]),
            ))
            .unwrap();
        results
            .try_send((
                Project::Unbound,
                Some((0..100).map(|n| format!("stored {n}")).collect()),
            ))
            .unwrap();
        assert!(poll(&mut s));
        assert_eq!(s.prompt_history.count(&Project::Unbound), 100);
        let mut rt = Runtime::new(s, crate::view, (800.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            assert!(super::super::step(s, true, true, tx));
            assert_eq!(s.draft.text, "retained draft");
            assert!(super::super::step(s, true, true, tx));
            assert_eq!(s.draft.text, "stored 0");
            super::super::restore(s);
            assert_eq!(s.draft.text, "retained draft");
        });
    }
}
