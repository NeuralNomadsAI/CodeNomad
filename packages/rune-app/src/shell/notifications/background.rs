use super::{Category, Notice, RETAINED, Target, deliver};
use crate::{State, settings::Delivery};
use codenomad_client::{
    Receiver, TryRecvError, bounded, stream::AttentionHint, transport::WorkspaceEvent,
};
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Background {
    generation: u64,
    waiting: VecDeque<Cue>,
    reading: Vec<(Cue, Receiver<Option<String>>)>,
}

struct Cue {
    target: Target,
    project: String,
    category: Category,
    id: String,
    request: Option<bool>,
    backend: crate::backend::Backend,
}

impl Cue {
    fn current(&self, s: &State) -> bool {
        crate::workspace::workspace_notification(s, &self.target.workspace, &self.target.session)
            .is_some_and(|(target, _, backend)| {
                target == self.target && backend.client.same_connection(&self.backend.client)
            })
    }

    fn verify(self, s: &State) -> (Self, Receiver<Option<String>>) {
        let (out, reply) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let backend = self.backend.clone();
        let self_category = self.category;
        let kind = self
            .request
            .zip(self.id.split_once(':').map(|(_, id)| id.to_owned()));
        let (reads, wake) = (s.reads.clone(), s.wake.clone());
        crate::platform::spawn(async move {
            let work = async {
                let _slot = reads.background(&cancelled).await?;
                if self_category == Category::Sessions {
                    backend.notification_label().await
                } else {
                    backend
                        .notification_session(kind.as_ref().map(|(form, id)| (*form, id.as_str())))
                        .await
                }
            };
            let label = codenomad_client::runtime::until_closed(&out, work).await;
            drop(cancel);
            if let Some(label) = label {
                let _ = out.try_send(label);
                wake();
            }
        });
        (self, reply)
    }

    fn same_event(&self, other: &Self) -> bool {
        self.target == other.target && self.category == other.category && self.id == other.id
    }
}

impl Background {
    fn observe(&mut self, s: &mut State, hint: AttentionHint) {
        let Some((target, project, backend)) =
            crate::workspace::workspace_notification(s, &hint.workspace, &hint.session)
        else {
            return;
        };
        let (category, id, request) = match hint.event {
            WorkspaceEvent::SessionCompacted { id } => (Category::Sessions, id, None),
            event @ WorkspaceEvent::OpenCodeNotice { .. } => {
                super::messages::native(s, backend, target, project, event);
                return;
            }
            WorkspaceEvent::SessionRequest { form, id } => (
                Category::NeedsInput,
                format!("{}:{id}", usize::from(form)),
                Some(form),
            ),
            WorkspaceEvent::SessionRequestResolved { form, id } => {
                let id = format!("{}:{id}", usize::from(form));
                let keep = |cue: &Cue| {
                    !cue.target.same_event_scope(&target)
                        || cue.category != Category::NeedsInput
                        || cue.id != id
                };
                self.waiting.retain(keep);
                self.reading.retain(|(cue, _)| keep(cue));
                return;
            }
            WorkspaceEvent::SessionExecution { notice } => {
                let older = |cue: &Cue| {
                    cue.target.same_event_scope(&target)
                        && cue.category == Category::SessionDone
                        && notice.as_deref() != Some(cue.id.as_str())
                };
                self.waiting.retain(|cue| !older(cue));
                self.reading.retain(|(cue, _)| !older(cue));
                let Some(id) = notice else { return };
                (Category::SessionDone, id, None)
            }
            _ => return,
        };
        let cue = Cue {
            target,
            project,
            category,
            id,
            request,
            backend,
        };
        if self.waiting.iter().any(|other| cue.same_event(other))
            || self.reading.iter().any(|(other, _)| cue.same_event(other))
        {
            return;
        }
        if self.waiting.len() >= RETAINED {
            self.waiting.pop_front();
        }
        self.waiting.push_back(cue);
    }
}

