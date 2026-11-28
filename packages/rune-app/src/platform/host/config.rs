use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
pub(super) const TRIAL_DIRS: &[&str] = &[
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
];

#[cfg(windows)]
pub(crate) const SERVER_BINARY_NAME: &str = "codenomad-rs.exe";
#[cfg(not(windows))]
pub(crate) const SERVER_BINARY_NAME: &str = "codenomad-rs";

/// Explicit launch inputs; desktop mode uses the standard OS profile layout beside the sibling server.
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
    pub(super) persistent_root: Option<PathBuf>,
    pub(super) state_directory: Option<PathBuf>,
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
            persistent_root: None,
            state_directory: None,
        })
    }
    /// Standard autonomous desktop launch for the sibling `codenomad-rs` binary.
    pub fn desktop(executable: PathBuf) -> io::Result<Self> {
        let inherited: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        let cwd = std::env::current_dir().unwrap_or_else(|_| {
            executable
                .parent()
                .map_or_else(|| PathBuf::from("."), Path::to_path_buf)
        });
        Self::desktop_with_env(executable, &cwd, &inherited)
    }
    pub(crate) fn desktop_with_env(
        executable: PathBuf,
        cwd: &Path,
        inherited: &BTreeMap<OsString, OsString>,
    ) -> io::Result<Self> {
        if !executable.is_absolute() || !is_plain_file(&executable) {
            return Err(io::Error::other("Desktop server executable unavailable"));
        }
        let home = resolve_home(inherited)
            .filter(|dir| dir.is_dir())
            .ok_or_else(|| io::Error::other("User home directory unavailable"))?;
        let profile = resolve_desktop_profile(
            env_string(inherited, "CODENOMAD_PROFILE").as_deref(),
            env_string(inherited, "CODENOMAD_UPDATE_CHANNEL").as_deref(),
        )?;
        let config_file = resolve_desktop_config_path(
            env_string(inherited, "CLI_CONFIG").as_deref(),
            cwd,
            &home,
        )?;
        let default_config = resolve_desktop_config_path(None, cwd, &home)?;
        let default_identity = identity(&default_config)?;
        let environment = desktop_environment(inherited);
        let mut config =
            Self::explicit(executable, home.clone(), config_file, &profile, environment)?;
        let (state_root, state_dir) = desktop_state_directory(
            inherited,
            &home,
            &profile,
            &config.config_identity,
            &default_identity,
        );
        if ensure_state_parent(&state_root, &state_dir).is_ok() {
            config.state_directory = Some(state_dir);
        }
        Ok(config)
    }
    /// Allocate one fresh test profile. Its root must not already exist.
    pub fn trial(executable: PathBuf, root: &Path, profile: &str) -> io::Result<Self> {
        let profile = Self::trial_profile(root, profile)?;
        fs::create_dir(root)?;
        Self::initialize(root)?;
        Self::isolated(executable, root, &profile)
    }
    pub fn persistent(executable: PathBuf, root: &Path, profile: &str) -> io::Result<Self> {
        super::persistent::prepare(executable, root, profile)
    }
    pub(crate) fn state_directory(&self) -> Option<PathBuf> {
        self.state_directory
            .clone()
            .or_else(|| self.persistent_root.as_ref().map(|root| root.join("rune")))
    }
    pub(super) fn trial_profile(root: &Path, profile: &str) -> io::Result<String> {
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
        Ok(profile)
    }
    pub(super) fn initialize(root: &Path) -> io::Result<()> {
        for dir in TRIAL_DIRS {
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
        Ok(())
    }
    pub(super) fn isolated(executable: PathBuf, root: &Path, profile: &str) -> io::Result<Self> {
        let config = root.join("config/config.yaml");
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
pub(super) fn identity(path: &Path) -> io::Result<String> {
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

fn unlinked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        !meta.file_type().is_symlink() && meta.file_attributes() & 0x400 == 0
    }
    #[cfg(not(windows))]
    {
        !meta.file_type().is_symlink()
    }
}

fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && unlinked(&meta))
}

/// Find the sibling `codenomad-rs` strictly inside `current_exe`'s directory, never via `PATH`
/// and never following a symlink or reparse point.
pub(crate) fn discover_sibling_server(current_exe: &Path) -> Option<PathBuf> {
    if !current_exe.is_absolute() {
        return None;
    }
    let dir = current_exe.parent()?;
    let candidate = dir.join(SERVER_BINARY_NAME);
    is_plain_file(&candidate).then_some(candidate)
}

fn env_os<'a>(env: &'a BTreeMap<OsString, OsString>, name: &str) -> Option<&'a OsString> {
    env.iter()
        .find(|(key, _)| key.to_str().is_some_and(|k| k.eq_ignore_ascii_case(name)))
        .map(|(_, value)| value)
}

fn env_string(env: &BTreeMap<OsString, OsString>, name: &str) -> Option<String> {
    env_os(env, name).and_then(|value| value.to_str().map(str::to_owned))
}

fn ascii_trim(raw: &str) -> &str {
    raw.trim_matches(|c| matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' '))
}

pub(crate) fn resolve_desktop_profile(
    profile: Option<&str>,
    legacy_channel: Option<&str>,
) -> io::Result<String> {
    if let Some(raw) = profile.filter(|value| !ascii_trim(value).is_empty()) {
        return profile_name(raw);
    }
    if let Some(raw) = legacy_channel.filter(|value| !ascii_trim(value).is_empty()) {
        return profile_name(raw);
    }
    Ok("stable".into())
}

