use super::{valid_id, Engine, SpeechError};
use crate::profile_transition::SelectionLock;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    time::SystemTime,
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
pub(super) struct Preference {
    version: u8,
    pub(super) engine: Engine,
    pub(super) revision: String,
}

#[derive(Clone)]
pub(super) struct Store(pub(super) PathBuf);

impl Store {
    pub(super) fn read(&self) -> Result<Preference, SpeechError> {
        let file = match File::open(&self.0) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Preference {
                    version: 1,
                    engine: Engine::Api,
                    revision: String::new(),
                });
            }
            Err(_) => return Err(SpeechError::Failed),
        };
        let mut bytes = Vec::new();
        file.take(257)
            .read_to_end(&mut bytes)
            .map_err(|_| SpeechError::Failed)?;
        if bytes.len() == 257 {
            return Err(SpeechError::Failed);
        }
        let value: Preference = serde_json::from_slice(&bytes).map_err(|_| SpeechError::Failed)?;
        if value.version != 1 || !valid_id(&value.revision) {
            return Err(SpeechError::Failed);
        }
        Ok(value)
    }

    pub(super) fn select(&self, engine: Engine, expected: Option<&str>) -> Result<(), SpeechError> {
        let directory = self.0.parent().ok_or(SpeechError::Failed)?;
        fs::create_dir_all(directory).map_err(|_| SpeechError::Failed)?;
        let _lock = SelectionLock::acquire(directory, SystemTime::now())
            .map_err(|_| SpeechError::Failed)?
            .ok_or(SpeechError::Busy)?;
        let current = self.read()?;
        if expected.is_some_and(|revision| revision != current.revision) {
            return Err(SpeechError::PlanChanged);
        }
        let value = Preference {
            version: 1,
            engine,
            revision: Uuid::new_v4().to_string(),
        };
        let mut temporary =
            tempfile::NamedTempFile::new_in(directory).map_err(|_| SpeechError::Failed)?;
        serde_json::to_writer(&mut temporary, &value).map_err(|_| SpeechError::Failed)?;
        temporary.flush().map_err(|_| SpeechError::Failed)?;
        temporary
            .persist(&self.0)
            .map_err(|_| SpeechError::Failed)?;
        Ok(())
    }
}
