use super::{
    access, cross_host, envelope, file_drafts, legacy, process, read_client_state, startup_command,
    window_flush, window_updates, write_atomically, ClientState, PersistedClientState,
    RendererFlush, StateWriter, CLIENT_STATE_FILENAME, DEFAULT_ZOOM_LEVEL,
};
use legacy::{copy_legacy_shared_state, has_future_legacy_state, migrate_legacy_state};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

impl ClientState {
    pub fn initialize(app: &AppHandle, scoped_client_state_directory: Option<&Path>) -> Self {
        match app.path().app_data_dir() {
            Ok(app_data_dir) => {
                let paths = scoped_client_state_directory
                    .map(|directory| {
                        (
                            Ok(directory.join("election")),
                            Ok(directory.join(CLIENT_STATE_FILENAME)),
                            Ok(None),
                        )
                    })
                    .unwrap_or_else(|| {
                        (
                            cross_host::election_directory(),
                            cross_host::state_path(),
                            cross_host::legacy_state_path().map(Some),
                        )
                    });
                match paths {
                    (Ok(election_dir), Ok(state_path), Ok(legacy_state_path)) => {
                        let legacy_electron = scoped_client_state_directory
                            .is_none()
                            .then(cross_host::legacy_electron_data_directory)
                            .flatten();
                        Self::initialize_managed_at_with_election(
                            &app_data_dir,
                            &election_dir,
                            &state_path,
                            legacy_state_path.as_deref(),
                            legacy_electron.as_deref(),
                        )
                    }
                    (Err(err), _, _) | (_, Err(err), _) | (_, _, Err(err)) => {
                        eprintln!("[client-state] initialization failed; restore disabled: {err}");
                        Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
                    }
                }
            }
            Err(err) => {
                eprintln!("[client-state] initialization failed; restore disabled: {err}");
                Self::disabled(PathBuf::new())
            }
        }
    }

    #[cfg(test)]
    pub(super) fn initialize_managed_at(app_data_dir: &Path) -> Self {
        Self::initialize_at(app_data_dir).unwrap_or_else(|err| {
            eprintln!("[client-state] initialization failed; restore disabled: {err}");
            Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
        })
    }

    fn initialize_managed_at_with_election(
        app_data_dir: &Path,
        election_dir: &Path,
        state_path: &Path,
        legacy_shared_state_path: Option<&Path>,
        legacy_electron_data_dir: Option<&Path>,
    ) -> Self {
        Self::initialize_at_with_writer_and_election(
            app_data_dir,
            election_dir,
            state_path,
            legacy_shared_state_path,
            legacy_electron_data_dir,
            std::sync::Arc::new(write_atomically),
        )
        .unwrap_or_else(|err| {
            eprintln!("[client-state] initialization failed; restore disabled: {err}");
            Self::disabled(app_data_dir.join(CLIENT_STATE_FILENAME))
        })
    }

    fn disabled(state_path: PathBuf) -> Self {
        let mut state = PersistedClientState::default();
        let record = state.active_mut();
        record.restore_enabled = false;
        record.writes_enabled = false;
        Self::new(
            state_path,
            process::ProcessState::disabled(),
            state,
            std::sync::Arc::new(write_atomically),
        )
    }

    fn new(
        state_path: PathBuf,
        process: process::ProcessState,
        state: PersistedClientState,
        write_state: StateWriter,
    ) -> Self {
        let zoom_levels = state
            .window_order
            .iter()
            .map(|id| {
                let record = state.windows.get(id).expect("validated window order");
                let zoom = record
                    .restore_enabled
                    .then(|| record.window.as_ref().map(|window| window.zoom_factor))
                    .flatten()
                    .unwrap_or(DEFAULT_ZOOM_LEVEL);
                (id.clone(), zoom)
            })
            .collect();
        Self {
            state_path,
            process,
            state: Mutex::new(state),
            zoom_levels: Mutex::new(zoom_levels),
            write_lock: Mutex::new(()),
            window_flush: window_flush::WindowFlushScheduler::default(),
            pending_windows: Mutex::new(window_updates::WindowCaptures::default()),
            renderer_access: access::RendererAccess::default(),
            ephemeral_windows: Mutex::new(HashSet::new()),
            renderer_flush: RendererFlush::default(),
            file_draft_readers: file_drafts::Readers::default(),
            startup_commands: startup_command::StartupCommands::default(),
            write_state,
            root_sync_pending: Default::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn initialize_at(app_data_dir: &Path) -> Result<Self, String> {
        Self::initialize_at_with_writer(app_data_dir, std::sync::Arc::new(write_atomically))
    }

    #[cfg(test)]
    pub(crate) fn initialize_at_with_publication_checks(
        app_data_dir: &Path,
        before_rename: impl Fn() -> Result<(), String> + Send + Sync + 'static,
        sync_directory: impl Fn() -> Result<(), String> + Send + Sync + 'static,
    ) -> Result<Self, String> {
        Self::initialize_at_with_writer(
            app_data_dir,
            std::sync::Arc::new(move |path, bytes, valid| {
                before_rename()?;
                super::write_atomically_with_sync(path, bytes, valid, |parent| {
                    sync_directory()?;
                    super::partitions::sync_directory(parent)
                })
            }),
        )
    }

    #[cfg(test)]
    pub(super) fn initialize_at_with_writer(
        app_data_dir: &Path,
        write_state: StateWriter,
    ) -> Result<Self, String> {
        Self::initialize_at_with_writer_and_election(
            app_data_dir,
            &app_data_dir.join(".cross-host-election"),
            &app_data_dir.join(CLIENT_STATE_FILENAME),
            None,
            None,
            write_state,
        )
    }

    pub(super) fn initialize_at_with_writer_and_election(
        app_data_dir: &Path,
        election_dir: &Path,
        state_path: &Path,
        legacy_shared_state_path: Option<&Path>,
        legacy_electron_data_dir: Option<&Path>,
        write_state: StateWriter,
    ) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir).map_err(|err| {
            format!(
                "failed to create app data directory {}: {err}",
                app_data_dir.display()
            )
        })?;

        let registration = process::Registration::initialize(
            app_data_dir,
            election_dir,
            legacy_electron_data_dir,
        )?;
        if registration.is_primary() && !state_path.exists() {
            if let Some(legacy_path) = legacy_shared_state_path {
                copy_legacy_shared_state(legacy_path, state_path, &|| registration.is_primary())?;
            }
        }
        let future_legacy =
            !state_path.exists() && has_future_legacy_state(app_data_dir, legacy_electron_data_dir);
        if registration.is_primary() && !state_path.exists() && !future_legacy {
            migrate_legacy_state(state_path, app_data_dir, legacy_electron_data_dir, &|| {
                registration.is_primary()
            })?;
        }
        let state = if registration.is_primary() {
            if future_legacy {
                envelope::unsupported()
            } else {
                read_client_state(state_path)
            }
        } else {
            PersistedClientState::default()
        };
        let process = registration.finish();
        Ok(Self::new(
            state_path.to_path_buf(),
            process,
            state,
            write_state,
        ))
    }
}
