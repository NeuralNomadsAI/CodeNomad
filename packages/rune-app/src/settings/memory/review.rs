use super::{El, Layout, chrome, col, layout, t, text};
use crate::{platform, settings::providers::Target};
use codenomad_client::{
    Receiver, Sender,
    backend::Backend,
    bounded,
    settings::memory::{self, Entry, List, Scope},
};
use rune_theme_codenomad::Space;

#[derive(Clone)]
pub(in crate::settings) enum Action {
    Scope(Scope),
    Fold,
    Retry,
    Write(Edit, Option<Fields>),
    Tidy,
    ConfirmTidy(cleanup::Intent, bool),
}

#[derive(Clone)]
pub(in crate::settings) struct Edit {
    pub entry: Entry,
    key: Key,
    namespace: String,
}

#[cfg(test)]
impl Edit {
    pub(in crate::settings) fn fixture() -> Self {
        Self {
            entry: Entry {
                id: "entry".into(),
                title: "Original title".into(),
                kind: memory::Kind::Fact,
                text: "Original text".into(),
                created: "2026-01-01T00:00:00Z".into(),
                updated: "2026-01-01T00:00:00Z".into(),
                revision: "a".repeat(64),
                flagged: false,
            },
            key: Key {
                connection: "fixture".into(),
                server: "fixture".into(),
                scope: Scope::Global,
                context: None,
            },
            namespace: "global".into(),
        }
    }
}
#[derive(Clone)]
pub(in crate::settings) struct Fields {
    pub title: String,
    pub text: String,
    pub kind: memory::Kind,
}

