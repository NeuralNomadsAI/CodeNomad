use crate::{
    State,
    agent_api::Snapshot,
    settings::notification_routing::{self, Category},
};
use rune::Tx;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};

const RETAINED: usize = 128;

mod background;
#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub(crate) use web::with_background_wake;

#[derive(Default)]
pub(crate) struct Attention {
    requests: [HashSet<String>; 2],
    hinted: [HashSet<String>; 2],
    directory: Option<String>,
    execution: Option<(String, bool)>,
    pending: Vec<(Category, String)>,
    updated: [bool; 2],
    invalidated_completion: bool,
}

impl Attention {
    pub(crate) fn observe(&mut self, snapshot: &Snapshot, current: bool) {
        self.directory.clone_from(&snapshot.root_directory);
        if self.directory.is_none() {
            return;
        }
        if let Some(permissions) = &snapshot.permissions {
            self.observe_requests(0, permissions.iter().map(|item| item.id.clone()), current);
        }
        if let Some(forms) = &snapshot.forms {
            self.observe_requests(1, forms.iter().map(|item| item.id.clone()), current);
        }
    }

    pub(crate) fn execution(&mut self, notice: Option<String>) {
        if let Some(id) = &notice
            && self
                .execution
                .as_ref()
                .is_some_and(|(previous, _)| previous == id)
        {
            return;
        }
        self.execution = notice.map(|id| (id, false));
        self.invalidate_completion();
    }

    pub(crate) fn verify_idle(&mut self) -> Option<(String, String)> {
        let (id, sent) = self.execution.as_mut()?;
        let directory = self.directory.clone()?;
        if std::mem::replace(sent, true) {
            return None;
        }
        Some((id.clone(), directory))
    }

    pub(crate) fn disconnected(&mut self) {
        self.execution = None;
        self.directory = None;
        self.hinted.iter_mut().for_each(HashSet::clear);
        self.invalidate_completion();
    }

    fn invalidate_completion(&mut self) {
        self.invalidated_completion = true;
        self.pending
            .retain(|(event, _)| *event != Category::SessionDone);
    }

    pub(crate) fn request(&mut self, form: bool, id: String) {
        let hinted = &mut self.hinted[usize::from(form)];
        if hinted.len() < RETAINED {
            hinted.insert(id);
        }
    }

    pub(crate) fn confirm_idle(&mut self, id: String, inactive: bool) {
        if self
            .execution
            .as_ref()
            .is_some_and(|(current, _)| current == &id)
        {
            self.execution = None;
            if inactive && self.pending.len() < RETAINED {
                self.pending.push((Category::SessionDone, id));
            }
        }
    }

    fn observe_requests(
        &mut self,
        kind: usize,
        ids: impl Iterator<Item = String>,
        authoritative: bool,
    ) {
        self.updated[kind] = true;
        let current: HashSet<_> = ids.collect();
        let capacity = RETAINED.saturating_sub(self.pending.len());
        let hinted = &mut self.hinted[kind];
        self.pending.extend(
            hinted
                .intersection(&current)
                .take(capacity)
                .map(|id| (Category::NeedsInput, format!("{kind}:{id}"))),
        );
        hinted.retain(|id| !authoritative && !current.contains(id));
        self.requests[kind] = current;
    }
}

