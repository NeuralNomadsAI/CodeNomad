//! `codenomad serve` with the reference's grammar and defaults (`parseCliOptions`, `resolveConfigLocation`):
//! a flag wins over its `CLI_*`/`CODENOMAD_*` variable, which wins over the default; bare words such
//! as `serve` are ignored. Options with no ported effect are accepted, or refused when ignoring them
//! would silently drop what was asked (`--launch`, `--upgrade`).
use std::{collections::HashMap, env, ffi::OsString, net::IpAddr, path::PathBuf, time::Duration};

use super::{Bind, Launch, ui};
use crate::{
    auth,
    settings::document::{Location, destination},
};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Value,
    Flag,
    Optional,
}
use Kind::*;

const OPTIONS: [(&str, Kind, &str); 26] = [
    ("host", Value, "CLI_HOST"),
    ("https", Value, "CLI_HTTPS"),
    ("http", Value, "CLI_HTTP"),
    ("https-port", Value, "CLI_HTTPS_PORT"),
    ("http-port", Value, "CLI_HTTP_PORT"),
    ("tls-key", Value, "CLI_TLS_KEY"),
    ("tls-cert", Value, "CLI_TLS_CERT"),
    ("tls-ca", Value, "CLI_TLS_CA"),
    ("tlsSANs", Value, "CLI_TLS_SANS"),
    ("workspace-root", Value, "CLI_WORKSPACE_ROOT"),
    ("unrestricted-root", Flag, "CLI_UNRESTRICTED_ROOT"),
    ("config", Value, "CLI_CONFIG"),
    ("log-level", Value, "CLI_LOG_LEVEL"),
    ("log-destination", Value, "CLI_LOG_DESTINATION"),
    ("ui-dir", Value, "CLI_UI_DIR"),
    ("ui-dev-server", Value, "CLI_UI_DEV_SERVER"),
    ("ui-no-update", Flag, "CLI_UI_NO_UPDATE"),
    ("ui-auto-update", Value, "CLI_UI_AUTO_UPDATE"),
    ("ui-manifest-url", Value, "CLI_UI_MANIFEST_URL"),
    ("launch", Flag, "CLI_LAUNCH"),
    ("username", Value, "CODENOMAD_SERVER_USERNAME"),
    ("password", Value, "CODENOMAD_SERVER_PASSWORD"),
    ("auth-cookie-name", Value, "CODENOMAD_AUTH_COOKIE_NAME"),
    ("generate-token", Flag, "CODENOMAD_GENERATE_TOKEN"),
    ("dangerously-skip-auth", Flag, "CODENOMAD_SKIP_AUTH"),
    ("upgrade", Optional, ""),
];

pub enum Command {
    Serve(Box<Launch>),
    /// `--version` or `--help`: printed, exit 0.
    Print(String),
}

/// Whether these arguments start `serve` rather than the positional bench launch.
pub fn serves(args: &[String]) -> bool {
    args.first().is_none_or(|first| first == "serve" || first.starts_with('-'))
}