fn resolve_home(env: &BTreeMap<OsString, OsString>) -> Option<PathBuf> {
    let candidate = |name: &str| {
        env_os(env, name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    #[cfg(windows)]
    {
        candidate("USERPROFILE")
            .or_else(|| {
                let drive = env_string(env, "HOMEDRIVE")?;
                let path = env_string(env, "HOMEPATH")?;
                let joined = PathBuf::from(format!("{drive}{path}"));
                joined.is_absolute().then_some(joined)
            })
            .or_else(|| candidate("HOME"))
    }
    #[cfg(not(windows))]
    {
        candidate("HOME")
    }
}

fn resolve_desktop_config_path(raw: Option<&str>, cwd: &Path, home: &Path) -> io::Result<PathBuf> {
    let trimmed = raw.map(str::trim).filter(|value| !value.is_empty());
    let Some(value) = trimmed else {
        return Ok(home.join(".config").join("codenomad").join("config.yaml"));
    };
    let expanded = if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| cfg!(windows).then(|| value.strip_prefix("~\\")).flatten())
    {
        home.join(rest)
    } else {
        let path = PathBuf::from(value);
        if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        }
    };
    let mut normalized = PathBuf::new();
    for component in expanded.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    if !normalized.is_absolute() {
        return Err(io::Error::other(
            "An absolute configuration source is required",
        ));
    }
    if normalized
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        normalized.set_file_name("config.yaml");
    } else if !normalized
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml"))
    {
        normalized.push("config.yaml");
    }
    Ok(normalized)
}

fn desktop_environment(inherited: &BTreeMap<OsString, OsString>) -> BTreeMap<OsString, OsString> {
    inherited
        .iter()
        .filter(|(key, _)| {
            let upper = key.to_string_lossy().to_ascii_uppercase();
            !upper.starts_with("RUNE_")
                && !upper.starts_with("CNRS_")
                && !matches!(
                    upper.as_str(),
                    "CLI_CONFIG"
                        | "CLI_HOST"
                        | "CLI_HTTP"
                        | "CLI_HTTPS"
                        | "CLI_HTTP_PORT"
                        | "CLI_HTTPS_PORT"
                        | "CLI_LAUNCH"
                        | "CLI_UPGRADE"
                        | "CLI_WORKSPACE_ROOT"
                        | "CLI_UNRESTRICTED_ROOT"
                        | "CODENOMAD_PROFILE"
                        | "CODENOMAD_UPDATE_CHANNEL"
                        | "CODENOMAD_PROFILE_CONFIG_IDENTITY"
                        | "CODENOMAD_NATIVE_PARENT"
                        | "CODENOMAD_NATIVE_BROWSER_AUTOMATION"
                        | "CODENOMAD_SERVER_PASSWORD"
                        | "CODENOMAD_SKIP_AUTH"
                        | "CODENOMAD_AUTH_COOKIE_NAME"
                        | "CODENOMAD_GENERATE_TOKEN"
                        | "CODENOMAD_BOOTSTRAP_TOKEN"
                        | "CODENOMAD_LOCKED_HOST"
                        | "CODENOMAD_DEV"
                        | "ELECTRON_RUN_AS_NODE"
                        | "ELECTRON_NO_ASAR"
                )
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn desktop_state_directory(
    env: &BTreeMap<OsString, OsString>,
    home: &Path,
    profile: &str,
    config_identity: &str,
    default_identity: &str,
) -> (PathBuf, PathBuf) {
    let root = if cfg!(windows) {
        env_os(env, "LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join("AppData").join("Local"))
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        env_os(env, "XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".local").join("share"))
    };
    let leaf = if profile == "stable" && config_identity == default_identity {
        "default".to_owned()
    } else {
        format!("{profile}-{}", scope_suffix(profile, config_identity))
    };
    let state_dir = root.join("CodeNomad").join("rune").join(leaf);
    (root, state_dir)
}

fn ensure_state_parent(root: &Path, state_dir: &Path) -> io::Result<()> {
    let parent = state_dir
        .parent()
        .ok_or_else(|| io::Error::other("Missing Rune state parent"))?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| io::Error::other("Rune state directory outside base root"))?;
    fs::create_dir_all(root)?;
    let root_meta = fs::symlink_metadata(root)?;
    if !root_meta.is_dir() || !unlinked(&root_meta) {
        return Err(io::Error::other("Invalid Rune state base root"));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(io::Error::other("Invalid Rune state path segment"));
        };
        current.push(segment);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let meta = fs::symlink_metadata(&current)?;
        if !meta.is_dir() || !unlinked(&meta) {
            return Err(io::Error::other("Invalid Rune state directory"));
        }
    }
    Ok(())
}

/// First 16 lowercase hex chars of SHA-256(`"{profile}\0{config_identity}"`),
/// matching `dev-docs/DESKTOP_DATA_PROFILES.md`.
pub(crate) fn scope_suffix(profile: &str, config_identity: &str) -> String {
    let mut input = Vec::with_capacity(profile.len() + 1 + config_identity.len());
    input.extend_from_slice(profile.as_bytes());
    input.push(0);
    input.extend_from_slice(config_identity.as_bytes());
    let digest = sha256(&input);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(16);
    for &byte in &digest[..8] {
        hex.push(HEX[(byte >> 4) as usize] as char);
        hex.push(HEX[(byte & 0x0f) as usize] as char);
    }
    hex
}

fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(data.len() + 72);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    for block in padded.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
        for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, delta) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(delta);
        }
    }
    let mut out = [0u8; 32];
    for (chunk, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(state) {
        *chunk = word.to_be_bytes();
    }
    out
}
