//! Catalog integration installation by ID (`opencode/integrations/install.ts`).
//!
//! The package spec `<package>@<range>` always comes from the server's reviewed catalog (including
//! a valid `stale` catalog), never from the client, and writes through `plugin_controls::sources`'s
//! serialized queue with pre- and post-write ownership and connection checks.

use std::sync::Arc;

use axum::http::StatusCode as Status;
use tokio_util::sync::CancellationToken;

use crate::{
    App, Shared, Workspace,
    opencode::Endpoint,
    opencode_settings::{Scope, assert_current},
    plugin_controls::{
        catalog::{CatalogAvailability, valid_integration_id},
        engine,
        snapshot::ControlLocation,
        sources::{self, SourceAddRequest, SourceError, SourceMutationResponse},
    },
    subagent_depth::Fail,
};

use super::{LocationPin, owns_location, recognition::recognize_integrations};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InstallError {
    Unauthorized,
    Invalid,
    NotFound,
    Forbidden,
    GlobalOnly,
    Refused,
    Duplicate,
    Ambiguous,
    Stale,
    Unavailable,
    Timeout,
    Uncertain,
}

impl InstallError {
    pub(crate) const fn status(self) -> Status {
        match self {
            Self::Unauthorized => Status::UNAUTHORIZED,
            Self::Invalid => Status::BAD_REQUEST,
            Self::NotFound => Status::NOT_FOUND,
            Self::Forbidden => Status::FORBIDDEN,
            Self::GlobalOnly | Self::Refused => Status::UNPROCESSABLE_ENTITY,
            Self::Duplicate | Self::Ambiguous | Self::Stale => Status::CONFLICT,
            Self::Unavailable | Self::Timeout | Self::Uncertain => Status::SERVICE_UNAVAILABLE,
        }
    }

    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Invalid => "invalid",
            Self::NotFound => "not-found",
            Self::Forbidden => "forbidden",
            Self::GlobalOnly => "global-only",
            Self::Refused => "refused",
            Self::Duplicate => "duplicate",
            Self::Ambiguous => "ambiguous",
            Self::Stale => "stale",
            Self::Unavailable => "unavailable",
            Self::Timeout => "timeout",
            Self::Uncertain => "uncertain",
        }
    }
}

pub(crate) async fn install(
    app: &Shared,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    scope: Scope,
    principal: Option<CancellationToken>,
) -> Result<SourceMutationResponse, InstallError> {
    install_inner(app, workspace_id, integration_id, directory, scope, principal, None).await
}

#[cfg(test)]
pub(crate) async fn install_with_after_write(
    app: &Shared,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    scope: Scope,
    principal: Option<CancellationToken>,
    after_write: Box<dyn FnOnce() + Send>,
) -> Result<SourceMutationResponse, InstallError> {
    install_inner(app, workspace_id, integration_id, directory, scope, principal, Some(after_write)).await
}

