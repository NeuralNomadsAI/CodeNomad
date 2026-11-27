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
    backend: &Backend,
    reading: Option<&ReadingLane>,
    wire: &stream::State,
    out: &Sender<Event>,
    wake: &crate::Wake,
) {
    ReadingLane::invalidate_connection(reading);
    close_for_authentication(wire, out).await;
    publish(
        out,
        wake,
        Event::AuthenticationRequired(crate::transport::Authentication {
            backend: backend.clone(),
            confirmed: true,
        }),
    )
    .await;
}

pub(super) async fn rejected_by_authentication(
    backend: &Backend,
    attempted: &str,
    out: &Sender<Event>,
    wake: &crate::Wake,
    wire: &stream::State,
) -> bool {
    let authenticated = backend.authentication_status().await;
    if matches!(authenticated, Ok(true)) {
        return false;
    }
    close_for_authentication(wire, out).await;
    publish(
        out,
        wake,
        Event::PromptAcknowledged {
            attempted: attempted.into(),
            outcome: PromptOutcome::Rejected,
        },
    )
    .await;
    publish(
        out,
        wake,
        Event::AuthenticationRequired(crate::transport::Authentication {
            backend: backend.clone(),
            confirmed: matches!(authenticated, Ok(false)),
        }),
    )
    .await;
    true
}
