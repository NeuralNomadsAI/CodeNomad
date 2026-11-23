use crate::{
    State,
    agent_api::Snapshot,
    settings::notification_routing::{self, Category},
};
use rune::Tx;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};

const RETAINED: usize = 128;

#[derive(Default)]
pub(crate) struct Attention {
    requests: [HashSet<String>; 2],
    directory: Option<String>,
    execution: Option<(String, bool)>,
    pending: Vec<(Category, String)>,
}

impl Attention {
    pub(crate) fn observe(&mut self, snapshot: &Snapshot) {
        self.directory.clone_from(&snapshot.root_directory);
        if self.directory.is_none() {
            return;
        }
        if let Some(permissions) = &snapshot.permissions {
            self.observe_requests(0, permissions.iter().map(|item| item.id.clone()));
        }
        if let Some(forms) = &snapshot.forms {
            self.observe_requests(1, forms.iter().map(|item| item.id.clone()));
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

    fn observe_requests(&mut self, kind: usize, ids: impl Iterator<Item = String>) {
        let current: HashSet<_> = ids.collect();
        let capacity = RETAINED.saturating_sub(self.pending.len());
        self.pending.extend(
            current
                .difference(&self.requests[kind])
                .take(capacity)
                .map(|id| (Category::NeedsInput, format!("{kind}:{id}"))),
        );
        self.requests[kind] = current;
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

pub(crate) struct Host {
    focused: bool,
    routes: VecDeque<(u64, Target, Presented)>,
    delivered: VecDeque<(Target, Category, String)>,
    activation: Option<(Target, std::rc::Rc<()>)>,
    next_id: u64,
    clicks: codenomad_client::Receiver<u64>,
    send_click: codenomad_client::Sender<u64>,
    #[cfg(target_os = "windows")]
    pub(crate) window: Option<rune::WindowHandle>,
    #[cfg(target_os = "windows")]
    pub(crate) native: Option<crate::platform::notifications::Delivery>,
    #[cfg(target_arch = "wasm32")]
    pub(crate) background: Option<rune::AppHandle<State>>,
    #[cfg(test)]
    recorded: Option<Vec<(u64, String, String)>>,
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
            activation: None,
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
    fn focused(&self) -> bool {
        #[cfg(target_arch = "wasm32")]
        return crate::platform::notifications::focused();
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
            return crate::platform::notifications::show(title, body, action)
                .map(|_presented| Presented::Native { _presented });
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

#[cfg(target_arch = "wasm32")]
pub(crate) fn with_background_wake(s: &mut State, wake: rune::Waker) -> rune::Waker {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering::Relaxed},
    };
    let Some(handle) = s.notifications.background.take() else {
        return wake;
    };
    let scheduled = Arc::new(AtomicBool::new(false));
    Arc::new(move || {
        if !crate::platform::notifications::hidden() {
            wake();
        } else if !scheduled.swap(true, Relaxed) {
            let scheduled = scheduled.clone();
            // On Web, AppHandle updates are drained by the user event, before the RAF.
            handle.update_if(move |s, tx| {
                scheduled.store(false, Relaxed);
                let mut changed = crate::poll_chat(s, 64);
                collect(s, crate::workspace::notification_target);
                changed |= crate::workspace::poll_cached_notifications(s, tx);
                changed | poll(s, tx)
            });
        }
    })
}

pub(crate) fn collect(s: &mut State, target: impl FnOnce(&State) -> Option<(Target, String)>) {
    let Some(agent) = &mut s.agent else { return };
    if agent.attention.pending.is_empty() {
        return;
    }
    let pending = std::mem::take(&mut agent.attention.pending);
    if !agent.online {
        return;
    }
    let running = agent.running;
    let Some((target, project)) = target(s) else {
        return;
    };
    let label = if s.chat_title.trim().is_empty() {
        &target.session
    } else {
        &s.chat_title
    };
    let focused = s.notifications.focused();
    for (category, id) in pending {
        if running && matches!(category, Category::SessionDone) {
            continue;
        }
        if s.notifications
            .delivered
            .iter()
            .any(|(owner, event, seen)| owner == &target && *event == category && seen == &id)
        {
            continue;
        }
        s.notifications
            .delivered
            .push_back((target.clone(), category, id));
        if s.notifications.delivered.len() > RETAINED * 2 {
            s.notifications.delivered.pop_front();
        }
        let Some(body) = crate::settings::system_notification(s, &target, category, focused, label)
        else {
            continue;
        };
        s.notifications
            .present(&project, &body, target.clone(), s.wake.clone());
    }
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    use crate::workspace::Activation;
    if s.notifications.routes.is_empty() && s.notifications.activation.is_none() {
        return false;
    }
    let mut routes = std::mem::take(&mut s.notifications.routes);
    routes.retain(|(_, target, _)| crate::workspace::owns_notification(s, target));
    s.notifications.routes = routes;
    let mut target = s
        .notifications
        .activation
        .take()
        .filter(|(_, scope)| s.current_scope(scope))
        .map(|(target, _)| target);
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
        s.notifications.focus();
        target = Some(clicked);
    }
    let Some(target) = target else { return false };
    let before = s.workspace.as_ref().map(|ui| ui.active_key().to_owned());
    match crate::workspace::open_notification(s, &target, tx) {
        Activation::Wait => {
            s.notifications.activation = Some((target, s.input_scope.clone()));
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_delivery_requires_confirmed_routing_and_the_focus_override() {
        let defaults = json!({});
        let allow = json!({"settings":{"osNotificationsAllowWhenVisible":true}});
        let disabled = json!({"settings":{"notificationRouting":{"needsInput":{"system":false}}}});
        assert!(!system_allowed(None, Category::NeedsInput, false));
        assert!(!system_allowed(
            Some(&disabled),
            Category::NeedsInput,
            false
        ));
        assert!(!system_allowed(Some(&defaults), Category::NeedsInput, true));
        assert!(system_allowed(Some(&defaults), Category::NeedsInput, false));
        assert!(system_allowed(Some(&allow), Category::SessionDone, true));
    }

    #[test]
    fn notification_observation_requires_a_root_and_a_new_confirmed_idle() {
        use crate::agent_api::Form;
        let mut attention = Attention::default();
        let mut snapshot = Snapshot {
            models: None,
            current: None,
            session_known: true,
            running: false,
            root_directory: None,
            permissions: None,
            forms: Some(vec![Form {
                id: "form-1".into(),
                title: "Question".into(),
                fields: vec![],
            }]),
        };
        attention.observe(&snapshot);
        assert!(attention.pending.is_empty());
        snapshot.root_directory = Some("/checkout".into());
        attention.observe(&snapshot);
        attention.observe(&snapshot);
        assert_eq!(attention.pending.len(), 1);
        attention.execution(Some("done".into()));
        assert_eq!(
            attention.verify_idle(),
            Some(("done".into(), "/checkout".into()))
        );
        assert!(attention.verify_idle().is_none());
        attention.execution(None);
        attention.confirm_idle("done".into(), true);
        assert_eq!(attention.pending.len(), 1);
        attention.execution(Some("next".into()));
        attention.confirm_idle("next".into(), true);
        assert!(matches!(
            attention.pending.as_slice(),
            [(Category::NeedsInput, _), (Category::SessionDone, _)]
        ));
    }
}
