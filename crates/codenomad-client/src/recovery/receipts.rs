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

pub(crate) enum PromptReceipt {
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
                // Even if another tab re-paired, a 401 on an already-dispatched mutation cannot prove non-delivery.
                PromptOutcome::Unconfirmed
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

#[cfg(test)]
pub(crate) async fn prompt(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    admitted: bool,
    id: &str,
    prompt: &Prompt,
) -> PromptReceipt {
    if !admitted {
        return PromptReceipt::Outcome(PromptOutcome::Rejected);
    }
    let Ok(body) = crate::prompt::encode(prompt) else {
        return PromptReceipt::Outcome(PromptOutcome::Rejected);
    };
    prompt_encoded(backend, out, wake, wire, id, body).await
}

pub(super) async fn prompt_encoded(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    id: &str,
    body: Vec<u8>,
) -> PromptReceipt {
    let outcome = match backend.send_encoded_prompt(Some(id), body).await {
        Ok(ack) => PromptOutcome::Confirmed(ack.id),
        Err(error)
            if error.downcast_ref()
                == Some(&crate::prompt::PromptError::AuthenticationRequired) =>
        {
            if let Some(confirmed) = rejected_by_authentication(backend, id, out, wake, wire).await
            {
                return PromptReceipt::AuthenticationRequired { confirmed };
            }
            // Even if another tab re-paired, a 401 on an already-dispatched prompt cannot prove non-delivery.
            PromptOutcome::Unconfirmed
        }
        Err(error)
            if error.downcast_ref() == Some(&crate::prompt::PromptError::Rejected)
                || error.is::<crate::prompt::EncodeError>() =>
        {
            PromptOutcome::Rejected
        }
        Err(_) => PromptOutcome::Unconfirmed,
    };
    PromptReceipt::Outcome(outcome)
}
