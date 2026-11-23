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
    last_idle: Option<u64>,
    verify_idle: Option<u64>,
    pending: Vec<Category>,
}

impl Attention {
    pub(crate) fn observe(&mut self, snapshot: &Snapshot, current_activity: bool) {
        let Some(activity) = snapshot.root_activity else {
            return;
        };
        if let Some(permissions) = &snapshot.permissions {
            self.observe_requests(0, permissions.iter().map(|item| item.id.clone()));
        }
        if let Some(forms) = &snapshot.forms {
            self.observe_requests(1, forms.iter().map(|item| item.id.clone()));
        }
        if current_activity {
            let idle = activity.idle.unwrap_or(0);
            if self.last_idle.is_some_and(|previous| {
                idle > previous
                    && activity
                        .busy
                        .is_some_and(|busy| busy >= previous && busy < idle)
            }) {
                self.verify_idle = Some(idle);
            }
            self.last_idle = Some(self.last_idle.map_or(idle, |previous| previous.max(idle)));
        }
    }

    pub(crate) fn take_idle_verification(&mut self) -> Option<u64> {
        self.verify_idle.take()
    }

    pub(crate) fn confirm_idle(&mut self, idle: u64) {
        if self.last_idle == Some(idle) && self.pending.len() < RETAINED {
            self.pending.push(Category::SessionDone);
        }
    }

    fn observe_requests(&mut self, kind: usize, ids: impl Iterator<Item = String>) {
        let current: HashSet<_> = ids.collect();
        let added = current.difference(&self.requests[kind]).count();
        let capacity = RETAINED.saturating_sub(self.pending.len());
        self.pending.extend(std::iter::repeat_n(
            Category::NeedsInput,
            added.min(capacity),
        ));
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
    next_id: u64,
    clicks: codenomad_client::Receiver<u64>,
    send_click: codenomad_client::Sender<u64>,
    #[cfg(target_os = "windows")]
    window: Option<rune::WindowHandle>,
    #[cfg(target_os = "windows")]
    native: Option<crate::platform::notifications::Delivery>,
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
            next_id: 0,
            clicks,
            send_click,
            #[cfg(target_os = "windows")]
            window: None,
            #[cfg(target_os = "windows")]
            native: None,
            #[cfg(test)]
            recorded: None,
        }
    }
}

impl Host {
    #[cfg(target_os = "windows")]
    pub(crate) fn attach(&mut self, window: rune::WindowHandle) {
        if rune_theme_codenomad::shell::live_caption() && !cfg!(any(test, feature = "test-support"))
        {
            self.routes.clear();
            let profile = crate::platform::setting("CODENOMAD_PROFILE");
            let profile = profile
                .as_deref()
                .map(crate::host::profile_name)
                .transpose();
            self.native = profile.ok().and_then(|profile| {
                crate::platform::notifications::Delivery::for_rune_profile(profile.as_deref()).ok()
            });
            self.window = Some(window);
        }
    }

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
    for category in pending {
        if running && matches!(category, Category::SessionDone) {
            continue;
        }
        let Some(body) = crate::settings::system_notification(s, category, focused, label) else {
            continue;
        };
        s.notifications
            .present(&project, &body, target.clone(), s.wake.clone());
    }
}

pub(crate) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    if s.notifications.routes.is_empty() {
        return false;
    }
    let mut routes = std::mem::take(&mut s.notifications.routes);
    routes.retain(|(_, target, _)| crate::workspace::owns_notification(s, target));
    s.notifications.routes = routes;
    let mut changed = false;
    while let Ok(id) = s.notifications.clicks.try_recv() {
        let Some(index) = s
            .notifications
            .routes
            .iter()
            .position(|(entry, _, _)| *entry == id)
        else {
            continue;
        };
        let (_, target, presented) = s.notifications.routes.remove(index).unwrap();
        drop(presented);
        if crate::workspace::open_notification(s, &target, tx) {
            s.notifications.focus();
            changed = true;
        }
    }
    changed
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
        use crate::agent_api::{Form, RootActivity};
        let mut attention = Attention::default();
        let mut snapshot = Snapshot {
            models: None,
            current: None,
            session_known: true,
            running: false,
            root_activity: None,
            permissions: None,
            forms: Some(vec![Form {
                id: "form-1".into(),
                title: "Question".into(),
                fields: vec![],
            }]),
        };
        attention.observe(&snapshot, true);
        assert!(attention.pending.is_empty());
        snapshot.root_activity = Some(RootActivity {
            busy: Some(1),
            idle: Some(2),
        });
        attention.observe(&snapshot, true);
        assert!(matches!(
            attention.pending.as_slice(),
            [Category::NeedsInput]
        ));
        snapshot.root_activity = Some(RootActivity {
            busy: Some(3),
            idle: Some(4),
        });
        attention.observe(&snapshot, false);
        assert_eq!(attention.pending.len(), 1);
        attention.observe(&snapshot, true);
        attention.observe(&snapshot, true);
        assert_eq!(attention.take_idle_verification(), Some(4));
        attention.confirm_idle(4);
        assert!(matches!(
            attention.pending.as_slice(),
            [Category::NeedsInput, Category::SessionDone]
        ));
    }
}
