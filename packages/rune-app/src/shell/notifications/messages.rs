use super::{Category, RETAINED, Target};
use crate::{
    State,
    backend::Backend,
    settings::{self, ConfirmedRoute},
};
use codenomad_client::transport::WorkspaceEvent;

pub(super) struct Message {
    source: Backend,
    category: Category,
    title: String,
    body: String,
    target: Option<Target>,
}

pub(crate) fn emit(
    s: &mut State,
    category: Category,
    title: Option<String>,
    body: impl Into<String>,
) {
    let source = s
        .screen
        .launcher()
        .and_then(|launcher| launcher.connection.clone())
        .or_else(|| settings::bound_backend(s));
    if let Some(source) = source {
        enqueue(s, source, category, title, body.into(), None);
    }
}

pub(super) fn enqueue(
    s: &mut State,
    source: Backend,
    category: Category,
    title: Option<String>,
    body: String,
    target: Option<Target>,
) {
    let body: String = body.trim().chars().take(4096).collect();
    if body.is_empty() {
        return;
    }
    let queue = &mut s.notifications.messages;
    if queue.len() >= RETAINED {
        queue.pop_front();
    }
    queue.push_back(Message {
        source,
        category,
        title: title
            .unwrap_or_else(|| crate::strings::t("window.title.main").into())
            .trim()
            .chars()
            .take(256)
            .collect(),
        body,
        target,
    });
}

pub(crate) fn native(
    s: &mut State,
    source: Backend,
    target: Target,
    project: String,
    event: WorkspaceEvent,
) {
    match event {
        WorkspaceEvent::OpenCodeNotice { id, title, body } => {
            if !claim(s, &target, Category::Opencode, &id) {
                return;
            }
            let mut target = target;
            target.session.clear();
            enqueue(
                s,
                source,
                Category::Opencode,
                title,
                body,
                target.tab.is_some().then_some(target),
            );
        }
        WorkspaceEvent::SessionCompacted { id } => {
            let label = s.chat_title.trim();
            let label = if label.is_empty() {
                target.session.as_str()
            } else {
                label
            };
            let body = compaction(label);
            if !claim(s, &target, Category::Sessions, &id) {
                return;
            }
            enqueue(
                s,
                source,
                Category::Sessions,
                Some(project),
                body,
                Some(target),
            );
        }
        _ => {}
    }
}

pub(super) fn compaction(label: &str) -> String {
    crate::strings::t("sessionEvents.sessionCompactedToast")
        .replace("{label}", &format!("\"{label}\""))
}

pub(super) fn claim(s: &mut State, target: &Target, category: Category, id: &str) -> bool {
    let host = &mut s.notifications;
    if host.already_delivered(target, category, id) {
        return false;
    }
    if host.delivered.len() >= RETAINED * 2 {
        host.delivered.pop_front();
    }
    host.delivered
        .push_back((target.clone(), category, id.into()));
    true
}

pub(super) fn poll(s: &mut State) {
    for message in std::mem::take(&mut s.notifications.messages) {
        if message
            .target
            .as_ref()
            .is_some_and(|target| !crate::workspace::owns_notification(s, target))
        {
            continue;
        }
        match settings::notification_route(s, &message.source, message.category) {
            ConfirmedRoute::Unavailable => {}
            ConfirmedRoute::Refreshing => s.notifications.messages.push_back(message),
            ConfirmedRoute::Ready(route, allow_focused)
                if route.system && (allow_focused || !s.notifications.focused()) =>
            {
                let host = &mut s.notifications;
                if let Some(target) = message.target.filter(|target| !target.session.is_empty()) {
                    host.present(&message.title, &message.body, target, s.wake.clone());
                } else {
                    let id = host.next_id;
                    host.next_id += 1;
                    if let Some(presented) =
                        host.show_system(id, &message.title, &message.body, || {})
                    {
                        if host.system_messages.len() >= RETAINED {
                            host.system_messages.pop_front();
                        }
                        host.system_messages.push_back(presented);
                    }
                }
            }
            _ => {}
        }
    }
}
