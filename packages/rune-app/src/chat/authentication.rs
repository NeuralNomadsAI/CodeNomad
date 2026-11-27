//! Native direct-launch login recovery. Browser pairing stays in the web platform.
use crate::{State, backend::Backend, platform, strings::t};
use codenomad_client::{Receiver, bounded, transport::Authentication};
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
    backend: Backend,
    expected_server: Option<String>,
    flight: Option<Receiver<Reply>>,
    required: bool,
    error: Option<&'static str>,
}

enum Reply {
    Required,
    Connected(Backend),
    AwaitingAttestation(Backend),
    Failed(&'static str),
}

pub(crate) fn expired(
    s: &mut State,
    Authentication {
        backend: expired,
        confirmed,
    }: Authentication,
) {
    if s.screen.launcher().is_some() {
        return;
    }
    let expected_server = expired.client.server_identity().map(str::to_owned);
    if expected_server.is_none() && crate::settings::bound_backend(s).is_some() {
        return;
    }
    s.renew_scope();
    s.direct_authentication = Recovery {
        challenge: Some(Challenge {
            backend: expired,
            expected_server,
            flight: None,
            required: confirmed,
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
        || s.direct_authentication.username.text.is_empty()
        || s.direct_authentication.password.text.is_empty()
    {
        return;
    }
    let password = std::mem::take(&mut s.direct_authentication.password.text);
    s.direct_authentication.password = TextEdit::new("");
    request(
        challenge,
        &s.wake,
        Some((s.direct_authentication.username.text.clone(), password)),
    );
}

fn request(challenge: &mut Challenge, wake: &rune::Waker, credentials: Option<(String, String)>) {
    let (output, input) = bounded(1);
    challenge.flight = Some(input);
    challenge.error = None;
    let backend = challenge.backend.clone();
    let expected = challenge.expected_server.clone();
    let wake = wake.clone();
    platform::spawn(async move {
        let reply = match credentials {
            Some((username, password)) => {
                sign_in(backend, expected.as_deref(), username, password).await
            }
            None => check(backend, expected.as_deref()).await,
        };
        if output.send(reply).await.is_ok() {
            wake();
        }
    });
}

async fn check(backend: Backend, expected: Option<&str>) -> Reply {
    match backend.authentication_status().await {
        Ok(true) => attest(backend, expected).await,
        Ok(false) => Reply::Required,
        Err(_) => Reply::Failed("authRecovery.unavailable"),
    }
}

async fn sign_in(
    mut expired: Backend,
    expected: Option<&str>,
    username: String,
    password: String,
) -> Reply {
    let Ok(backend) = Backend::unauthenticated(&expired.base) else {
        return Reply::Failed("authRecovery.unavailable");
    };
    match backend.sign_in(&username, &password).await {
        Ok(()) => {
            expired.client = backend.client;
            attest(expired, expected).await
        }
        Err(error) if codenomad_client::http::authentication_expired(&error) => {
            Reply::Failed("authRecovery.credentials")
        }
        Err(_) => Reply::Failed("authRecovery.unavailable"),
    }
}

async fn attest(mut backend: Backend, expected: Option<&str>) -> Reply {
    let Ok(id) = backend.attest_server().await else {
        return Reply::AwaitingAttestation(backend);
    };
    if expected.is_some_and(|expected| expected != id) {
        return Reply::Failed("authRecovery.unavailable");
    }
    if !backend.session.is_empty() {
        match backend.prompt_directory().await {
            Ok(directory) => backend.session_directory = Some(directory),
            Err(error) if codenomad_client::http::authentication_expired(&error) => {
                return Reply::Required;
            }
            Err(_) => return Reply::Failed("authRecovery.unavailable"),
        }
    }
    let Ok(client) = codenomad_client::http::client_id() else {
        return Reply::Failed("authRecovery.unavailable");
    };
    backend.client_id = client;
    backend.fresh_mode = false;
    Reply::Connected(backend)
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
        Reply::AwaitingAttestation(backend) => {
            challenge.backend = backend;
            challenge.error = Some("authRecovery.unavailable");
        }
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

pub(crate) fn open(s: &State) -> bool {
    s.direct_authentication
        .challenge
        .as_ref()
        .is_some_and(|challenge| challenge.required)
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
        .build(&field_kit(layout::dark()))
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
        .build(&field_kit(layout::dark()))
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
        waiting || username.text.is_empty() || password.text.is_empty(),
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
    )
    .key("direct-recovery-check");
    Some(
        rune_theme_codenomad::settings::authentication_dialog::<State>(
            t("authRecovery.title"),
            [account, field],
            error,
            [check, button],
        ),
    )
}
