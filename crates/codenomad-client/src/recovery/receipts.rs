//! One dispatch attempt and its correlated receipt.
use super::authentication::rejected_by_authentication;
#[cfg(test)]
use crate::prompt::Prompt;
use crate::{
    Sender, Wake,
    backend::Backend,
    prompt_shell::ShellError,
    stream,
    transport::{Event, PromptOutcome, publish},
};

#[derive(Debug)]
pub enum ShellSettlement {
    Outcome(PromptOutcome),
    AuthExpired { outcome: PromptOutcome },
}

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
            Err(PromptError::AuthenticationRequired { before_dispatch }) => {
                if let Some(confirmed) =
                    rejected_by_authentication(backend, &attempt, before_dispatch, out, wake, wire)
                        .await
                {
                    return SlashReceipt::AuthenticationRequired { confirmed };
                }
                if before_dispatch {
                    PromptOutcome::Rejected
                } else {
                    // Without the pre-dispatch marker, a 401 may come from a detached write or upstream after dispatch.
                    PromptOutcome::Unconfirmed
                }
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

pub(super) async fn shell(backend: &Backend, attempt: &str, command: &str) -> ShellSettlement {
    match backend.prompt_shell(attempt, command).await {
        Ok(()) => ShellSettlement::Outcome(PromptOutcome::Confirmed(attempt.into())),
        Err(ShellError::Rejected) => ShellSettlement::Outcome(PromptOutcome::Rejected),
        Err(ShellError::Unconfirmed) => ShellSettlement::Outcome(PromptOutcome::Unconfirmed),
        Err(ShellError::PreDispatchAuthenticationRequired) => {
            if matches!(backend.authentication_status().await, Ok(false)) {
                ShellSettlement::AuthExpired {
                    outcome: PromptOutcome::Rejected,
                }
            } else {
                ShellSettlement::Outcome(PromptOutcome::Rejected)
            }
        }
        Err(ShellError::UnconfirmedAuthenticationRequired) => {
            if matches!(backend.authentication_status().await, Ok(false)) {
                ShellSettlement::AuthExpired {
                    outcome: PromptOutcome::Unconfirmed,
                }
            } else {
                ShellSettlement::Outcome(PromptOutcome::Unconfirmed)
            }
        }
    }
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
            if matches!(
                error.downcast_ref::<crate::prompt::PromptError>(),
                Some(crate::prompt::PromptError::AuthenticationRequired { .. })
            ) =>
        {
            let before_dispatch = matches!(
                error.downcast_ref::<crate::prompt::PromptError>(),
                Some(crate::prompt::PromptError::AuthenticationRequired {
                    before_dispatch: true
                })
            );
            if let Some(confirmed) =
                rejected_by_authentication(backend, id, before_dispatch, out, wake, wire).await
            {
                return PromptReceipt::AuthenticationRequired { confirmed };
            }
            if before_dispatch {
                PromptOutcome::Rejected
            } else {
                // Without the pre-dispatch marker, a 401 may come from a detached write or upstream after dispatch.
                PromptOutcome::Unconfirmed
            }
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
