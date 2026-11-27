use super::in_app::BubbleOptions;
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
    event: Option<String>,
    error: bool,
    bubble: BubbleOptions,
}

#[cfg(test)]
impl Message {
    pub(super) fn summary(&self) -> (Category, String) {
        (self.category, self.body.clone())
    }
}

pub(crate) fn emit(
    s: &mut State,
    category: Category,
    title: Option<String>,
    body: impl Into<String>,
) {
    emit_outcome(s, category, title, body, false);
}

pub(crate) fn emit_outcome(
    s: &mut State,
    category: Category,
    title: Option<String>,
    body: impl Into<String>,
    error: bool,
) {
    let source = s
        .screen
        .launcher()
        .and_then(|launcher| launcher.connection.clone())
        .or_else(|| settings::bound_backend(s));
    if let Some(source) = source {
        enqueue(
            s,
            source,
            category,
            title,
            body.into(),
            None,
            None,
            error,
            BubbleOptions::Default,
        );
    }
}

pub(crate) fn emit_from(
    s: &mut State,
    backend: Backend,
    category: Category,
    body: String,
    error: bool,
) {
    enqueue(
        s,
        backend,
        category,
        None,
        body,
        None,
        None,
        error,
        BubbleOptions::Default,
    );
}

pub(super) fn enqueue(
    s: &mut State,
    source: Backend,
    category: Category,
    title: Option<String>,
    body: String,
    target: Option<Target>,
    event: Option<String>,
    error: bool,
    bubble: BubbleOptions,
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
        event,
        error,
        bubble,
    });
}

pub(crate) fn native(s: &mut State, source: Backend, target: Target, event: WorkspaceEvent) {
    match event {
        WorkspaceEvent::OpenCodeNotice {
            id,
            title,
            body,
            error,
            duration_ms,
        } => {
            let mut target = target;
            if target.tab.is_some() {
                target.session.clear();
            }
            enqueue(
                s,
                source,
                Category::Opencode,
                title,
                body,
                Some(target),
                Some(id),
                error,
                duration_ms.map_or(BubbleOptions::Default, BubbleOptions::Toast),
            );
        }
        _ => {}
    }
}

pub(super) fn compaction(label: &str) -> String {
    crate::strings::t("sessionEvents.sessionCompactedToast")
        .replace("{label}", &format!("\"{label}\""))
}

fn claim(
    queue: &mut std::collections::VecDeque<(Target, Category, String)>,
    target: &Target,
    category: Category,
    id: &str,
) -> bool {
    if queue.iter().any(|(owner, event, seen)| {
        owner.same_event_scope(target) && *event == category && seen == id
    }) {
        return false;
    }
    if queue.len() >= RETAINED * 2 {
        queue.pop_front();
    }
    queue.push_back((target.clone(), category, id.into()));
    true
}

pub(super) fn claim_routes(
    host: &mut super::Host,
    target: &Target,
    category: Category,
    id: &str,
    route: &mut crate::settings::notification_routing::Route,
    allow_focused: bool,
) {
    route.system = route.system
        && (allow_focused || !host.focused())
        && claim(&mut host.delivered, target, category, id);
    if (route.screen || route.history) && !claim(&mut host.app_delivered, target, category, id) {
        route.screen = false;
        route.history = false;
    }
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
        let (mut route, allow_focused) =
            match settings::notification_route(s, &message.source, message.category) {
                ConfirmedRoute::Refreshing => {
                    s.notifications.messages.push_back(message);
                    continue;
                }
                ConfirmedRoute::Missing if message.error => (
                    crate::settings::notification_routing::Route {
                        screen: true,
                        history: true,
                        system: false,
                    },
                    false,
                ),
                ConfirmedRoute::Ready(route, allow_focused) => (route, allow_focused),
                _ => continue,
            };
        route.screen |= message.error;
        route.history |= message.error;
        if !route.screen
            && !route.history
            && (!route.system || !allow_focused && s.notifications.focused())
        {
            continue;
        }
        if let (Some(target), Some(id)) = (&message.target, &message.event) {
            claim_routes(
                &mut s.notifications,
                target,
                message.category,
                id,
                &mut route,
                allow_focused,
            );
        }
        publish(
            s,
            &message.title,
            &message.body,
            message
                .target
                .filter(|target| message.category != Category::Opencode || target.tab.is_some()),
            route,
            allow_focused,
            message.bubble,
        );
    }
}

pub(super) fn publish(
    s: &mut State,
    title: &str,
    body: &str,
    target: Option<Target>,
    route: crate::settings::notification_routing::Route,
    allow_focused: bool,
    bubble: BubbleOptions,
) {
    let host = &mut s.notifications;
    if route.history || route.screen {
        host.in_app
            .push(title, body, target.clone(), &route, bubble);
    }
    if !route.system || !allow_focused && host.focused() {
        return;
    }
    if let Some(target) = target {
        host.present(title, body, target, s.wake.clone());
    } else {
        let id = host.next_id;
        host.next_id += 1;
        if let Some(presented) = host.show_system(id, title, body, || {}) {
            if host.system_messages.len() >= RETAINED {
                host.system_messages.pop_front();
            }
            host.system_messages.push_back(presented);
        }
    }
}
