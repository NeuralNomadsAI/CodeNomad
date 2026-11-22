use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

/// Explicit launch inputs; the host never discovers or edits a user's profile.
#[derive(Clone)]
pub struct LaunchConfig {
    pub executable: PathBuf,
    pub working_directory: PathBuf,
    pub config_file: PathBuf,
    pub profile: String,
    pub config_identity: String,
    pub environment: BTreeMap<OsString, OsString>,
    pub startup_timeout: Duration,
    pub ephemeral_ports: bool,
}
impl LaunchConfig {
    pub fn explicit(
        executable: PathBuf,
        working_directory: PathBuf,
        config_file: PathBuf,
        profile: &str,
        environment: BTreeMap<OsString, OsString>,
    ) -> io::Result<Self> {
        let profile = profile_name(profile)?;
        if !executable.is_absolute()
            || !working_directory.is_absolute()
            || !config_file.is_absolute()
        {
            return Err(io::Error::other(
                "Explicit absolute host paths are required",
            ));
        }
        let config_identity = identity(&config_file)?;
        Ok(Self {
            executable,
            working_directory,
            config_file,
            profile,
            config_identity,
            environment,
            startup_timeout: Duration::from_secs(60),
            ephemeral_ports: false,
        })
    }
    /// Allocate one fresh test profile. Its root must not already exist.
    pub fn trial(executable: PathBuf, root: &Path, profile: &str) -> io::Result<Self> {
        let profile = profile_name(profile)?;
        let lexical = root
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        // The service resolver ignores custom paths inside its retired installation root.
        // Refuse those roots before creating files so the absent CLI cannot trigger fallback.
        let retired = lexical
            .split('/')
            .collect::<Vec<_>>()
            .windows(4)
            .any(|parts| parts == [".local", "share", "codenomad", "opencode"]);
        if !profile.starts_with("trial-") || !root.is_absolute() {
            return Err(io::Error::other(
                "A trial profile and absolute private root are required",
            ));
        }
        if retired {
            return Err(io::Error::other(
                "Trial root conflicts with service binary discovery",
            ));
        }
        fs::create_dir(root)?;
        for dir in [
            "home",
            "config",
            "temp",
            "working",
            "home/AppData/Roaming",
            "home/AppData/Local",
            "home/.config",
            "home/.local/share",
            "home/.local/state",
            "home/.cache",
        ] {
            fs::create_dir_all(root.join(dir))?;
        }
        let config = root.join("config/config.yaml");
        // `serve` ignores the bench's CNRS_FIXTURE_URL. A custom absent CLI wins over
        // installed/PATH discovery and closes every trial's native-service boundary.
        let blocked_cli = root.join("disabled-opencode-cli");
        let settings = serde_json::json!({"server": {"opencodeBinary": blocked_cli}});
        fs::write(
            &config,
            serde_json::to_vec_pretty(&settings).map_err(io::Error::other)?,
        )?;
        let mut environment: BTreeMap<OsString, OsString> = std::env::vars_os()
            .filter(|(key, _)| {
                matches!(
                    key.to_string_lossy().to_ascii_uppercase().as_str(),
                    "PATH"
                        | "PATHEXT"
                        | "SYSTEMROOT"
                        | "WINDIR"
                        | "COMSPEC"
                        | "SYSTEMDRIVE"
                        | "PROCESSOR_ARCHITECTURE"
                        | "NUMBER_OF_PROCESSORS"
                        | "LANG"
                        | "LC_ALL"
                        | "LD_LIBRARY_PATH"
                        | "DYLD_LIBRARY_PATH"
                )
            })
            .collect();
        for (key, path) in [
            ("HOME", "home"),
            ("USERPROFILE", "home"),
            ("APPDATA", "home/AppData/Roaming"),
            ("LOCALAPPDATA", "home/AppData/Local"),
            ("XDG_CONFIG_HOME", "home/.config"),
            ("XDG_DATA_HOME", "home/.local/share"),
            ("XDG_STATE_HOME", "home/.local/state"),
            ("XDG_CACHE_HOME", "home/.cache"),
            ("TEMP", "temp"),
            ("TMP", "temp"),
            ("TMPDIR", "temp"),
        ] {
            environment.insert(key.into(), root.join(path).into_os_string());
        }
        environment.insert("CODENOMAD_REMOTE_CONTROL".into(), "disabled".into());
        let mut config = Self::explicit(
            executable,
            root.join("working"),
            config,
            &profile,
            environment,
        )?;
        config.ephemeral_ports = true;
        Ok(config)
    }
    pub(super) fn command(&self, cookie: &str) -> io::Result<Command> {
        // Revalidate public inputs just before spawning as a caller can retain a config.
        if profile_name(&self.profile)? != self.profile
            || identity(&self.config_file)? != self.config_identity
            || !self.executable.is_absolute()
            || !self.working_directory.is_absolute()
        {
            return Err(io::Error::other("Host launch identity changed"));
        }
        let mut command = Command::new(&self.executable);
        command
            .env_clear()
            .envs(&self.environment)
            .current_dir(&self.working_directory)
            .args([
                "serve",
                "--host",
                "127.0.0.1",
                "--auth-cookie-name",
                cookie,
                "--generate-token",
                "--unrestricted-root",
                "--https",
                "true",
                "--http",
                "true",
            ])
            .env("CLI_CONFIG", &self.config_file)
            .env("CODENOMAD_PROFILE", &self.profile)
            .env("CODENOMAD_UPDATE_CHANNEL", &self.profile)
            .env("CODENOMAD_PROFILE_CONFIG_IDENTITY", &self.config_identity)
            .env("CODENOMAD_NATIVE_PARENT", "1")
            .env("CODENOMAD_NATIVE_BROWSER_AUTOMATION", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if self.ephemeral_ports {
            command.args(["--http-port", "0", "--https-port", "0"]);
        }
        Ok(command)
    }
}
pub(crate) fn profile_name(raw: &str) -> io::Result<String> {
    let name = raw
        .trim_matches(|c| matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' '))
        .to_ascii_lowercase();
    if name.is_empty()
        || name.len() > 64
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(io::Error::other("Invalid CodeNomad data profile"));
    }
    Ok(if name == "default" {
        "stable".into()
    } else {
        name
    })
}
fn identity(path: &Path) -> io::Result<String> {
    if !path.is_absolute() {
        return Err(io::Error::other(
            "An absolute configuration source is required",
        ));
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let text = normalized
        .to_str()
        .ok_or_else(|| io::Error::other("Configuration identity must be Unicode"))?;
    if text.contains('\0') {
        return Err(io::Error::other("Invalid configuration identity"));
    }
    Ok(if cfg!(windows) {
        text.replace('/', "\\").to_ascii_lowercase()
    } else {
        text.into()
    })
}
