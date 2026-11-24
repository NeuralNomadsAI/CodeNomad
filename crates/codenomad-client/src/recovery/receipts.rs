//! One dispatch attempt and its correlated receipt.
use super::authentication::rejected_by_authentication;
use crate::{
    Sender, Wake,
    backend::Backend,
    prompt::Prompt,
    stream,
    transport::{Event, PromptOutcome, publish},
};

pub(super) enum SlashReceipt {
    Settled,
    AuthenticationRequired { confirmed: bool },
}

pub(super) enum PromptReceipt {
    Outcome(PromptOutcome),
    AuthenticationRequired { confirmed: bool },
}

pub(super) async fn slash(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    admitted: bool,
    attempt: String,
    name: String,
    text: String,
) -> SlashReceipt {
    use crate::prompt::PromptError;
    let outcome = if admitted {
        match backend.prompt_command(&name, &text).await {
            Ok(()) => PromptOutcome::Confirmed(attempt.clone()),
            Err(PromptError::Rejected) => PromptOutcome::Rejected,
            Err(PromptError::Unconfirmed) => PromptOutcome::Unconfirmed,
            Err(PromptError::AuthenticationRequired) => {
                if let Some(confirmed) =
                    rejected_by_authentication(backend, &attempt, out, wake, wire).await
                {
                    return SlashReceipt::AuthenticationRequired { confirmed };
                }
                // Live CodeNomad session: the proxy did not detach on principal revocation, so upstream rejected synchronously.
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
    SlashReceipt::Settled
}

pub(super) async fn prompt(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    admitted: bool,
    id: &str,
    prompt: &Prompt,
) -> PromptReceipt {
    let outcome = if admitted {
        match backend.prompt(prompt).await {
            Ok(ack) => PromptOutcome::Confirmed(ack.id),
            Err(error)
                if error.downcast_ref()
                    == Some(&crate::prompt::PromptError::AuthenticationRequired) =>
            {
                if let Some(confirmed) =
                    rejected_by_authentication(backend, id, out, wake, wire).await
                {
                    return PromptReceipt::AuthenticationRequired { confirmed };
                }
                // Live CodeNomad session: the proxy did not detach on principal revocation, so upstream rejected synchronously.
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
    PromptReceipt::Outcome(outcome)
}
