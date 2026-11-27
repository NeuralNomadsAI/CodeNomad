//! Native OS wake-lock coordination mirroring Solid's `wake-lock-eligibility.ts`.
use crate::State;

pub(crate) struct Controller {
    #[cfg(not(target_arch = "wasm32"))]
    desired: bool,
    #[cfg(target_os = "windows")]
    os: Option<codenomad_host_process::WakeLock>,
    #[cfg(all(test, not(target_arch = "wasm32")))]
    transitions: Vec<bool>,
}

impl Default for Controller {
    fn default() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            desired: false,
            #[cfg(target_os = "windows")]
            os: (!cfg!(any(test, feature = "test-support"))
                && rune_theme_codenomad::shell::live_caption())
            .then(codenomad_host_process::WakeLock::new),
            #[cfg(all(test, not(target_arch = "wasm32")))]
            transitions: Vec::new(),
        }
    }
}

impl Controller {
    #[cfg(not(target_arch = "wasm32"))]
    fn apply(&mut self, desired: bool) {
        if self.desired == desired {
            #[cfg(target_os = "windows")]
            if let Some(os) = &mut self.os {
                // Retry a previously failed release while desired stays false.
                if !desired && os.is_held() {
                    let _ = os.set_desired(false);
                }
            }
            return;
        }
        self.desired = desired;
        #[cfg(target_os = "windows")]
        if let Some(os) = &mut self.os {
            let _ = os.set_desired(desired);
        }
        #[cfg(test)]
        self.transitions.push(desired);
    }

    fn release(&mut self) {
        #[cfg(not(target_arch = "wasm32"))]
        if self.desired {
            self.desired = false;
            #[cfg(test)]
            self.transitions.push(false);
        }
        #[cfg(target_os = "windows")]
        if let Some(os) = &mut self.os {
            os.release();
        }
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn desired(&self) -> bool {
        self.desired
    }

    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn transitions(&self) -> &[bool] {
        &self.transitions
    }
}

#[cfg(not(target_arch = "wasm32"))]
/// Solid parity (`shouldAppHoldWakeLock`):
/// hold wake lock when a local desktop window enables `keepComputerAwake` or any tab has active work.
pub(crate) fn should_hold(
    keep_computer_awake: bool,
    has_eligible_work: bool,
    local_window: bool,
) -> bool {
    (local_window && keep_computer_awake) || has_eligible_work
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn is_loopback_url(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, right)| right);
    if host_port.is_empty() {
        return false;
    }
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        let Some((addr, _)) = inner.split_once(']') else {
            return false;
        };
        addr
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn is_local_window(s: &State) -> bool {
    if s.screen
        .launcher()
        .is_some_and(|launcher| launcher.local_connection())
    {
        return true;
    }
    crate::settings::bound_backend(s).is_some_and(|backend| is_loopback_url(backend.base.as_str()))
}

pub(crate) fn sync(s: &mut State) {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = s;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let keep = crate::settings::keep_computer_awake(s);
        let work = crate::workspace::has_wake_lock_eligible_work(s);
        let local = is_local_window(s);
        let desired = should_hold(keep, work, local);
        s.wake_lock.apply(desired);
    }
}