fn request_present(key: &str, updated: [bool; 2], requests: &[HashSet<String>; 2]) -> bool {
    match key.split_once(':') {
        Some(("0", id)) if updated[0] => requests[0].contains(id),
        Some(("1", id)) if updated[1] => requests[1].contains(id),
        _ => true,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub tab: Option<String>,
    pub backend_url: String,
    pub server: Option<String>,
    pub occurrence: u64,
    pub workspace: String,
    pub session: String,
}

impl Target {
    fn same_event_scope(&self, other: &Self) -> bool {
        self.session == other.session
            && match (&self.server, &other.server) {
                (Some(a), Some(b)) => a == b,
                (None, None) => self.backend_url == other.backend_url,
                _ => false,
            }
    }
}

pub(crate) struct Host {
    focused: bool,
    routes: VecDeque<(u64, Target, Presented)>,
    delivered: VecDeque<(Target, Category, String)>,
    deferred: VecDeque<Notice>,
    background_attention: background::Background,
    activation: Option<(Target, bool)>,
    click_check: Option<(Target, codenomad_client::Receiver<bool>)>,
    click_wait: Option<Target>,
    next_id: u64,
    clicks: codenomad_client::Receiver<u64>,
    send_click: codenomad_client::Sender<u64>,
    #[cfg(target_os = "windows")]
    pub(crate) window: Option<rune::WindowHandle>,
    #[cfg(target_os = "windows")]
    pub(crate) native: Option<crate::platform::notifications::Delivery>,
    #[cfg(target_arch = "wasm32")]
    pub(crate) background: Option<rune_theme_codenomad::shell::WindowFeed<State>>,
    #[cfg(test)]
    recorded: Option<Vec<(u64, String, String)>>,
}

struct Notice {
    target: Target,
    category: Category,
    id: String,
    project: String,
    label: String,
}

enum Presented {
    #[cfg(any(target_os = "windows", target_arch = "wasm32"))]
    Native {
        _presented: crate::platform::notifications::Presented,
    },
    #[cfg(test)]
    Recorded(Option<Box<dyn FnOnce() + Send>>),
}

impl Default for Host {
    fn default() -> Self {
        let (send_click, clicks) = codenomad_client::bounded(RETAINED);
        Self {
            focused: true,
            routes: VecDeque::new(),
            delivered: VecDeque::new(),
            deferred: VecDeque::new(),
            background_attention: Default::default(),
            activation: None,
            click_check: None,
            click_wait: None,
            next_id: 0,
            clicks,
            send_click,
            #[cfg(target_os = "windows")]
            window: None,
            #[cfg(target_os = "windows")]
            native: None,
            #[cfg(target_arch = "wasm32")]
            background: None,
            #[cfg(test)]
            recorded: None,
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn native_delivery() -> Option<crate::platform::notifications::Delivery> {
    if !rune_theme_codenomad::shell::live_caption() || cfg!(any(test, feature = "test-support")) {
        return None;
    }
    let profile = crate::platform::setting("CODENOMAD_PROFILE");
    let profile = profile
        .as_deref()
        .map(crate::host::profile_name)
        .transpose()
        .ok()?;
    crate::platform::notifications::Delivery::for_rune_profile(profile.as_deref()).ok()
}

impl Host {
    pub(crate) fn supersede_navigation(&mut self) {
        self.activation = None;
        self.click_check = None;
        self.click_wait = None;
        while let Ok(id) = self.clicks.try_recv() {
            self.routes.retain(|(entry, _, _)| *entry != id);
        }
    }

    fn already_delivered(&self, target: &Target, category: Category, id: &str) -> bool {
        self.delivered.iter().any(|(owner, event, seen)| {
            owner.same_event_scope(target) && *event == category && seen == id
        })
    }
    pub(crate) fn forget_tab(&mut self, tab: &str) {
        let keeps = |target: &Target| target.tab.as_deref() != Some(tab);
        self.routes.retain(|(_, target, _)| keeps(target));
        self.deferred.retain(|notice| keeps(&notice.target));
    }

    fn focused(&self) -> bool {
        #[cfg(target_arch = "wasm32")]
        return web::focused();
        #[cfg(not(target_arch = "wasm32"))]
        self.focused
    }

    pub(crate) fn present(&mut self, title: &str, body: &str, target: Target, wake: rune::Waker) {
        let id = self.next_id;
        self.next_id += 1;
        let clicks = self.send_click.clone();
        let action = move || {
            if clicks.try_send(id).is_ok() {
                wake();
            }
        };
        #[cfg(test)]
        let fake = self.recorded.as_mut().map(|recorded| {
            recorded.push((id, title.into(), body.into()));
            Presented::Recorded(Some(Box::new(action.clone())))
        });
        #[cfg(not(test))]
        let fake = None;
        let presented = fake.or_else(|| {
            #[cfg(target_os = "windows")]
            return self
                .native
                .as_ref()?
                .show(title, body, action)
                .ok()
                .flatten()
                .map(|_presented| Presented::Native { _presented });
            #[cfg(target_arch = "wasm32")]
            return web::present(title, body, action);
            #[cfg(not(any(target_os = "windows", target_arch = "wasm32")))]
            {
                let _ = (title, body, action);
                None
            }
        });
        if let Some(presented) = presented {
            self.routes.push_back((id, target, presented));
            if self.routes.len() > RETAINED {
                self.routes.pop_front();
            }
        }
    }

    fn focus(&self) {
        #[cfg(target_os = "windows")]
        if let Some(window) = &self.window {
            window.focus();
        }
    }

    #[cfg(test)]
    pub(crate) fn record(&mut self) {
        self.recorded = Some(Vec::new());
    }

    #[cfg(test)]
    pub(crate) fn recorded(&self) -> &[(u64, String, String)] {
        self.recorded.as_deref().unwrap()
    }

    #[cfg(test)]
    pub(crate) fn simulate_click(&mut self, id: u64) {
        if let Some((_, _, Presented::Recorded(action))) =
            self.routes.iter_mut().find(|(entry, _, _)| *entry == id)
            && let Some(action) = action.take()
        {
            action();
        }
    }
}

pub(crate) fn focus_changed(s: &mut State, focused: bool, _: &mut Tx) {
    s.notifications.focused = focused;
}

pub(crate) fn collect(s: &mut State, target: impl FnOnce(&State) -> Option<(Target, String)>) {
    let Some(agent) = &mut s.agent else { return };
    if agent.attention.pending.is_empty()
        && agent.attention.updated == [false; 2]
        && !agent.attention.invalidated_completion
    {
        return;
    }
    let pending = std::mem::take(&mut agent.attention.pending);
    let updated = std::mem::take(&mut agent.attention.updated);
    let invalidated_completion = std::mem::take(&mut agent.attention.invalidated_completion);
    let online = agent.online;
    let running = agent.running;
    let Some((target, project)) = target(s) else {
        return;
    };
    if invalidated_completion || running {
        s.notifications
            .deferred
            .retain(|notice| notice.target != target || notice.category != Category::SessionDone);
    }
    if !online {
        return;
    }
    if updated != [false; 2] {
        let requests = &s.agent.as_ref().unwrap().attention.requests;
        s.notifications.deferred.retain(|notice| {
            notice.target != target
                || notice.category != Category::NeedsInput
                || request_present(&notice.id, updated, requests)
        });
    }
    let label = if s.chat_title.trim().is_empty() {
        target.session.clone()
    } else {
        s.chat_title.clone()
    };
    for (category, id) in pending {
        if running && matches!(category, Category::SessionDone) {
            continue;
        }
        deliver(
            s,
            Notice {
                target: target.clone(),
                category,
                id,
                project: project.clone(),
                label: label.clone(),
            },
        );
    }
}

fn deliver(s: &mut State, notice: Notice) {
    use crate::settings::Delivery;
    let Notice {
        target,
        category,
        id,
        project,
        label,
    } = &notice;
    let shelf = &s.notifications;
    if shelf.already_delivered(target, *category, id) {
        return;
    }
    let body =
        match crate::settings::system_notification(s, target, *category, shelf.focused(), label) {
            Delivery::Body(body) => body,
            Delivery::Suppressed => return,
            Delivery::WaitingForSettings => {
                let queue = &mut s.notifications.deferred;
                if !queue.iter().any(|entry| {
                    entry.target == *target && entry.category == *category && entry.id == *id
                }) {
                    if queue.len() >= RETAINED {
                        queue.pop_front();
                    }
                    queue.push_back(notice);
                }
                return;
            }
        };
    let delivered = &mut s.notifications.delivered;
    if delivered.len() >= RETAINED * 2 {
        delivered.pop_front();
    }
    delivered.push_back((target.clone(), *category, id.clone()));
    s.notifications
        .present(project, &body, target.clone(), s.wake.clone());
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    use crate::workspace::Activation;
    background::poll(s);
    let notices = std::mem::take(&mut s.notifications.deferred);
    for notice in notices {
        if crate::workspace::observes_notification(
            s,
            &notice.target,
            notice.category == Category::NeedsInput,
        ) {
            deliver(s, notice);
        }
    }
    if s.notifications.routes.is_empty()
        && s.notifications.activation.is_none()
        && s.notifications.click_check.is_none()
        && s.notifications.click_wait.is_none()
    {
        return false;
    }
    let mut routes = std::mem::take(&mut s.notifications.routes);
    routes.retain(|(_, target, _)| crate::workspace::owns_notification(s, target));
    s.notifications.routes = routes;
    let mut target = s.notifications.activation.take();
    while let Ok(id) = s.notifications.clicks.try_recv() {
        let Some(index) = s
            .notifications
            .routes
            .iter()
            .position(|(entry, _, _)| *entry == id)
        else {
            continue;
        };
        let (_, clicked, presented) = s.notifications.routes.remove(index).unwrap();
        drop(presented);
        target = None;
        s.notifications.click_wait = None;
        s.notifications.click_check =
            crate::workspace::check_notification(s, &clicked).map(|check| (clicked, check));
    }
    if let Some(waiting) = s.notifications.click_wait.take()
        && crate::workspace::owns_notification(s, &waiting)
    {
        if crate::workspace::can_switch_for_notification(s, &waiting) {
            s.notifications.click_check =
                crate::workspace::check_notification(s, &waiting).map(|check| (waiting, check));
        } else {
            s.notifications.click_wait = Some(waiting);
        }
    }
    if let Some((clicked, check)) = s.notifications.click_check.take()
        && crate::workspace::owns_notification(s, &clicked)
    {
        match check.try_recv() {
            Ok(true) if crate::workspace::can_switch_for_notification(s, &clicked) => {
                s.notifications.focus();
                target = Some((clicked, false));
            }
            Ok(true) => s.notifications.click_wait = Some(clicked),
            Err(codenomad_client::TryRecvError::Empty) => {
                s.notifications.click_check = Some((clicked, check))
            }
            _ => {}
        }
    }
    let Some((target, mut started)) = target else {
        return false;
    };
    let before = s.workspace.as_ref().map(|ui| ui.active_key().to_owned());
    match crate::workspace::open_notification(s, &target, &mut started, tx) {
        Activation::Wait => {
            s.notifications.activation = Some((target, started));
            before.as_deref() != s.workspace.as_ref().map(|ui| ui.active_key())
        }
        Activation::Opened => true,
        Activation::Gone => false,
    }
}

pub(crate) fn system_allowed(config: Option<&Value>, category: Category, focused: bool) -> bool {
    notification_routing::route(config, category).is_some_and(|route| route.system)
        && (!focused || notification_routing::allow_focused(config))
}

#[cfg(test)]
mod tests;
