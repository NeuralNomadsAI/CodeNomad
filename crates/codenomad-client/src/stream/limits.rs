//! Frame size budget and repair hints for dropped frames.
use super::{Input, Result, Sender, SeqCst, State};

// Both relays admit 32 MiB of native routing payload, before the workspace envelope.
pub(super) const FRAME_LIMIT: usize = (32 << 20) + 4096;

pub(super) async fn reread(epoch: u64, out: &Sender<Input>, state: &State) -> Result<()> {
    if let Some(signals) = &state.catalogue {
        signals.invalidate_all();
    } else {
        let version = state.version.fetch_add(1, SeqCst) + 1;
        out.send(Input::Hint(epoch, version)).await?;
    }
    Ok(())
}
