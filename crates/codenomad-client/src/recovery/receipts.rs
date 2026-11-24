//! One dispatch attempt and its correlated receipt.
use super::authentication::rejected_by_authentication;
use crate::{
    Sender, Wake,
    backend::Backend,
    prompt::Prompt,
    stream,
    transport::{Event, PromptOutcome, publish},
};

pub(super) async fn slash(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    admitted: bool,
    attempt: String,
    name: String,
    text: String,
) -> bool {
    use crate::prompt::PromptError;
    let outcome = if admitted {
        match backend.prompt_command(&name, &text).await {
            Ok(()) => PromptOutcome::Confirmed(attempt.clone()),
            Err(PromptError::Rejected) => PromptOutcome::Rejected,
            Err(PromptError::Unconfirmed) => PromptOutcome::Unconfirmed,
            Err(PromptError::AuthenticationRequired) => {
                if rejected_by_authentication(backend, &attempt, out, wake, wire).await {
                    return false;
                }
                PromptOutcome::Rejected
            }
        }
    } else {
        PromptOutcome::Rejected
    };
    publish(
        out,
        wake,
        Event::PromptAcknowledged {
            attempted: attempt,
            outcome,
        },
    )
    .await;
    true
}

pub(crate) async fn prompt(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    admitted: bool,
    id: &str,
    prompt: &Prompt,
) -> Option<PromptOutcome> {
    let outcome = if admitted {
        match backend.prompt(prompt).await {
            Ok(ack) => PromptOutcome::Confirmed(ack.id),
            Err(error)
                if error.downcast_ref()
                    == Some(&crate::prompt::PromptError::AuthenticationRequired) =>
            {
                if rejected_by_authentication(backend, id, out, wake, wire).await {
                    return None;
                }
                PromptOutcome::Rejected
            }
            Err(error)
                if error.downcast_ref() == Some(&crate::prompt::PromptError::Rejected)
                    || error.is::<crate::prompt::EncodeError>() =>
            {
                PromptOutcome::Rejected
            }
            Err(_) => PromptOutcome::Unconfirmed,
        }
    } else {
        PromptOutcome::Rejected
    };
    Some(outcome)
}
