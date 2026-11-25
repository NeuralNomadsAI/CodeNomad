use super::events::poll_chat;
#[cfg(target_arch = "wasm32")]
use crate::platform;
use crate::{
    Phase, State, chat, launcher, settings,
    transport::{self, Command},
    workspace,
};
use codenomad_client::{Receiver, Sender};
use rune::Tx;

pub(crate) fn retry_connection(s: &mut State, tx: &mut Tx) {
    if s.status_permissions.writing() {
        return;
    }
    #[cfg(target_arch = "wasm32")]
    {
        if platform::pairing::required(s) {
            platform::pairing::recheck(s);
            return;
        }
        if matches!(s.phase, Phase::WorkspaceMissing | Phase::RestoreFailed) {
            launcher::reopen(s);
            return;
        }
        if s.screen.is_launcher() && s.commands.is_none() {
            if s.screen.launcher().is_some_and(|l| l.connection.is_some()) {
                launcher::list(s, false);
            } else {
                launcher::connect(s, tx);
            }
            return;
        }
    }
    if s.composer.pending() {
        // A terminal failure can be delivered ahead of the last transport receipt.
        poll_chat(s, 64);
        if s.composer.pending() {
            return;
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    if chat::authentication::retry(s) {
        return;
    }
    if let Some(l) = s.screen.launcher()
        && l.authentication_required
    {
        if l.renewing_managed_session() {
            s.phase = Phase::Reconnecting;
        } else {
            s.show_launcher();
        }
        return;
    }
    if s.incoming.as_ref().is_none_or(Receiver::is_closed)
        || s.commands.as_ref().is_none_or(Sender::is_closed)
    {
        if let Some(id) = workspace::active_session(s).map(str::to_owned) {
            launcher::choose(s, id, tx);
        } else if s.screen.launcher().is_none() && s.incoming.is_some() {
            s.phase = Phase::Reconnecting;
            if let Some(backend) = settings::bound_backend(s) {
                transport::start_bound(s, backend);
            } else {
                transport::start(s, false);
            }
        }
    } else if s
        .commands
        .as_ref()
        .is_some_and(|c| c.try_send(Command::Retry).is_ok())
    {
        s.phase = Phase::Reconnecting;
        chat::resume(s, tx);
    }
}
