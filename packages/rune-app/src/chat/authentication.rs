//! Native direct-launch login recovery. Browser pairing stays in the web platform.
use crate::{
    State,
    backend::{Backend, read_json},
    platform,
    strings::t,
};
use codenomad_client::{Receiver, bounded};
use rune::{El, edit::TextEdit, text};
use rune_theme_codenomad::{
    field_kit,
    layout::{self, literal_field},
};

#[derive(Default)]
pub(crate) struct Recovery {
    challenge: Option<Challenge>,
    pub(crate) username: TextEdit,
    pub(crate) password: TextEdit,
}

struct Challenge {
    expired: Backend,
    initial: bool,
    flight: Option<Receiver<Reply>>,
    required: bool,
    error: Option<&'static str>,
}

enum Reply {
    Required,
    Connected(Backend),
    Failed(&'static str),
}

pub(crate) fn expired(s: &mut State, expired: Backend) {
    if s.screen.launcher().is_some() {
        return;
    }
    s.renew_scope();
    s.direct_authentication = Recovery {
        challenge: Some(Challenge {
            expired,
            initial: crate::settings::bound_backend(s).is_none(),
            flight: None,
            required: false,
            error: None,
        }),
        username: TextEdit::new("codenomad"),
        password: TextEdit::new(""),
    };
    retry(s);
}

// True means this recovery owns Retry; don't send an ordinary conversation retry.
pub(crate) fn retry(s: &mut State) -> bool {
    let Some(challenge) = &mut s.direct_authentication.challenge else {
        return false;
    };
    if challenge.flight.is_none() && !challenge.required {
        request(challenge, &s.wake, None);
    }
    true
}

fn submit(s: &mut State) {
    let Some(challenge) = &mut s.direct_authentication.challenge else {
        return;
    };
    if !challenge.required
        || challenge.flight.is_some()
        || s.direct_authentication.username.text.trim().is_empty()
        || s.direct_authentication.password.text.is_empty()
    {
        return;
    }
    let password = std::mem::take(&mut s.direct_authentication.password.text);
    s.direct_authentication.password = TextEdit::new("");
    request(
        challenge,
        &s.wake,
        Some((
            s.direct_authentication.username.text.trim().to_owned(),
            password,
        )),
    );
}

fn request(challenge: &mut Challenge, wake: &rune::Waker, credentials: Option<(String, String)>) {
    let (output, input) = bounded(1);
    challenge.flight = Some(input);
    challenge.error = None;
    let (expired, initial, wake) = (challenge.expired.clone(), challenge.initial, wake.clone());
    platform::spawn(async move {
        let reply = match credentials {
            Some((username, password)) => sign_in(expired, initial, username, password).await,
            None => check(expired, initial).await,
        };
        if output.send(reply).await.is_ok() {
            wake();
        }
    });
}

async fn check(mut expired: Backend, initial: bool) -> Reply {
    let response = expired
        .client
        .get(format!("{}api/auth/status", expired.base))
        .send()
        .await;
    if let Ok(response) = response.and_then(|r| r.error_for_status())
        && let Ok(status) = read_json(response).await
    {
        match status["authenticated"].as_bool() {
            Some(true) => {
                if (!initial && expired.client.server_identity().is_none())
                    || expired.attest_server().await.is_err()
                {
                    return Reply::Failed("authRecovery.unavailable");
                }
                let Ok(client) = codenomad_client::http::client_id() else {
                    return Reply::Failed("authRecovery.unavailable");
                };
                expired.client_id = client;
                expired.fresh_mode = false;
                return Reply::Connected(expired);
            }
            Some(false) => return Reply::Required,
            None => {}
        }
    }
    Reply::Failed("authRecovery.unavailable")
}

async fn sign_in(mut expired: Backend, initial: bool, username: String, password: String) -> Reply {
    let Ok(backend) = Backend::unauthenticated(&expired.base) else {
        return Reply::Failed("authRecovery.unavailable");
    };
    match backend.sign_in(&username, &password).await {
        Ok(()) => {
            let Ok(id) = backend.attest_server().await else {
                return Reply::Failed("authRecovery.unavailable");
            };
            if !initial && expired.client.server_identity() != Some(id.as_str()) {
                return Reply::Failed("authRecovery.unavailable");
            }
            expired.client = backend.client;
            expired.client_id = backend.client_id;
            expired.fresh_mode = false;
            Reply::Connected(expired)
        }
        Err(error) if codenomad_client::http::authentication_expired(&error) => {
            Reply::Failed("authRecovery.credentials")
        }
        Err(_) => Reply::Failed("authRecovery.unavailable"),
    }
}

pub(crate) fn poll(s: &mut State) -> bool {
    let Some(challenge) = &mut s.direct_authentication.challenge else {
        return false;
    };
    let Some(reply) = challenge
        .flight
        .as_ref()
        .and_then(|flight| flight.try_recv().ok())
    else {
        return false;
    };
    challenge.flight = None;
    match reply {
        Reply::Required => challenge.required = true,
        Reply::Failed(error) => challenge.error = Some(error),
        Reply::Connected(backend) => {
            s.direct_authentication = Recovery::default();
            s.phase = crate::Phase::Reconnecting;
            crate::settings::connected(s, &backend);
            if let Some(agent) = &mut s.agent {
                agent.reauthenticate(crate::agent::start(backend.clone(), s.wake.clone()));
            }
            crate::transport::start_bound(s, backend);
        }
    }
    true
}

pub(crate) fn dialog(s: &State) -> Option<El> {
    let challenge = s.direct_authentication.challenge.as_ref()?;
    if !challenge.required {
        return None;
    }
    let scope = &s.input_scope;
    let waiting = challenge.flight.is_some();
    let username = &s.direct_authentication.username;
    let password = &s.direct_authentication.password;
    let account = literal_field(username)
        .label(t("authRecovery.username"))
        .disabled(waiting)
        .on_edit(crate::screen::edit(
            scope,
            crate::screen::Editor::DirectUsername,
        ))
        .build(field_kit(layout::dark()))
        .key("direct-recovery-username");
    let field = literal_field(password)
        .label(t("authRecovery.password"))
        .disabled(waiting)
        .secure()
        .on_edit(crate::screen::edit(
            scope,
            crate::screen::Editor::DirectPassword,
        ))
        .on_submit(crate::screen::action_tx(scope, |s, _| submit(s)))
        .build(field_kit(layout::dark()))
        .key("direct-recovery-password")
        .autofocus();
    let error = challenge
        .error
        .map(|error| text(t(error)).role("alert").key("direct-recovery-error"));
    let button = layout::button(
        t(if waiting {
            "authRecovery.pending"
        } else {
            "authRecovery.signIn"
        }),
        waiting || username.text.trim().is_empty() || password.text.is_empty(),
        crate::screen::action(scope, submit),
    )
    .key("direct-recovery-sign-in");
    let check = layout::button(
        t("authRecovery.check"),
        waiting,
        crate::screen::action(scope, |s| {
            if let Some(challenge) = &mut s.direct_authentication.challenge
                && challenge.flight.is_none()
            {
                request(challenge, &s.wake, None);
            }
        }),
    );
    Some(
        rune_theme_codenomad::settings::authentication_dialog::<State>(
            t("authRecovery.title"),
            [account, field],
            error,
            [check, button],
        ),
    )
}