async fn install_inner(
    app: &Shared,
    workspace_id: &str,
    integration_id: &str,
    directory: &str,
    scope: Scope,
    principal: Option<CancellationToken>,
    after_write: Option<Box<dyn FnOnce() + Send>>,
) -> Result<SourceMutationResponse, InstallError> {
    if !valid_integration_id(integration_id) || directory.is_empty() {
        return Err(InstallError::Invalid);
    }

    let location = ControlLocation::new(directory.to_owned(), None);
    // Run snapshot read and catalog read concurrently; fail fast on workspace/ownership refusals
    // before any catalog-derived answer (`install.ts:41`).
    let ((snapshot, workspace, endpoint, pin), catalog) = tokio::try_join!(
        async {
            engine::read_bound(app, workspace_id, &location, principal.as_ref(), None).await.map_err(map_controls_fail)
        },
        async { Ok::<_, InstallError>(app.integration_catalog.read_view(true).await) },
    )?;

    if catalog.state == CatalogAvailability::Unavailable {
        return Err(InstallError::Unavailable);
    }
    let entry = catalog
        .catalog
        .integrations
        .iter()
        .find(|candidate| candidate.id == integration_id)
        .ok_or(InstallError::NotFound)?;
    if entry.family == "native" && scope != Scope::Global {
        return Err(InstallError::GlobalOnly);
    }
    let recognition = recognize_integrations(&catalog.catalog, &snapshot)
        .into_iter()
        .find(|item| item.entry.id == entry.id)
        .ok_or(InstallError::NotFound)?;
    if recognition.ambiguous {
        return Err(InstallError::Ambiguous);
    }
    // Declared or loaded blocks; retained `id`/`-id` rules of an earlier removal never do.
    if !recognition.sources.is_empty() || recognition.runtime.is_some() {
        return Err(InstallError::Duplicate);
    }

    let owned = snapshot.location;
    authorize(app, &workspace, &endpoint, &owned.directory, &pin, principal.as_ref()).await?;

    let spec = format!("{}@{}", entry.package, entry.range);
    let pinned_location = engine::PinnedLocation {
        workspace_root: workspace.path.clone(),
        directory: owned.directory.clone(),
        pin: pin.clone(),
    };
    let result = sources::add_pinned(
        app,
        workspace_id,
        SourceAddRequest { location: owned.clone(), scope, spec },
        principal.clone(),
        Some(endpoint.clone()),
        Some(pinned_location),
    )
    .await
    .map_err(map_source_error)?;

    if let Some(hook) = after_write {
        hook();
    }

    // The write happened: a refusal now is an uncertain outcome, never a "nothing written" code.
    if authorize(app, &workspace, &endpoint, &owned.directory, &pin, principal.as_ref()).await.is_err() {
        return Err(InstallError::Uncertain);
    }

    Ok(result)
}

async fn authorize(
    app: &App,
    workspace: &Workspace,
    endpoint: &Arc<Endpoint>,
    directory: &str,
    pin: &LocationPin,
    principal: Option<&CancellationToken>,
) -> Result<(), InstallError> {
    assert_current(app, endpoint, workspace, principal).map_err(map_auth_fail)?;
    if !owns_location(app, workspace, directory, pin).await {
        return Err(InstallError::Forbidden);
    }
    assert_current(app, endpoint, workspace, principal).map_err(map_auth_fail)?;
    Ok(())
}

fn map_auth_fail(err: Fail) -> InstallError {
    match err {
        Fail::Status(Status::UNAUTHORIZED, _) => InstallError::Unauthorized,
        _ => InstallError::Unavailable,
    }
}

fn map_controls_fail(err: Fail) -> InstallError {
    match err {
        Fail::Status(Status::UNAUTHORIZED, _) => InstallError::Unauthorized,
        Fail::Status(Status::FORBIDDEN, _) => InstallError::Forbidden,
        Fail::Status(Status::NOT_FOUND, _) => InstallError::NotFound,
        Fail::Status(Status::CONFLICT, _) => InstallError::Stale,
        Fail::Status(Status::UNPROCESSABLE_ENTITY, _) => InstallError::Refused,
        _ => InstallError::Unavailable,
    }
}

fn map_source_error(err: SourceError) -> InstallError {
    match err {
        SourceError::Refused { code: Some("duplicate"), .. } => InstallError::Duplicate,
        SourceError::Refused { code: Some("global-only"), .. } => InstallError::GlobalOnly,
        SourceError::Refused { code: Some("stale"), .. } => InstallError::Stale,
        SourceError::Refused { code: Some("timeout"), .. } => InstallError::Timeout,
        SourceError::Refused { status: Status::UNAUTHORIZED, .. } => InstallError::Unauthorized,
        SourceError::Refused { status: Status::FORBIDDEN, .. } => InstallError::Forbidden,
        SourceError::Refused { status: Status::NOT_FOUND, .. } => InstallError::NotFound,
        SourceError::Refused { status: Status::CONFLICT, .. } => InstallError::Stale,
        SourceError::Refused { status: Status::UNPROCESSABLE_ENTITY, .. } => InstallError::Refused,
        _ => InstallError::Unavailable,
    }
}
