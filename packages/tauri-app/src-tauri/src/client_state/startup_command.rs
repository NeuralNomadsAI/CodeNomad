//! Forwards Preferences startup-state commands to the exact local window that
//! opened Preferences. That renderer runs them through its own client-state
//! store and replies with its access proof; Preferences never writes state.

use super::ClientState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const STARTUP_STATE_COMMANDS: &[&str] =
    &["read", "enable-restore", "disable-restore", "clear"];
pub(crate) const STARTUP_COMMAND_EVENT: &str = "client-state:startup-command";
const STARTUP_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartupStateSnapshot {
    pub(crate) is_primary: bool,
    pub(crate) restore_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupCommandRequest {
    id: u64,
    window_id: String,
    command: &'static str,
}

type Reply = mpsc::Sender<Option<StartupStateSnapshot>>;

#[derive(Default)]
pub(crate) struct StartupCommands {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, (String, Reply)>>,
}

impl StartupCommands {
    pub(super) fn begin(
        &self,
        window_id: &str,
    ) -> (u64, mpsc::Receiver<Option<StartupStateSnapshot>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, (window_id.to_string(), sender));
        (id, receiver)
    }

    pub(super) fn cancel(&self, id: u64) {
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);
    }

    /// Accepts a reply only from the window the command was sent to.
    pub(super) fn complete(
        &self,
        id: u64,
        window_id: &str,
        state: Option<StartupStateSnapshot>,
    ) -> Result<(), String> {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match pending.get(&id) {
            None => Ok(()),
            Some((target, _)) if target != window_id => {
                Err("Startup state result is not owned by this window".to_string())
            }
            Some(_) => {
                let (_, reply) = pending.remove(&id).expect("pending startup command");
                let _ = reply.send(state);
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SNAPSHOT: StartupStateSnapshot = StartupStateSnapshot {
        is_primary: true,
        restore_enabled: false,
    };

    #[test]
    fn only_the_targeted_window_settles_a_forwarded_command() {
        let commands = StartupCommands::default();
        let (first, first_reply) = commands.begin("window-a");
        let (second, second_reply) = commands.begin("window-b");
        assert_ne!(first, second);

        assert!(commands
            .complete(first, "window-b", Some(SNAPSHOT))
            .is_err());
        assert!(first_reply.try_recv().is_err());
        commands
            .complete(first, "window-a", Some(SNAPSHOT))
            .unwrap();
        assert_eq!(first_reply.try_recv().unwrap(), Some(SNAPSHOT));
        // Late and replayed replies are ignored once settled or cancelled.
        commands.complete(first, "window-a", None).unwrap();
        commands.cancel(second);
        commands
            .complete(second, "window-b", Some(SNAPSHOT))
            .unwrap();
        assert!(second_reply.try_recv().is_err());
    }

    #[test]
    fn commands_are_a_closed_set_and_snapshots_reject_extra_fields() {
        for command in STARTUP_STATE_COMMANDS {
            assert_eq!(command_name(command).unwrap(), *command);
        }
        assert!(command_name("save").is_err());
        assert!(command_name("").is_err());
        let parsed: StartupStateSnapshot =
            serde_json::from_str(r#"{"isPrimary":true,"restoreEnabled":false}"#).unwrap();
        assert_eq!(parsed, SNAPSHOT);
        assert!(serde_json::from_str::<StartupStateSnapshot>(
            r#"{"isPrimary":true,"restoreEnabled":false,"snapshot":{}}"#
        )
        .is_err());
    }
}

pub(crate) fn command_name(value: &str) -> Result<&'static str, String> {
    STARTUP_STATE_COMMANDS
        .iter()
        .copied()
        .find(|command| *command == value)
        .ok_or_else(|| "Invalid startup state command".to_string())
}

/// Returns `Ok(None)` when the opener is closed, ephemeral or has not claimed
/// client-state access; never falls back to another window.
pub(crate) async fn run_in_local_window(
    app: &AppHandle,
    label: &str,
    command: &'static str,
) -> Result<Option<StartupStateSnapshot>, String> {
    let window_id = crate::identity::local_window_id(label)?;
    let state = app.state::<ClientState>();
    if app.get_webview_window(label).is_none() || !state.renderer_access.is_claimed_for(&window_id)
    {
        return Ok(None);
    }
    let (id, receiver) = state.startup_commands.begin(&window_id);
    let request = StartupCommandRequest {
        id,
        window_id: window_id.clone(),
        command,
    };
    if let Err(error) = app.emit_to(label, STARTUP_COMMAND_EVENT, request) {
        state.startup_commands.cancel(id);
        return Err(error.to_string());
    }
    let received = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(STARTUP_COMMAND_TIMEOUT)
    })
    .await
    .map_err(|error| error.to_string())?;
    state.startup_commands.cancel(id);
    match received {
        Ok(Some(snapshot)) => Ok(Some(snapshot)),
        Ok(None) => Err("Opener window rejected the startup state command".to_string()),
        Err(_) => Err("Opener startup state command timed out".to_string()),
    }
}