pub fn parse(args: &[String]) -> Result<Command, String> {
    let mut given: HashMap<&str, Option<String>> = HashMap::new();
    let mut rest = args.iter().peekable();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--" => break,
            "-v" | "--version" => return Ok(Command::Print(crate::config::VERSION.into())),
            "-h" | "--help" => return Ok(Command::Print(help())),
            word if !word.starts_with('-') || word == "-" => continue,
            _ => {}
        }
        let unknown = || format!("unknown option '{arg}'");
        let body = arg.strip_prefix("--").ok_or_else(unknown)?;
        let (name, inline) = body.split_once('=').map_or((body, None), |(n, v)| (n, Some(v.to_owned())));
        let &(name, kind, _) = OPTIONS.iter().find(|o| o.0 == name).ok_or_else(unknown)?;
        let value = match (kind, inline) {
            (Flag, Some(_)) => return Err(format!("option '--{name}' does not take an argument")),
            (Flag, None) => None,
            (_, Some(value)) => Some(value),
            (Value, None) => Some(rest.next().cloned().ok_or(format!("option '--{name} <value>' argument missing"))?),
            (Optional, None) => rest.next_if(|next| !(next.len() > 1 && next.starts_with('-'))).cloned(),
        };
        given.insert(name, value);
    }
    let variable = |name: &str| OPTIONS.iter().find(|o| o.0 == name).map(|o| o.2).filter(|v| !v.is_empty());
    let value = |name: &str| given.get(name).cloned().flatten().or_else(|| env::var(variable(name)?).ok());
    let path =
        |name: &str| given.get(name).cloned().flatten().map(OsString::from).or_else(|| env::var_os(variable(name)?));
    let explicit = |name: &str| {
        args.iter().any(|a| a == &format!("--{name}") || a.starts_with(&format!("--{name}=")))
            || variable(name).and_then(env::var_os).is_some_and(|v| !v.is_empty())
    };
    let flag = |name: &str| Ok::<_, String>(variable(name).map_or(Ok(false), switch)? || given.contains_key(name));
    if given.contains_key("upgrade") {
        return Err("--upgrade is not supported by the Rust server".into());
    }
    if flag("launch")? {
        return Err("--launch is not supported by the Rust server".into());
    }
    flag("ui-no-update")?;

    let remote_control = env::var("CODENOMAD_REMOTE_CONTROL").unwrap_or_default();
    if !remote_control.is_empty() && remote_control.trim().to_lowercase() != "disabled" {
        return Err("CODENOMAD_REMOTE_CONTROL accepts only \"disabled\"".into());
    }
    let locked = env::var("CODENOMAD_LOCKED_HOST").unwrap_or_default();
    if !locked.is_empty() && locked.trim().is_empty() {
        return Err("CODENOMAD_LOCKED_HOST must be an address".into());
    }
    let host = if locked.is_empty() {
        resolve_host(&value("host").unwrap_or_default(), "--host")?
    } else {
        resolve_host(&locked, "CODENOMAD_LOCKED_HOST")?
    };
    let enabled = |name: &str, default: &str| {
        matches!(
            value(name).unwrap_or(default.into()).trim().to_lowercase().as_str(),
            "1" | "true" | "yes" | "y" | "on"
        )
    };
    let (https, http) = (enabled("https", "true"), enabled("http", "false"));
    if !https && !http {
        return Err("At least one listener must be enabled (--https or --http)".into());
    }
    let port = |name: &str, default: u16| value(name).map_or(Ok(default), |v| parse_port(&v));
    let (https_port, http_port) = (port("https-port", 9898)?, port("http-port", 9899)?);
    let root =
        path("workspace-root").map_or_else(env::current_dir, |p| Ok(PathBuf::from(p))).map_err(|e| e.to_string())?;
    let unrestricted = flag("unrestricted-root")?;
    let settings = Location::resolve(&value("config").unwrap_or_default());
    let (base, yaml) = (settings.base.clone(), settings.config.clone());

    let ip: IpAddr =
        host.parse().map_err(|_| format!("--host {host}: the Rust server listens on IP addresses only"))?;
    let loopback = IpAddr::from([127, 0, 0, 1]);
    // `httpBindHost`: loopback unless HTTP is the only, non-desktop listener.
    let http_ip = if http && !https && !super::native_parent::available() { ip } else { loopback };
    if http_ip != loopback {
        return Err(format!("--host {host}: the Rust server serves HTTP on 127.0.0.1 only"));
    }
    let tls = [path("tls-key"), path("tls-cert"), path("tls-ca")];
    if tls[0].is_some() != tls[1].is_some() {
        return Err("--tls-key and --tls-cert must be provided together".into());
    }
    let https = https.then(|| auth::tls::Settings {
        bind: Bind { ip, port: https_port, fallback: !explicit("https-port") },
        name: if ip == loopback || ip.is_unspecified() {
            "localhost".into()
        } else if ip.is_ipv6() {
            format!("[{ip}]")
        } else {
            ip.to_string()
        },
        dir: base.join("tls"),
        files: if tls[0].is_some() { tls } else { Default::default() },
        sans: value("tlsSANs").unwrap_or_default(),
    });
    let skip = flag("dangerously-skip-auth")?;
    let auth = auth::Settings {
        username: value("username").unwrap_or(auth::DEFAULT_USERNAME.into()),
        password: value("password"),
        file: Some(yaml.parent().unwrap_or(&base).join("auth.json")),
        cookie: auth::cookie_name(value("auth-cookie-name").as_deref()),
        token: flag("generate-token")?,
        managed_local: super::native_parent::available(),
        skip,
        idle: timeout("CODENOMAD_SESSION_IDLE_SECONDS", 86400)?,
        absolute: timeout("CODENOMAD_SESSION_ABSOLUTE_SECONDS", 7 * 86400)?,
    };
    let ui = match value("ui-dev-server") {
        Some(url) => ui::Source::Dev(reqwest::Url::parse(&url).map_err(|e| format!("--ui-dev-server: {e}"))?),
        None if explicit("ui-dir") => ui::Source::Dir(path("ui-dir").unwrap_or_default().into(), "override"),
        None => ui::Source::bundled(),
    };
    Ok(Command::Serve(Box::new(Launch {
        root,
        identity: destination(&yaml).ok().map(|path| PathBuf::from(format!("{}.server-id", path.display()))),
        data: base,
        settings,
        unrestricted,
        // No saved selection is read yet: the default OpenCode installation.
        binary: PathBuf::new(),
        http: Bind { ip: http_ip, port: if http { http_port } else { 0 }, fallback: !(http && explicit("http-port")) },
        https,
        auth,
        ui,
        serve: true,
    })))
}

