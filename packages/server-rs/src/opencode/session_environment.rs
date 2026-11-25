use crate::{Error, error};
use axum::http::StatusCode as Status;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) fn unavailable() -> Error {
    error(Status::BAD_GATEWAY, "session_environment_failed")
}

pub(super) async fn snapshot(file: PathBuf) -> Result<BTreeMap<String, String>, Error> {
    static READER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    tokio::time::timeout(Duration::from_secs(2), async {
        #[cfg(test)]
        crate::worktrees::fence_test_trace::record("environment semaphore", "waiting");
        let slot = READER.acquire().await.ok()?;
        #[cfg(test)]
        let trace = crate::worktrees::fence_test_trace::held("environment semaphore");
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            #[cfg(test)]
            let _trace = trace;
            read(&file)
        })
        .await
        .ok()
        .flatten()
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(unavailable)
}

fn read(file: &Path) -> Option<BTreeMap<String, String>> {
    const LIMIT: u64 = 1024 * 1024;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let configured = match options.open(file) {
        Ok(handle) => {
            let stat = handle.metadata().ok()?;
            if !stat.is_file() || stat.len() > LIMIT {
                return None;
            }
            let mut input = Vec::new();
            handle.take(LIMIT + 1).read_to_end(&mut input).ok()?;
            if input.len() as u64 > LIMIT {
                return None;
            }
            let text = std::str::from_utf8(&input).ok()?;
            // Bound both absolute materialization and amplification of short alias-heavy input.
            let mut expanded = (4 * LIMIT as usize).min(input.len().saturating_mul(24).saturating_add(256));
            let Value::Object(mut document) =
                Limited(&mut expanded, text).deserialize(serde_norway::Deserializer::from_str(text)).ok()?
            else {
                return None;
            };
            if document.contains_key("preferences") {
                return None;
            }
            let current = match document.remove("server") {
                None => None,
                Some(Value::Object(mut owner)) => owner.remove("environmentVariables"),
                _ => return None,
            };
            match current {
                None => Default::default(),
                Some(Value::Object(vars)) => vars,
                _ => return None,
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound && absent(file) => Default::default(),
        Err(_) => return None,
    };
    variables(configured)
}

fn variables(configured: serde_json::Map<String, Value>) -> Option<BTreeMap<String, String>> {
    let valid = |key: &str, value: &str| !key.is_empty() && !key.contains(['=', '\0']) && !value.contains('\0');
    let mut snapshot = BTreeMap::new();
    let mut put = |key: String, value: String| {
        let upper = key.to_ascii_uppercase();
        const PRIVATE: &str = "OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD CODENOMAD_SERVER_PASSWORD \
            CODENOMAD_AUTOMATION_BRIDGE_TOKEN CODENOMAD_BOOTSTRAP_TOKEN OPENCODE_DB XDG_STATE_HOME OPENCODE_CONFIG_CONTENT";
        if !upper.starts_with("CNRS_") && !PRIVATE.split(' ').any(|name| name == upper) {
            snapshot.insert(if cfg!(windows) { upper } else { key.clone() }, (key, value));
        }
    };
    for (key, value) in std::env::vars_os() {
        if let (Ok(key), Ok(value)) = (key.into_string(), value.into_string())
            && valid(&key, &value)
        {
            put(key, value);
        }
    }
    for (key, value) in configured {
        let Value::String(value) = value else { return None };
        if !valid(&key, &value) {
            return None;
        }
        put(key, value);
    }
    Some(snapshot.into_values().collect())
}

/// Debit every expanded object entry, sequence element and string before collecting it.
struct Limited<'a, 'de>(&'a mut usize, &'de str);
impl Limited<'_, '_> {
    fn take<E: de::Error>(&mut self, n: usize) -> Result<(), E> {
        *self.0 = self.0.checked_sub(n).ok_or_else(|| E::custom("Expanded environment document too large"))?;
        Ok(())
    }
}
impl<'de> DeserializeSeed<'de> for Limited<'_, 'de> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(mut self, input: D) -> Result<Value, D::Error> {
        self.take(64)?;
        input.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Limited<'_, 'de> {
    type Value = Value;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("bounded config data")
    }
    fn visit_str<E: de::Error>(mut self, value: &str) -> Result<Value, E> {
        self.take(value.len())?;
        Ok(value.into())
    }
    fn visit_borrowed_str<E: de::Error>(self, value: &'de str) -> Result<Value, E> {
        let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
        let offset = (value.as_ptr() as usize).checked_sub(self.1.as_ptr() as usize);
        if let Some(prefix) = offset.and_then(|n| self.1.get(..n)) {
            let unquoted = !prefix.ends_with(['\'', '"']);
            let tag = prefix.trim_end_matches(['\'', '"']).split_whitespace().next_back();
            if matches!(tag, Some("!!binary" | "!<tag:yaml.org,2002:binary>"))
                || unquoted
                    && digits.len() > 1
                    && digits.starts_with('0')
                    && digits.bytes().all(|b| b.is_ascii_digit())
                    && !matches!(tag, Some("!!str" | "!<tag:yaml.org,2002:str>"))
            {
                return Ok(Value::Null);
            }
        }
        self.visit_str(value)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut input: S) -> Result<Value, S::Error> {
        let mut result = Vec::new();
        while let Some(value) = input.next_element_seed(Limited(self.0, self.1))? {
            result.push(value);
        }
        Ok(Value::Array(result))
    }
    fn visit_map<M: MapAccess<'de>>(self, mut input: M) -> Result<Value, M::Error> {
        let mut result = serde_json::Map::new();
        while let Some(key) = input.next_key_seed(Limited(self.0, self.1))? {
            let Value::String(key) = key else { return Err(de::Error::custom("Invalid config key")) };
            let value = input.next_value_seed(Limited(self.0, self.1))?;
            if result.insert(key, value).is_some() {
                return Err(de::Error::custom("Duplicate config key"));
            }
        }
        Ok(Value::Object(result))
    }
}

fn absent(path: &Path) -> bool {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Ok(_) => return ancestor != path && fs::metadata(ancestor).is_ok_and(|meta| meta.is_dir()),
            Err(_) => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_profile_overrides_do_not_materialize_large_aliases() {
        let dir = crate::shared::test_dir("command-env");
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.yaml");
        fs::write(&config, "server: {environmentVariables: {CNOMAD_TEST_COMMAND: first, OPENCODE_DB: private}}\n")
            .unwrap();
        let first = read(&config).unwrap();
        assert_eq!(first["CNOMAD_TEST_COMMAND"], "first");
        assert!(!first.contains_key("OPENCODE_DB"));
        fs::write(&config, "server: {environmentVariables: {CNOMAD_TEST_COMMAND: second}}\n").unwrap();
        assert_eq!(read(&config).unwrap()["CNOMAD_TEST_COMMAND"], "second");
        fs::write(&config, "preferences: {environmentVariables: {CNOMAD_TEST_COMMAND: profile}}\n").unwrap();
        assert!(read(&config).is_none());
        fs::write(&config, "server: {environmentVariables: {CNOMAD_TEST_COMMAND: 0012}}\n").unwrap();
        assert!(read(&config).is_none());
        fs::write(&config, "server: {environmentVariables: {CNOMAD_TEST_COMMAND: '0012'}}\n").unwrap();
        assert_eq!(read(&config).unwrap()["CNOMAD_TEST_COMMAND"], "0012");
        let text = format!(
            "scalar: &large {}\nrepeated: [{}*large]\nserver: {{}}\n",
            "x".repeat(80_000),
            "*large, ".repeat(60)
        );
        assert!(text.len() < 1024 * 1024);
        fs::write(&config, text).unwrap();
        assert!(read(&config).is_none());
        fs::write(&config,
            "a: &a [secret-value]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\nserver: {}\n"
        ).unwrap();
        assert!(read(&config).is_none());
        fs::remove_file(&config).unwrap();
        fs::remove_dir(&dir).unwrap();
    }
}