pub(super) fn poll(s: &mut State) {
    let mut pending = std::mem::take(&mut s.notifications.background_attention);
    if let Some(watch) = s
        .screen
        .launcher()
        .and_then(|launcher| launcher.catalogue_watch.as_ref())
    {
        let (generation, hints) = watch.take_attention();
        if generation != pending.generation {
            pending = Background {
                generation,
                ..Default::default()
            };
        }
        for hint in hints {
            pending.observe(s, hint);
        }
    } else {
        return;
    }
    let policy = |s: &State, cue: &Cue| {
        if cue.category == Category::Sessions {
            return match crate::settings::notification_route(s, &cue.backend, cue.category) {
                crate::settings::ConfirmedRoute::Refreshing => Delivery::WaitingForSettings,
                crate::settings::ConfirmedRoute::Ready(route, allow_focused)
                    if route.system && (allow_focused || !s.notifications.focused()) =>
                {
                    Delivery::Body(String::new())
                }
                _ => Delivery::Suppressed,
            };
        }
        crate::settings::system_notification(
            s,
            &cue.target,
            cue.category,
            s.notifications.focused(),
            "",
        )
    };
    for (cue, reply) in std::mem::take(&mut pending.reading) {
        if !cue.current(s)
            || s.notifications
                .already_delivered(&cue.target, cue.category, &cue.id)
        {
            continue;
        }
        match reply.try_recv() {
            Ok(Some(label)) => match policy(s, &cue) {
                Delivery::WaitingForSettings => {
                    if pending.waiting.len() >= RETAINED {
                        pending.waiting.pop_front();
                    }
                    pending.waiting.push_back(cue);
                }
                Delivery::Suppressed => {}
                Delivery::Body(_) if cue.category == Category::Sessions => {
                    super::messages::enqueue(
                        s,
                        cue.backend,
                        cue.category,
                        Some(cue.project),
                        super::messages::compaction(&label),
                        Some(cue.target),
                        Some(cue.id),
                    );
                }
                Delivery::Body(_) => deliver(
                    s,
                    Notice {
                        target: cue.target,
                        project: cue.project,
                        category: cue.category,
                        id: cue.id,
                        label,
                    },
                ),
            },
            Err(TryRecvError::Empty) => pending.reading.push((cue, reply)),
            _ => {}
        }
    }
    while pending.reading.len() < 2 {
        let Some(cue) = pending.waiting.pop_front() else {
            break;
        };
        if !cue.current(s)
            || s.notifications
                .already_delivered(&cue.target, cue.category, &cue.id)
        {
            continue;
        }
        match policy(s, &cue) {
            Delivery::Suppressed => {}
            Delivery::WaitingForSettings => {
                pending.waiting.push_front(cue);
                break;
            }
            Delivery::Body(_) => pending.reading.push(cue.verify(s)),
        }
    }
    s.notifications.background_attention = pending;
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::files::test_http::{Http, wait};
    use serde_json::json;

    #[test]
    fn root_requests_are_verified_without_binding_the_window_to_their_session() {
        crate::platform::block_on(async {
            let http = Http::new().await;
            let state = crate::init();
            for (session, parent) in [("ses_root", None), ("ses_child", Some("ses_parent"))] {
                let mut backend = http.backend.clone();
                backend.session = session.into();
                let (_, reply) = Cue {
                    target: Target {
                        tab: Some("other-tab".into()),
                        backend_url: backend.base.clone(),
                        server: None,
                        occurrence: 1,
                        workspace: backend.workspace.clone(),
                        session: session.into(),
                    },
                    project: "Project".into(),
                    category: Category::NeedsInput,
                    id: "1:question".into(),
                    request: Some(true),
                    backend,
                }
                .verify(&state);
                let root = http.accept().await;
                assert!(root.header.starts_with(&format!(
                    "GET /workspaces/owned/instance/api/session/{session} HTTP/"
                )));
                root.reply(200, json!({"data":{"id":session,"parentID":parent,"title":"Unselected root","location":{"directory":"/private"}}})).await;
                if parent.is_none() {
                    let pending = http.accept().await;
                    assert!(pending.header.starts_with(
                        "GET /workspaces/owned/instance/api/session/ses_root/form HTTP/"
                    ));
                    pending.reply(200, json!({"data":[{"id":"question","sessionID":"ses_root","title":"Choice","fields":[{}]}]})).await;
                    assert_eq!(
                        wait(reply.recv()).await.unwrap().as_deref(),
                        Some("Unselected root")
                    );
                } else {
                    assert!(wait(reply.recv()).await.unwrap().is_none());
                    http.quiet().await;
                }
            }
            assert!(state.workspace.is_none());
        });
    }
}