/// `parseBooleanSwitchEnv`: switches without a value read their variable strictly.
pub fn switch(name: &str) -> Result<bool, String> {
    match env::var(name).unwrap_or_default().trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" | "" => Ok(false),
        _ => Err(format!("{name} must be 1, true, yes, on, 0, false, no, off, or empty (case-insensitive)")),
    }
}

/// `Number(input)` as an integer port; an empty value is 0, as in the reference.
fn parse_port(input: &str) -> Result<u16, String> {
    let number = if input.trim().is_empty() { Some(0.0) } else { input.trim().parse::<f64>().ok() };
    number
        .filter(|n| n.fract() == 0.0 && (0.0..=65535.0).contains(n))
        .map(|n| n as u16)
        .ok_or_else(|| format!("Port must be an integer between 0 and 65535 (got '{input}')"))
}

/// `resolveHost`: brackets, case and IPv4-mapped IPv6 normalized, `localhost` and empty as 127.0.0.1.
fn resolve_host(input: &str, source: &str) -> Result<String, String> {
    let value = input.trim();
    let value = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')).unwrap_or(value).to_lowercase();
    if value.is_empty() || value == "localhost" {
        return Ok("127.0.0.1".into());
    }
    if value.contains('%') && value.split('%').next().is_some_and(|v| v.parse::<std::net::Ipv6Addr>().is_ok()) {
        return Err(format!("IPv6 zone identifiers are not supported in {source}"));
    }
    Ok(match value.parse::<IpAddr>() {
        Ok(IpAddr::V6(v6)) => v6.to_ipv4_mapped().map_or(v6.to_string(), |v4| v4.to_string()),
        Ok(ip) => ip.to_string(),
        Err(_) => value,
    })
}

fn timeout(name: &str, default: u64) -> Result<Duration, String> {
    let Ok(value) = env::var(name) else { return Ok(Duration::from_secs(default)) };
    value
        .parse::<u64>()
        .ok()
        .filter(|s| value.bytes().all(|b| b.is_ascii_digit()) && *s > 0 && *s < (1 << 53) / 1000)
        .map(Duration::from_secs)
        .ok_or(format!("{name} must be a positive integer number of seconds"))
}

