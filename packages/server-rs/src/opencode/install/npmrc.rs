//! npm's configuration as `npm install --global --prefix <prefix> @opencode/cli` reads it: the
//! global then user npmrc then `npm_config_*` variables (later wins), the `@opencode` scope registry
//! (the default registry stays the public one, as the reference passes `--registry`), credentials
//! per registry path, proxies and extra certificate authorities. Credentials are never logged.
use std::{collections::HashMap, env, path::Path};

use reqwest::{Client, RequestBuilder, Url};

pub const PUBLIC_REGISTRY: &str = "https://registry.npmjs.org/";

#[derive(Default, Debug)]
pub struct Config {
    values: HashMap<String, String>,
}

/// `npm_config_*` names: the rest lowercased, inner underscores as dashes (`@npmcli/config`).
fn env_key(name: &str) -> Option<String> {
    let rest = name.get(..11).filter(|p| p.eq_ignore_ascii_case("npm_config_")).map(|_| &name[11..])?;
    let mut key: String = rest.to_ascii_lowercase();
    if key.len() > 1 {
        key = format!("{}{}", &key[..1], key[1..].replace('_', "-"));
    }
    (!key.is_empty()).then_some(key)
}

/// `${NAME}` expands from the environment; `\${` stays literal (npm's `envReplace`).
fn expand(value: &str) -> String {
    static VAR: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(\\*)\$\{([^${}]+)\}").unwrap());
    VAR.replace_all(value, |c: &regex::Captures| {
        let escapes = c[1].len();
        if escapes % 2 == 1 {
            return format!("{}${{{}}}", "\\".repeat(escapes - 1), &c[2]);
        }
        format!("{}{}", "\\".repeat(escapes), env::var(&c[2]).unwrap_or_default())
    })
    .into_owned()
}

/// The `ini` decoding npm uses: `key = value` lines, `;`/`#` comments, quoted values, sections ignored.
pub fn parse(text: &str, into: &mut HashMap<String, String>) {
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with([';', '#']) || line.starts_with('[') {
            continue;
        }
        let (key, value) = line.split_once('=').unwrap_or((line, "true"));
        let (key, value) = (key.trim(), value.trim());
        let value = match value.as_bytes() {
            [b'"', .., b'"'] | [b'\'', .., b'\''] if value.len() >= 2 => value[1..value.len() - 1].to_owned(),
            _ => {
                let mut cut = value.len();
                let mut escaped = false;
                for (i, c) in value.char_indices() {
                    match c {
                        '\\' if !escaped => escaped = true,
                        ';' | '#' if !escaped => {
                            cut = i;
                            break;
                        }
                        _ => escaped = false,
                    }
                }
                value[..cut].trim().to_owned()
            }
        };
        if !key.is_empty() {
            into.insert(expand(key), expand(&value));
        }
    }
}

fn read(file: &Path, into: &mut HashMap<String, String>) {
    if let Ok(text) = std::fs::read_to_string(file) {
        parse(&text, into);
    }
}

