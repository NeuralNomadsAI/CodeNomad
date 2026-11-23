use super::{Entry, MAX_ENTRIES, Project, scope};
use crate::{Phase, State, backend::Backend, platform};
use codenomad_client::{Receiver, Sender, bounded, prompt_history};
use rune::edit::TextEdit;
use std::collections::VecDeque;

enum Job {
    Read(Backend, Project),
    Append(Backend, Project, String),
}

#[derive(Default)]
struct FailedWrites(VecDeque<(Project, prompt_history::Document)>);

impl FailedWrites {
    fn take(&mut self, key: &Project) -> Option<prompt_history::Document> {
        let index = self.0.iter().position(|(project, _)| project == key)?;
        self.0.remove(index).map(|(_, document)| document)
    }

    async fn append(&mut self, backend: &Backend, key: Project, text: String) {
        let mut document = match self.take(&key) {
            Some(document) => document,
            None => match prompt_history::read_document(backend).await {
                Ok(document) => document,
                Err(_) => return,
            },
        };
        document.prepend(text);
        if document.write(backend).await.is_err() {
            // A failed PUT remains local until the next explicit submission.
            if self.0.len() == 16 {
                self.0.pop_front();
            }
            self.0.push_back((key, document));
        }
    }
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
                let mut failed = FailedWrites::default();
                while let Ok(job) = jobs.recv().await {
                    match job {
                        Job::Read(backend, project) => {
                            let history = prompt_history::read(&backend).await.ok();
                            if results.send((project, history)).await.is_err() {
                                return;
                            }
                            wake();
                        }
                        Job::Append(backend, project, text) => {
                            failed.append(&backend, project, text).await;
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
    if backend.session_directory.is_some()
        && !storage.loading.contains(&project)
        && !storage.loaded.contains(&project)
        && !storage.last_binding.as_ref().is_some_and(|(p, b)| {
            *p == project
                && b.session_directory == backend.session_directory
                && b.client.same_connection(&backend.client)
        })
        && storage.enqueue(Job::Read(backend.clone(), project.clone()), s.wake.clone())
    {
        storage.last_binding = Some((project.clone(), backend.clone()));
        storage.loading.push(project);
    }
}

pub(super) fn append(s: &mut State, text: &str) {
    if text.is_empty() || text.len() > prompt_history::MAX_WRITE_BYTES {
        return;
    }
    connect(s);
    let Some((project, _, _)) = scope(s) else {
        return;
    };
    let Some(backend) = s.composer.picker.backend() else {
        return;
    };
    if backend.session_directory.is_some() {
        // The picker is bound to the active conversation, unlike host Preferences.
        s.prompt_history.persistence.enqueue(
            Job::Append(backend.clone(), project, text.into()),
            s.wake.clone(),
        );
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
    fn a_failed_put_keeps_the_modified_document_for_the_next_submission() {
        use crate::files::test_http::Http;
        use serde_json::json;

        platform::block_on(async {
            let http = Http::new().await;
            let mut backend = http.backend.clone();
            backend.session_directory = Some("/fixture/linked checkout".into());
            let key = Project::Direct(
                backend.base.clone(),
                backend.session_directory.clone().unwrap(),
            );
            let models = json!({"build":{"providerId":"fixture","modelId":"model"}});
            let (idle, after_idle) = bounded(1);
            let exchange = tokio::spawn(async move {
                let get = http.accept().await;
                assert_eq!(
                    get.header.lines().next().unwrap(),
                    "GET /api/storage/instances/%2Ffixture%2Flinked%20checkout HTTP/1.1"
                );
                get.reply(
                    200,
                    json!({ "messageHistory":["old"], "agentModelSelections":models }),
                )
                .await;
                let first = http.accept().await;
                assert!(
                    first
                        .header
                        .starts_with("PUT /api/storage/instances/%2Ffixture%2Flinked%20checkout ")
                );
                assert_eq!(
                    first.body,
                    json!({"messageHistory":["first","old"], "agentModelSelections":models})
                );
                first.reply(503, json!({})).await;
                http.quiet().await;
                idle.send(()).await.unwrap();
                let second = http.accept().await;
                assert!(
                    second
                        .header
                        .starts_with("PUT /api/storage/instances/%2Ffixture%2Flinked%20checkout ")
                );
                assert_eq!(
                    second.body,
                    json!({"messageHistory":["second","first","old"], "agentModelSelections":models})
                );
                second.reply(204, json!({})).await;
            });
            let mut failed = FailedWrites::default();
            failed.append(&backend, key.clone(), "first".into()).await;
            assert_eq!(failed.0.len(), 1);
            after_idle.recv().await.unwrap();
            failed.append(&backend, key, "second".into()).await;
            assert!(failed.0.is_empty());
            exchange.await.unwrap();
        });
    }

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