fn help() -> String {
    let mut text = String::from("Usage: codenomad [serve] [options]\n\nOptions:\n  -v, --version\n  -h, --help\n");
    for (name, kind, variable) in OPTIONS {
        let value = match kind {
            Value => " <value>",
            Flag => "",
            Optional => " [version]",
        };
        let variable = if variable.is_empty() { String::new() } else { format!("  (env: {variable})") };
        text += &format!("  --{name}{value}{variable}\n");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(args: &[&str]) -> Result<Launch, String> {
        match parse(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())? {
            Command::Serve(launch) => Ok(*launch),
            Command::Print(_) => Err("printed".into()),
        }
    }

    /// Tauri's exact arguments (`cli_manager.rs` `build_args`). Variables the grammar reads are left
    /// to the environment of the test process, which sets none of them.
    #[test]
    fn desktop_arguments_and_reference_defaults() {
        let cookie = "codenomad_session_42_1700000000000";
        let prod =
            ["serve", "--host", "127.0.0.1", "--auth-cookie-name", cookie, "--generate-token", "--unrestricted-root"];
        let l = launch(&[&prod[..], &["--https", "true", "--http", "true"]].concat()).unwrap();
        assert!(l.serve && l.auth.token && !l.auth.skip && l.auth.cookie == cookie && l.auth.username == "codenomad");
        assert_eq!((l.http.ip.to_string(), l.http.port, l.http.fallback), ("127.0.0.1".into(), 9899, true));
        let https = l.https.unwrap();
        assert_eq!((https.bind.port, https.bind.fallback, https.name.as_str()), (9898, true, "localhost"));
        assert!(l.data.ends_with(std::path::Path::new(".config").join("codenomad")) && https.dir == l.data.join("tls"));
        assert_eq!(l.identity, Some(l.data.join("config.yaml.server-id")));
        assert_eq!(l.auth.file.unwrap(), l.data.join("auth.json"));
        assert_eq!((l.auth.idle.as_secs(), l.auth.absolute.as_secs()), (86400, 604800));

        let dev = [&prod[..], &["--https", "false", "--http", "true", "--http-port", "0"]].concat();
        let l =
            launch(&[&dev[..], &["--ui-dev-server", "http://localhost:3000", "--log-level", "info"]].concat()).unwrap();
        assert!(l.https.is_none() && (l.http.port, l.http.fallback) == (0, false));
        assert!(matches!(l.ui, ui::Source::Dev(ref u) if u.as_str() == "http://localhost:3000/"));
        let l = launch(&["--http=yes", "--https=0", "--http-port=4100", "--config", "x/custom.yml"]).unwrap();
        assert!(l.https.is_none() && (l.http.port, l.http.fallback) == (4100, false));
        assert!(l.identity.as_deref().is_some_and(|p| p.ends_with("x/custom.yml.server-id")) && l.data.ends_with("x"));
        assert!(
            launch(&["--config", "y/config.json"])
                .unwrap()
                .identity
                .as_deref()
                .is_some_and(|p| p.ends_with("y/config.yaml.server-id"))
        );
        assert!(
            launch(&["--config", "z"])
                .unwrap()
                .identity
                .as_deref()
                .is_some_and(|p| p.ends_with("z/config.yaml.server-id"))
        );
        assert_eq!(launch(&["--auth-cookie-name", " a b;c "]).unwrap().auth.cookie, "a_b_c");
        assert_eq!(launch(&["--host", "LOCALHOST"]).unwrap().https.unwrap().name, "localhost");
        assert_eq!(launch(&["--host", "[::ffff:10.1.2.3]"]).unwrap().https.unwrap().name, "10.1.2.3");
        assert_eq!(launch(&["--host", "::1"]).unwrap().https.unwrap().name, "[::1]");
        // Tauri's "all interfaces" listening mode (`cli_manager.rs` `resolve_listening_host`).
        let all_interfaces = launch(&[
            "serve",
            "--host",
            "0.0.0.0",
            "--auth-cookie-name",
            cookie,
            "--generate-token",
            "--unrestricted-root",
            "--https",
            "true",
            "--http",
            "true",
        ])
        .unwrap();
        assert_eq!(all_interfaces.http.ip.to_string(), "127.0.0.1");
        let https_all = all_interfaces.https.unwrap();
        assert_eq!((https_all.bind.ip.to_string(), https_all.name.as_str()), ("0.0.0.0".into(), "localhost"));
        let ipv6_all = launch(&["--host", "::", "--https", "true", "--http", "true"]).unwrap();
        assert_eq!(ipv6_all.http.ip.to_string(), "127.0.0.1");
        assert_eq!(ipv6_all.https.unwrap().bind.ip.to_string(), "::");
    }

    #[test]
    fn refusals_follow_the_reference_wording() {
        for (args, message) in [
            (&["--https", "no", "--http", "off"][..], "At least one listener must be enabled (--https or --http)"),
            (&["--http-port", "70000"], "Port must be an integer between 0 and 65535 (got '70000')"),
            (&["--http-port", "1.5"], "Port must be an integer between 0 and 65535 (got '1.5')"),
            (&["--host"], "option '--host <value>' argument missing"),
            (&["--bogus"], "unknown option '--bogus'"),
            (&["-x"], "unknown option '-x'"),
            (&["--generate-token=1"], "option '--generate-token' does not take an argument"),
            (&["--tls-key", "k.pem"], "--tls-key and --tls-cert must be provided together"),
            (&["--host", "fe80::1%eth0"], "IPv6 zone identifiers are not supported in --host"),
            (&["--upgrade"], "--upgrade is not supported by the Rust server"),
            (&["--upgrade", "1.2.3"], "--upgrade is not supported by the Rust server"),
            (&["--launch"], "--launch is not supported by the Rust server"),
            (
                &["--host", "0.0.0.0", "--https", "false", "--http", "true"],
                "--host 0.0.0.0: the Rust server serves HTTP on 127.0.0.1 only",
            ),
            (
                &["--host", "192.168.1.4", "--https", "false", "--http", "true"],
                "--host 192.168.1.4: the Rust server serves HTTP on 127.0.0.1 only",
            ),
        ] {
            assert_eq!(launch(args).err().as_deref(), Some(message), "{args:?}");
        }
        assert!(matches!(parse(&["serve".into(), "-v".into()]), Ok(Command::Print(v)) if v == crate::config::VERSION));
        assert!(matches!(parse(&["--help".into()]), Ok(Command::Print(h)) if h.contains("--dangerously-skip-auth")));
        assert!(serves(&[]) && serves(&["serve".into()]) && serves(&["--host".into()]) && !serves(&["root".into()]));
        assert_eq!(parse_port(""), Ok(0));
        assert_eq!(resolve_host("  ", "--host"), Ok("127.0.0.1".into()));
    }
}