impl Config {
    /// The configuration of an installation into `prefix` (its `etc/npmrc` is npm's global file).
    pub fn load(prefix: &Path) -> Self {
        let lookup = |key: &str| env::vars().find(|(k, _)| env_key(k).as_deref() == Some(key)).map(|(_, v)| v);
        let mut values = HashMap::new();
        let global = lookup("globalconfig").map_or_else(|| prefix.join("etc").join("npmrc"), Into::into);
        read(&global, &mut values);
        let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
        let user = lookup("userconfig").map(Into::into).or_else(|| home.map(|h| Path::new(&h).join(".npmrc")));
        if let Some(user) = user {
            read(&user, &mut values);
        }
        for (name, value) in env::vars() {
            if let Some(key) = env_key(&name).filter(|k| !matches!(k.as_str(), "registry" | "prefix")) {
                values.insert(key, value);
            }
        }
        Self { values }
    }
    #[cfg(test)]
    pub fn from(values: HashMap<String, String>) -> Self {
        Self { values }
    }
    fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str).filter(|v| !v.is_empty())
    }

    /// The `@opencode` scope registry, else the public registry, with a trailing slash.
    pub fn registry(&self) -> Result<Url, String> {
        let value = self.get("@opencode:registry").unwrap_or(PUBLIC_REGISTRY);
        let value = if value.ends_with('/') { value.to_owned() } else { format!("{value}/") };
        let url = Url::parse(&value).map_err(|_| "Invalid @opencode registry in the npm configuration".to_owned())?;
        if !matches!(url.scheme(), "http" | "https") || url.query().is_some() || url.fragment().is_some() {
            return Err("Invalid @opencode registry in the npm configuration".into());
        }
        Ok(url)
    }

    /// `Authorization` for `url` (npm-registry-fetch `getAuth`): the longest configured
    /// `//host[:port]/path/` prefix, never another host.
    pub fn authorization(&self, url: &Url) -> Option<String> {
        let host = url.host_str()?;
        let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
        let mut path = url.path().rsplit_once('/').map_or("/", |(dir, _)| dir).to_owned();
        loop {
            let key = format!("//{host}{port}{}/", path.trim_end_matches('/'));
            if let Some(token) = self.get(&format!("{key}:_authToken")) {
                return Some(format!("Bearer {token}"));
            }
            if let Some(auth) = self.get(&format!("{key}:_auth")) {
                return Some(format!("Basic {auth}"));
            }
            if let (Some(user), Some(password)) =
                (self.get(&format!("{key}:username")), self.get(&format!("{key}:_password")))
            {
                use base64::Engine;
                let decoded = base64::engine::general_purpose::STANDARD.decode(password).ok()?;
                let pair = format!("{user}:{}", String::from_utf8(decoded).ok()?);
                return Some(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair)));
            }
            match path.trim_end_matches('/').rsplit_once('/') {
                Some((parent, _)) => path = parent.to_owned(),
                None => return None,
            }
        }
    }

    pub fn request(&self, client: &Client, url: Url) -> RequestBuilder {
        let auth = self.authorization(&url);
        let request = client.get(url);
        match auth {
            Some(value) => request.header(reqwest::header::AUTHORIZATION, value),
            None => request,
        }
    }

    /// npm's agent: `https-proxy` (else `HTTPS_PROXY`, then `proxy`/`HTTP_PROXY`) for HTTPS,
    /// `proxy` (else `HTTP_PROXY`) for HTTP, `noproxy` (else `NO_PROXY`); `cafile`, `ca` and
    /// `NODE_EXTRA_CA_CERTS` beside the bundled roots.
    pub fn client(&self) -> Result<Client, String> {
        let var = |names: &[&str]| names.iter().find_map(|n| env::var(n).ok().filter(|v| !v.is_empty()));
        let http = self.get("proxy").map(str::to_owned).or_else(|| var(&["HTTP_PROXY", "http_proxy"]));
        let https = self
            .get("https-proxy")
            .map(str::to_owned)
            .or_else(|| var(&["HTTPS_PROXY", "https_proxy"]))
            .or(http.clone());
        let bypass = self.get("noproxy").map(str::to_owned).or_else(|| var(&["NO_PROXY", "no_proxy"]));
        let no_proxy = || reqwest::NoProxy::from_string(bypass.as_deref().unwrap_or(""));
        let invalid = |_| "Invalid proxy in the npm configuration".to_owned();
        let mut builder = Client::builder()
            .no_proxy()
            .connect_timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(10));
        if let Some(proxy) = &https {
            builder = builder.proxy(reqwest::Proxy::https(proxy).map_err(invalid)?.no_proxy(no_proxy()));
        }
        if let Some(proxy) = &http {
            builder = builder.proxy(reqwest::Proxy::http(proxy).map_err(invalid)?.no_proxy(no_proxy()));
        }
        let mut pem = Vec::new();
        for file in [self.get("cafile").map(str::to_owned), env::var("NODE_EXTRA_CA_CERTS").ok()].into_iter().flatten()
        {
            pem.extend(std::fs::read(&file).map_err(|_| format!("Cannot read the certificate file {file}"))?);
            pem.push(b'\n');
        }
        if let Some(ca) = self.get("ca") {
            pem.extend(ca.replace("\\n", "\n").into_bytes());
        }
        if !pem.is_empty() {
            let certificates = reqwest::Certificate::from_pem_bundle(&pem)
                .map_err(|_| "Invalid certificate authority in the npm configuration".to_owned())?;
            for certificate in certificates {
                builder = builder.add_root_certificate(certificate);
            }
        }
        // npm's `strict-ssl=false` accepts any certificate, as the reference's npm does.
        if self.get("strict-ssl") == Some("false") {
            builder = builder.danger_accept_invalid_certs(true);
        }
        builder.build().map_err(|_| "Cannot create the registry client".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(text: &str) -> Config {
        let mut values = HashMap::new();
        parse(text, &mut values);
        Config::from(values)
    }

    #[test]
    fn the_scope_registry_alone_redirects_opencode() {
        assert_eq!(config("registry=https://mirror.invalid/").registry().unwrap().as_str(), PUBLIC_REGISTRY);
        let scoped = config("; comment\n@opencode:registry = \"http://127.0.0.1:9/npm\" \n");
        assert_eq!(scoped.registry().unwrap().as_str(), "http://127.0.0.1:9/npm/");
        assert!(config("@opencode:registry=ftp://x/").registry().is_err());
    }

    #[test]
    fn credentials_follow_the_longest_registry_path_on_the_same_host() {
        let c = config(
            "//r.invalid/:_authToken=host\n//r.invalid/npm/:_authToken=${CNRS_NPMRC_TEST_UNSET}x # trailing\n\
             //b.invalid:8080/:username=u\n//b.invalid:8080/:_password=cA==\n//c.invalid/:_auth=YTpi\n",
        );
        let url = |u: &str| Url::parse(u).unwrap();
        assert_eq!(c.authorization(&url("https://r.invalid/npm/@opencode%2fcli")).unwrap(), "Bearer x");
        assert_eq!(c.authorization(&url("https://r.invalid/npm/@opencode/cli/-/cli-1.tgz")).unwrap(), "Bearer x");
        assert_eq!(c.authorization(&url("https://r.invalid/other/x")).unwrap(), "Bearer host");
        assert_eq!(c.authorization(&url("http://b.invalid:8080/x")).unwrap(), "Basic dTpw");
        assert_eq!(c.authorization(&url("https://c.invalid/x")).unwrap(), "Basic YTpi");
        assert_eq!(c.authorization(&url("https://evil.invalid/npm/x")), None);
        assert_eq!(c.authorization(&url("https://b.invalid/x")), None, "another port is another registry");
    }

    #[test]
    fn environment_names_map_like_npm() {
        assert_eq!(env_key("npm_config_https_proxy").as_deref(), Some("https-proxy"));
        assert_eq!(env_key("NPM_CONFIG_USERCONFIG").as_deref(), Some("userconfig"));
        assert_eq!(env_key("npm_config_@opencode:registry").as_deref(), Some("@opencode:registry"));
        assert_eq!(env_key("npm_configx"), None);
        assert_eq!(expand(r"a\${HOME}b"), "a${HOME}b");
    }
}