pub(crate) fn release(s: &mut State) {
    s.wake_lock.release();
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::{
        Phase,
        agent::{self, Ui as AgentUi},
        agent_api::{Form, Permission},
        backend::Backend,
        workspace::Ui as WorkspaceUi,
    };
    use serde_json::json;

    fn agent_ui(running: bool, permission: bool, form: bool) -> AgentUi {
        let backend = Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let mut ui = AgentUi::new(agent::start(backend, std::sync::Arc::new(|| {})));
        ui.online = true;
        ui.running = running;
        if permission {
            ui.permissions.push(Permission {
                id: "perm-1".into(),
                action: "bash".into(),
                resources: vec![],
                message: String::new(),
                supported: true,
                tool: None,
            });
        }
        if form {
            ui.forms.push(Form {
                id: "form-1".into(),
                title: "Question".into(),
                fields: vec![],
                tool: None,
                infer_websearch: false,
            });
        }
        ui
    }

    #[test]
    fn eligibility_matrix_matches_solid_contract() {
        assert!(!should_hold(false, false, true));
        assert!(should_hold(true, false, true));
        assert!(!should_hold(true, false, false));
        assert!(should_hold(false, true, false));
        assert!(should_hold(false, true, true));
        assert!(should_hold(true, true, true));
    }

    #[test]
    fn loopback_url_detection_accepts_only_loopback_hosts() {
        assert!(is_loopback_url("http://127.0.0.1:9898/"));
        assert!(is_loopback_url("http://127.0.1.1:3000/api"));
        assert!(is_loopback_url("http://localhost:3000/"));
        assert!(is_loopback_url("https://LOCALHOST/"));
        assert!(is_loopback_url("http://[::1]:9898/"));
        assert!(is_loopback_url("http://user:pass@127.0.0.1:9898/"));
        assert!(!is_loopback_url("https://example.com:9898/"));
        assert!(!is_loopback_url("http://192.168.1.10:9898/"));
        assert!(!is_loopback_url("http://localhost.evil.com/"));
        assert!(!is_loopback_url("not-a-url"));
    }

    #[test]
    fn sync_holds_for_local_keep_awake_and_ignores_remote_idle_preference() {
        let mut s = crate::init();
        crate::settings::fixture_config(
            &mut s,
            "http://127.0.0.1:9898/",
            json!({"keepComputerAwake": true}),
        );
        sync(&mut s);
        assert!(s.wake_lock.desired());
        assert_eq!(s.wake_lock.transitions(), &[true]);

        // Coalesced: repeated sync does not re-emit transition.
        sync(&mut s);
        assert_eq!(s.wake_lock.transitions(), &[true]);

        // Switching to a remote server disables idle keepComputerAwake.
        crate::settings::fixture_config(
            &mut s,
            "https://remote.example.com:9898/",
            json!({"keepComputerAwake": true}),
        );
        sync(&mut s);
        assert!(!s.wake_lock.desired());
        assert_eq!(s.wake_lock.transitions(), &[true, false]);

        // Active streaming on the remote window still holds wake lock.
        s.phase = Phase::Streaming;
        sync(&mut s);
        assert!(s.wake_lock.desired());

        // Closing releases deterministically.
        release(&mut s);
        assert!(!s.wake_lock.desired());
        assert_eq!(s.wake_lock.transitions(), &[true, false, true, false]);
    }

    #[test]
    fn active_work_holds_wake_lock_until_permission_or_form_pauses_it() {
        let mut s = crate::init();
        s.phase = Phase::Ready;
        s.agent = Some(agent_ui(true, false, false));
        sync(&mut s);
        assert!(s.wake_lock.desired());

        // Pending permission pauses wake lock even while streaming.
        s.phase = Phase::Streaming;
        s.agent = Some(agent_ui(true, true, false));
        sync(&mut s);
        assert!(!s.wake_lock.desired());

        // Pending form also pauses wake lock.
        s.agent = Some(agent_ui(true, false, true));
        sync(&mut s);
        assert!(!s.wake_lock.desired());

        // Resuming work re-acquires wake lock.
        s.agent = Some(agent_ui(true, false, false));
        sync(&mut s);
        assert!(s.wake_lock.desired());

        // Offline agent with stale Phase::Streaming does not hold wake lock.
        let mut offline = agent_ui(true, false, false);
        offline.online = false;
        s.phase = Phase::Streaming;
        s.agent = Some(offline);
        sync(&mut s);
        assert!(!s.wake_lock.desired());
    }

    #[test]
    fn background_cached_tab_with_active_work_holds_wake_lock() {
        let mut s = crate::init();
        let mut ui = WorkspaceUi::new();
        ui.fixture_hydrate(crate::workspace::Snapshot {
            revision: 1,
            saved_at: 0,
            panel_widths: [None, None],
            file_wrap: None,
            tabs: vec![
                crate::workspace::Tab::Workspace(crate::workspace::Workspace {
                    backend_id: None,
                    server_id: None,
                    folder: "D:/repo".into(),
                    project_name: None,
                    temporary: false,
                    occurrence: 1,
                    workspace_id: Some("ws-1".into()),
                    active_session_id: Some("ses-1".into()),
                    drafts: Default::default(),
                    attachment_drafts: Default::default(),
                    attachment_parts: Default::default(),
                    view: Default::default(),
                }),
                crate::workspace::Tab::Blank,
            ],
            active: Some(0),
        });
        ui.fixture_ready();
        s.workspace = Some(ui);
        s.phase = Phase::Streaming;
        s.agent = Some(agent_ui(true, false, false));
        let mut rt = rune::Runtime::new(
            s,
            |_, _| rune::el(),
            (800.0, 600.0),
            rune::Env::new(false, 1.0),
        );
        rt.update(|s, tx| {
            // Switching to tab 1 stashes the working tab 0 into its cache.
            crate::workspace::select_index(s, 1, tx);
            assert_eq!(s.workspace.as_ref().unwrap().active_index(), 1);
            assert!(s.agent.is_none());
            sync(s);
            assert!(
                s.wake_lock.desired(),
                "inactive working tab must keep wake lock active"
            );
            // Switch back, pause with a pending permission, and switch away again.
            crate::workspace::select_index(s, 0, tx);
            s.agent = Some(agent_ui(true, true, false));
            crate::workspace::select_index(s, 1, tx);
            sync(s);
            assert!(
                !s.wake_lock.desired(),
                "inactive tab blocked on permission must not hold wake lock"
            );
        });
    }
}