#[derive(Default)]
pub(super) struct Review {
    scope: Option<Scope>,
    expanded: bool,
    key: Option<Key>,
    snapshot: Option<List>,
    flight: Option<(Sender<()>, Receiver<Result<List, &'static str>>)>,
    refresh: bool,
    failed: Option<&'static str>,
    pending: Option<(Edit, Option<Fields>)>,
    write: Option<Receiver<Result<(), &'static str>>>,
    write_result: Option<(Edit, Result<(), &'static str>)>,
    writing: Option<Edit>,
    tidy: Option<cleanup::Intent>,
    cleanup: Option<cleanup::Intent>,
    tidy_attempted: bool,
    tidy_failed: bool,
    epoch: u64,
    seen: super::seen::Seen,
}

#[derive(Clone, PartialEq, Eq)]
struct Key {
    connection: String,
    server: String,
    scope: Scope,
    context: Option<(String, Option<String>)>,
}

impl Review {
    pub fn begin_visit(&mut self) {
        self.seen.begin_visit();
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn bind_seen(&mut self, store: Option<crate::platform::storage::Store>) {
        self.seen.bind(store);
    }
    fn scope(&self, project: Option<&Target>) -> Scope {
        self.scope.unwrap_or(if project.is_some() {
            Scope::Project
        } else {
            Scope::Global
        })
    }

    pub fn suspend(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.key = None;
        self.snapshot = None;
        self.flight = None;
        self.failed = None;
        if let Some((edit, _)) = self.pending.take() {
            self.write_result = Some((edit, Err("settings.memory.error.conflict")));
        }
        self.tidy = None;
        self.cleanup = None;
        self.tidy_attempted = false;
        self.tidy_failed = false;
    }

    pub fn invalidate(&mut self) {
        self.refresh = true;
    }

    pub fn action(&mut self, action: Action, project: Option<&Target>) {
        match action {
            Action::Fold => {
                self.expanded = !self.expanded;
                if let Some((key, list)) = self.key.as_ref().zip(self.snapshot.as_ref()) {
                    self.seen.observe(&key.server, list, self.expanded);
                }
            }
            Action::Scope(scope)
                if scope != self.scope(project)
                    && (scope != Scope::Project || project.is_some()) =>
            {
                self.suspend();
                self.scope = Some(scope);
            }
            Action::Retry => self.invalidate(),
            Action::Write(edit, fields) if !self.writing() && self.writable(&edit) => {
                self.pending = Some((edit, fields))
            }
            Action::Tidy => self.tidy = self.cleanup_intent(project),
            Action::ConfirmTidy(expected, accept) if self.tidy.as_ref() == Some(&expected) => {
                let intent = self.tidy.take();
                // Consume consent before publishing; a second activation cannot start this run.
                if accept && intent == self.cleanup_intent(project) {
                    self.cleanup = intent;
                    self.tidy_attempted = true;
                }
            }
            _ => {}
        }
    }

    fn cleanup_intent(&self, project: Option<&Target>) -> Option<cleanup::Intent> {
        let list = self.snapshot.as_ref()?;
        let key = self.key.as_ref()?;
        let (workspace, session) = project.filter(|p| p.online())?.location();
        if self.tidy_attempted
            || self.writing()
            || self.flight.is_some()
            || self.failed.is_some()
            || !list.cleanup_writable
            || !list.entries.iter().any(|entry| !entry.flagged)
        {
            return None;
        }
        let directory = list.cleanup_directory.clone()?;
        Some(cleanup::Intent {
            epoch: self.epoch,
            connection: key.connection.clone(),
            workspace: workspace.into(),
            session: session.map(str::to_owned),
            directory,
            scope: key.scope,
        })
    }

    pub fn take_cleanup(&mut self) -> Option<cleanup::Intent> {
        self.cleanup.take()
    }
    pub fn cleanup_current(&self, intent: &cleanup::Intent) -> bool {
        self.tidy_attempted
            && self.epoch == intent.epoch
            && self.key.as_ref().is_some_and(|key| {
                key.connection == intent.connection
                    && key.scope == intent.scope
                    && key.context.as_ref().is_some_and(|(workspace, session)| {
                        *workspace == intent.workspace && *session == intent.session
                    })
            })
    }
    pub fn cleanup_failed(&mut self, intent: &cleanup::Intent) {
        if self.epoch == intent.epoch
            && self
                .key
                .as_ref()
                .is_some_and(|key| key.connection == intent.connection && key.scope == intent.scope)
        {
            self.tidy_failed = true;
        }
    }

    pub fn cleanup_confirmation<S: 'static>(
        &self,
        apply: impl Fn(&mut S, Action) -> bool + 'static,
    ) -> Option<El> {
        let intent = self.tidy.clone()?;
        let scope = t(if intent.scope == Scope::Global {
            "settings.memory.global"
        } else {
            "settings.memory.project"
        });
        Some(rune_theme_codenomad::document_reader::editor::confirmation(
            layout::dark(),
            &t("settings.memory.tidyConfirm").replace("{scope}", scope),
            t("settings.memory.cancel"),
            t("settings.memory.tidy"),
            move |s, accept, _| {
                apply(s, Action::ConfirmTidy(intent.clone(), accept));
            },
        ))
    }

    pub fn is_current(&self, edit: &Edit) -> bool {
        self.key.as_ref() == Some(&edit.key)
            && self.snapshot.as_ref().is_some_and(|list| {
                list.scope_key == edit.namespace
                    && list.entries.iter().any(|entry| {
                        entry.id == edit.entry.id && entry.revision == edit.entry.revision
                    })
            })
    }
    pub fn writable(&self, edit: &Edit) -> bool {
        self.is_current(edit)
            && self.failed.is_none()
            && self.flight.is_none()
            && self.snapshot.as_ref().is_some_and(|list| {
                edit.key.scope == Scope::Global || list.cleanup_directory.is_some()
            })
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn cancel_cleanup_confirmation(&mut self) -> bool {
        self.tidy.take().is_some()
    }

    pub fn writing(&self) -> bool {
        self.pending.is_some() || self.write.is_some()
    }

    pub fn write_result(&self, edit: &Edit) -> Option<Result<(), &'static str>> {
        self.write_result
            .as_ref()
            .filter(|(sent, _)| {
                sent.key == edit.key
                    && sent.entry.id == edit.entry.id
                    && sent.entry.revision == edit.entry.revision
            })
            .map(|(_, result)| *result)
    }

    pub fn poll(
        &mut self,
        backend: Option<&Backend>,
        project: Option<&Target>,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) -> bool {
        let scope = self.scope(project);
        if backend.is_some() && project.is_some() {
            self.scope.get_or_insert(scope);
        }
        let key = backend
            .filter(|_| scope == Scope::Global || project.is_some_and(Target::online))
            .map(|backend| Key {
                connection: backend.client_id.clone(),
                server: backend
                    .client
                    .server_identity()
                    .unwrap_or(&backend.base)
                    .to_owned(),
                scope,
                context: project.filter(|target| target.online()).map(|target| {
                    let (workspace, session) = target.location();
                    (workspace.to_owned(), session.map(str::to_owned))
                }),
            });
        let mut changed = self.key != key;
        if changed {
            self.suspend();
            self.key = key;
            self.invalidate();
        }
        if let Some(reply) = &self.write {
            let result = match reply.try_recv() {
                Ok(result) => result,
                Err(_) if reply.is_closed() => Err(UNAVAILABLE),
                Err(_) => return changed,
            };
            self.write = None;
            self.write_result = self.writing.take().map(|edit| (edit, result));
            self.invalidate();
            changed = true;
        }
        let (Some(key), Some(backend)) = (&self.key, backend) else {
            return changed;
        };
        if let Some((_, flight)) = &self.flight {
            let result = match flight.try_recv() {
                Ok(result) => result,
                Err(_) if flight.is_closed() => Err(UNAVAILABLE),
                Err(_) => return changed,
            };
            self.flight = None;
            self.failed = result.as_ref().err().copied();
            if let Ok(list) = result {
                self.seen.observe(&key.server, &list, self.expanded);
                self.snapshot = Some(list);
            }
            changed = true;
        }
        if let Some((edit, fields)) = self.pending.take() {
            if self.writable(&edit) {
                self.start_write(backend, edit, fields, main, window);
            } else {
                self.write_result = Some((edit, Err("settings.memory.error.conflict")));
            }
            return true;
        }
        if !std::mem::take(&mut self.refresh) {
            return changed;
        }
        let (hold, cancel) = bounded::<()>(1);
        let (out, input) = bounded(1);
        self.flight = Some((hold, input));
        let (backend, key, main, window) =
            (backend.clone(), key.clone(), main.clone(), window.clone());
        platform::spawn(async move {
            let context = key
                .context
                .as_ref()
                .map(|(workspace, session)| (workspace.as_str(), session.as_deref()));
            let result =
                platform::reads::cancellable(&cancel, memory::list(&backend, key.scope, context))
                    .await;
            if let Some(result) = result {
                let _ = out.send(result.map_err(error_key)).await;
                for wake in [main, window].into_iter().flatten() {
                    wake();
                }
            }
        });
        true
    }

    fn start_write(
        &mut self,
        backend: &Backend,
        edit: Edit,
        fields: Option<Fields>,
        main: &Option<rune::Waker>,
        window: &Option<rune::Waker>,
    ) {
        use serde_json::json;
        let directory = self
            .snapshot
            .as_ref()
            .and_then(|list| list.cleanup_directory.clone());
        let workspace = edit
            .key
            .context
            .as_ref()
            .filter(|_| edit.key.scope == Scope::Project)
            .map(|(workspace, _)| workspace.clone());
        let entry_id = edit.entry.id.clone();
        let scope = edit.key.scope;
        let mut input =
            json!({"action":"delete", "id":edit.entry.id, "revision":edit.entry.revision});
        let save = fields.is_some();
        if let Some(fields) = fields {
            input["action"] = json!("save");
            input["content"] =
                json!({"title":fields.title,"type":fields.kind.key(),"text":fields.text});
        }
        let (out, reply) = bounded(1);
        self.write_result = None;
        self.writing = Some(edit);
        self.write = Some(reply);
        let (backend, main, window) = (backend.clone(), main.clone(), window.clone());
        platform::spawn(async move {
            let context = workspace
                .as_deref()
                .map(|workspace| (workspace, directory.as_deref()));
            let result = memory::operation(&backend, scope, context, input)
                .await
                .map_err(error_key)
                .and_then(|ack| {
                    if (save
                        && ack["id"] == entry_id
                        && ack["revision"].as_str().is_some_and(|r| r.len() == 64))
                        || (!save && ack["deleted"] == true)
                    {
                        Ok(())
                    } else {
                        Err(UNAVAILABLE)
                    }
                });
            let _ = out.send(result).await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
    }

    pub fn view<S: 'static>(
        &self,
        project: Option<&Target>,
        open: impl Fn(&mut S, Edit) + Clone + 'static,
        act: impl Fn(&mut S, Action) + Clone + 'static,
    ) -> El {
        let scope = self.scope(project);
        let choose = act.clone();
        let scopes = if project.is_some() || scope == Scope::Project {
            chrome::segments(
                t("settings.memory.scope"),
                &[t("settings.memory.global"), t("settings.memory.project")],
                Some(usize::from(scope == Scope::Project)),
                false,
                move |s, i| {
                    choose(
                        s,
                        Action::Scope(if i == 0 {
                            Scope::Global
                        } else {
                            Scope::Project
                        }),
                    )
                },
            )
        } else {
            text(t("settings.memory.global"))
        };
        let tidy = act.clone();
        let mut panel = col()
            .full_width()
            .separate(Space::Sm)
            .child(
                layout::action_row()
                    .child(scopes)
                    .children(project.map(|_| {
                        layout::button(
                            t("settings.memory.tidy"),
                            self.cleanup_intent(project).is_none(),
                            move |s| tidy(s, Action::Tidy),
                        )
                        .help(t("settings.memory.tidyInfo"))
                    })),
            )
            .children(
                self.tidy_failed
                    .then(|| text(t("settings.memory.tidyFailed")).role("alert").wrap()),
            );
        if scope == Scope::Project {
            match project {
                None => return panel.child(text(t("settings.memory.noProject")).role("status")),
                Some(target) if !target.online() => {
                    return panel
                        .child(text(t("settings.memory.error.unavailable")).role("status"));
                }
                _ => {}
            }
        }
        if let Some(error) = self.failed {
            let retry = act.clone();
            panel = panel.child(
                layout::action_row()
                    .child(text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("settings.memory.retry"),
                        self.flight.is_some(),
                        move |s| retry(s, Action::Retry),
                    )),
            );
        }
        let Some(list) = &self.snapshot else {
            return panel.children(
                self.flight
                    .is_some()
                    .then(|| text(t("settings.memory.loading")).role("status")),
            );
        };
        if list.entries.is_empty() {
            return panel.children(
                self.failed
                    .is_none()
                    .then(|| text(t("settings.memory.empty")).role("status")),
            );
        }
        let count = t("settings.memory.count")
            .replace("{count}", &list.entries.len().to_string())
            .replace("{limit}", &scope.limit().to_string());
        let mut label = format!("{} {count}", t("settings.memory.entries"));
        if let Some(key) = &self.key {
            for badge in [
                "settings.memory.new",
                "settings.memory.modified",
                "settings.memory.flagged",
            ] {
                if list.entries.iter().any(|entry| {
                    if badge == "settings.memory.flagged" {
                        entry.flagged
                    } else {
                        self.seen.badge(&key.server, list, entry) == Some(badge)
                    }
                }) {
                    label.push(' ');
                    label.push_str(t(badge));
                }
            }
        }
        let mut rows = col().full_width().separate(Space::Xs);
        if self.expanded {
            for entry in &list.entries {
                let Some(key) = &self.key else { break };
                let edit = Edit {
                    entry: entry.clone(),
                    key: key.clone(),
                    namespace: list.scope_key.clone(),
                };
                let read = open.clone();
                let kind = t(match entry.kind {
                    memory::Kind::Fact => "settings.memory.type.fact",
                    memory::Kind::Preference => "settings.memory.type.preference",
                    memory::Kind::Reference => "settings.memory.type.reference",
                });
                rows = rows.child(
                    layout::action_row()
                        .key(&entry.id)
                        .child(
                            layout::button(&entry.title, self.writing(), move |s| {
                                read(s, edit.clone())
                            })
                            .content_direction(),
                        )
                        .child(text(kind))
                        .children(
                            self.seen
                                .badge(&key.server, list, entry)
                                .map(|badge| text(t(badge))),
                        )
                        .children(entry.flagged.then(|| text(t("settings.memory.flagged")))),
                );
            }
        }
        panel.child(chrome::disclosure(&label, self.expanded, rows, move |s| {
            act(s, Action::Fold)
        }))
    }
}

const UNAVAILABLE: &str = "settings.memory.error.unavailable";
fn error_key(error: codenomad_client::history::Error) -> &'static str {
    error
        .downcast_ref::<memory::Refused>()
        .map_or(UNAVAILABLE, |error| error.0)
}

use super::cleanup;
