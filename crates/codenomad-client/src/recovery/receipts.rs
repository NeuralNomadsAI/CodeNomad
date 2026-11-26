//! One dispatch attempt and its correlated receipt.
use super::authentication::{close_for_authentication, rejected_by_authentication};
use crate::{
    Sender, Wake,
    backend::Backend,
    prompt::Prompt,
    prompt_shell::ShellError,
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

pub(super) async fn shell(
    backend: &Backend,
    out: &Sender<Event>,
    wake: &Wake,
    wire: &stream::State,
    admitted: bool,
    attempt: &str,
    command: &str,
) -> Option<PromptOutcome> {
    let outcome = if admitted {
        match backend.prompt_shell(attempt, command).await {
            Ok(()) => PromptOutcome::Confirmed(attempt.into()),
            Err(ShellError::Rejected) => PromptOutcome::Rejected,
            Err(ShellError::Unconfirmed) => PromptOutcome::Unconfirmed,
            Err(ShellError::PreDispatchAuthenticationRequired) => {
                if matches!(backend.authentication_status().await, Ok(false)) {
                    close_for_authentication(wire, out).await;
                    publish(
                        out,
                        wake,
                        Event::PromptAcknowledged {
                            attempted: attempt.into(),
                            outcome: PromptOutcome::Rejected,
                        },
                    )
                    .await;
                    publish(
                        out,
                        wake,
                        Event::AuthenticationRequired(crate::transport::Authentication {
                            backend: backend.clone(),
                            confirmed: true,
                        }),
                    )
                    .await;
                    return None;
                }
                PromptOutcome::Rejected
            }
            Err(ShellError::UnconfirmedAuthenticationRequired) => {
                if matches!(backend.authentication_status().await, Ok(false)) {
                    close_for_authentication(wire, out).await;
                    publish(
                        out,
                        wake,
                        Event::PromptAcknowledged {
                            attempted: attempt.into(),
                            outcome: PromptOutcome::Unconfirmed,
                        },
                    )
                    .await;
                    publish(
                        out,
                        wake,
                        Event::AuthenticationRequired(crate::transport::Authentication {
                            backend: backend.clone(),
                            confirmed: true,
                        }),
                    )
                    .await;
                    return None;
                }
                PromptOutcome::Unconfirmed
            }
        }
    } else {
        PromptOutcome::Rejected
    };
    Some(outcome)
}

pub(super) async fn prompt(
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
            Err(error) if error.downcast_ref() == Some(&crate::prompt::PromptError::Rejected) => {
                PromptOutcome::Rejected
            }
            Err(_) => PromptOutcome::Unconfirmed,
        }
    } else {
        PromptOutcome::Rejected
    };
    Some(outcome)
}
