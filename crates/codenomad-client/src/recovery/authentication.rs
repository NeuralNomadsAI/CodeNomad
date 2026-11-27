//! Authentication settlement for an expired history read or prompt.
use super::ReadingLane;
use crate::{
    Sender,
    backend::Backend,
    stream,
    transport::{Event, PromptOutcome, publish},
};

pub(super) async fn close_for_authentication(wire: &stream::State, out: &Sender<Event>) {
    wire.cancel();
    futures_lite::future::or(out.closed(), wire.wait_stopped()).await;
}

pub(super) async fn expire_reading(
    reading: Option<&ReadingLane>,
    wire: &stream::State,
    out: &Sender<Event>,
) {
    ReadingLane::invalidate_connection(reading);
    close_for_authentication(wire, out).await;
}

pub(super) async fn rejected_by_authentication(
    backend: &Backend,
    attempted: &str,
    before_dispatch: bool,
    out: &Sender<Event>,
    wake: &crate::Wake,
    wire: &stream::State,
) -> Option<bool> {
    let authenticated = backend.authentication_status().await;
    if matches!(authenticated, Ok(true)) {
        return None;
    }
    close_for_authentication(wire, out).await;
    let confirmed = matches!(authenticated, Ok(false));
    // A pre-dispatch middleware 401 proved no native POST left the server regardless of /api/auth/status availability.
    let outcome = if before_dispatch {
        PromptOutcome::Rejected
    } else {
        PromptOutcome::Unconfirmed
    };
    publish(
        out,
        wake,
        Event::PromptAcknowledged {
            attempted: attempted.into(),
            outcome,
        },
    )
    .await;
    Some(confirmed)
}
