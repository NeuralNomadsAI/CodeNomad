use url::Url;

pub fn canonical_endpoint(input: &str) -> Result<Url, &'static str> {
    if input.len() < 9
        || !input
            .get(..8)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        || !input.bytes().all(|c| (0x21..=0x7e).contains(&c))
        || input.contains(['\\', '?', '#', '@', '%'])
    {
        return Err("invalid");
    }
    let remainder = &input[8..];
    if remainder
        .find('/')
        .is_some_and(|slash| &remainder[slash..] != "/")
    {
        return Err("invalid");
    }
    let url = Url::parse(input).map_err(|_| "invalid")?;
    let host = url.host_str().ok_or("invalid")?;
    if url.scheme() != "https"
        || host.ends_with('.')
        || host == "localhost"
        || host.ends_with(".localhost")
        || host == "tauri"
        || host == "[::1]"
        || host == "0.0.0.0"
        || host.starts_with("127.")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid");
    }
    Ok(url)
}

// Native selection is the only way to change remote authority. A redirect can
// never enlarge it, and a recovery navigation clears it before loading local UI.
pub struct NavigationPolicy {
    launcher: Url,
    endpoint: Option<Url>,
    revision: u64,
}

pub struct PendingConnection {
    endpoint: Url,
    revision: u64,
}

pub struct CommittedConnection {
    endpoint: Url,
    revision: u64,
}

impl CommittedConnection {
    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }
}

impl NavigationPolicy {
    pub fn new(launcher: Url) -> Self {
        Self {
            launcher,
            endpoint: None,
            revision: 0,
        }
    }

    pub fn is_launcher(&self, url: &Url) -> bool {
        url == &self.launcher
    }

    pub fn prepare_connection(
        &self,
        label: &str,
        current: &Url,
        input: &str,
    ) -> Result<PendingConnection, &'static str> {
        if label != "main" || !self.is_launcher(current) || self.endpoint.is_some() {
            return Err("unauthorized");
        }
        Ok(PendingConnection {
            endpoint: canonical_endpoint(input)?,
            revision: self.revision,
        })
    }

    pub fn commit_connection(
        &mut self,
        label: &str,
        current: &Url,
        pending: PendingConnection,
    ) -> Result<CommittedConnection, &'static str> {
        if label != "main" || !self.is_launcher(current) || pending.revision != self.revision {
            return Err("unauthorized");
        }
        self.revision = self.revision.wrapping_add(1);
        self.endpoint = Some(pending.endpoint.clone());
        Ok(CommittedConnection {
            endpoint: pending.endpoint,
            revision: self.revision,
        })
    }

    // A late native failure must not revoke a newer connection or recovery.
    pub fn abort_connection(&mut self, committed: &CommittedConnection) {
        if self.revision == committed.revision {
            self.disconnect();
        }
    }

    pub fn disconnect(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.endpoint = None;
    }

    pub fn admit(&mut self, url: &Url) -> bool {
        if self.is_launcher(url) {
            self.disconnect();
            return true;
        }
        self.endpoint.as_ref().is_some_and(|endpoint| {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.origin() == endpoint.origin()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_url_fixtures() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/urls.json")).unwrap();
        for pair in fixtures["valid"].as_array().unwrap() {
            let input = pair[0].as_str().unwrap();
            assert_eq!(
                canonical_endpoint(input).unwrap().as_str(),
                pair[1].as_str().unwrap(),
                "{input}"
            );
        }
        for value in fixtures["invalid"].as_array().unwrap() {
            let input = value.as_str().unwrap();
            assert!(canonical_endpoint(input).is_err(), "{input}");
        }
    }

    #[test]
    fn redirect_fencing_and_native_recovery() {
        for launcher in [
            "https://tauri.localhost/index.html",
            "tauri://localhost/index.html",
        ] {
            let mut policy = NavigationPolicy::new(launcher.parse().unwrap());
            let endpoint = canonical_endpoint("https://example.com").unwrap();
            assert!(!policy.admit(&endpoint));
            let current = launcher.parse().unwrap();
            let pending = policy
                .prepare_connection("main", &current, endpoint.as_str())
                .unwrap();
            policy.commit_connection("main", &current, pending).unwrap();
            assert!(policy.admit(&"https://example.com/login?return=%2F#form".parse().unwrap()));
            for input in [
                "http://example.com/",
                "https://evil.com/",
                "https://example.com.evil/",
                "https://example.com:8443/",
                "https://user@example.com/",
                "file:///index.html",
                "about:blank",
                "javascript:alert(1)",
                "https://tauri.localhost/evil.html",
            ] {
                assert!(!policy.admit(&input.parse().unwrap()), "{input}");
                assert!(!policy.is_launcher(&input.parse().unwrap()));
            }
            assert!(policy.admit(&launcher.parse().unwrap()));
            assert!(!policy.admit(&endpoint));
            assert!(!policy.is_launcher(&endpoint));
            assert!(!policy.is_launcher(&format!("{launcher}?spoof=1").parse().unwrap()));
        }
    }

    #[test]
    fn command_authority_and_late_connection_fences() {
        let launcher: Url = "https://tauri.localhost/index.html".parse().unwrap();
        let mut policy = NavigationPolicy::new(launcher.clone());
        for (label, current) in [
            ("other", launcher.as_str()),
            ("main", "https://example.com/"),
            ("main", "https://tauri.localhost/index.html?spoof=1"),
            ("main", "https://tauri.localhost.evil/index.html"),
        ] {
            assert!(policy
                .prepare_connection(label, &current.parse().unwrap(), "https://example.com")
                .is_err());
        }
        let pending = policy
            .prepare_connection("main", &launcher, "https://example.com")
            .unwrap();
        assert!(policy.admit(&launcher)); // Native return while readiness is pending.
        assert!(policy
            .commit_connection("main", &launcher, pending)
            .is_err());
        let first = policy
            .prepare_connection("main", &launcher, "https://example.com")
            .unwrap();
        let duplicate = policy
            .prepare_connection("main", &launcher, "https://evil.com")
            .unwrap();
        let committed = policy.commit_connection("main", &launcher, first).unwrap();
        assert!(policy
            .prepare_connection("main", &launcher, "https://evil.com")
            .is_err());
        assert!(policy
            .commit_connection("main", &launcher, duplicate)
            .is_err());
        assert!(policy.admit(committed.endpoint()));
        assert!(!policy.admit(&"https://evil.com".parse().unwrap()));
    }

    #[test]
    fn native_failure_rolls_back_only_its_own_committed_generation() {
        let launcher: Url = "https://tauri.localhost/index.html".parse().unwrap();
        let mut policy = NavigationPolicy::new(launcher.clone());
        let pending = policy
            .prepare_connection("main", &launcher, "https://one.example")
            .unwrap();
        let first = policy
            .commit_connection("main", &launcher, pending)
            .unwrap();
        policy.abort_connection(&first);
        assert!(!policy.admit(first.endpoint()));
        let pending = policy
            .prepare_connection("main", &launcher, "https://two.example")
            .unwrap();
        let second = policy
            .commit_connection("main", &launcher, pending)
            .unwrap();
        policy.abort_connection(&first); // Late failure of an already revoked transaction.
        assert!(policy.admit(second.endpoint()));
        assert!(policy.admit(&launcher));
        policy.abort_connection(&second);
        let pending = policy
            .prepare_connection("main", &launcher, "https://three.example")
            .unwrap();
        let third = policy
            .commit_connection("main", &launcher, pending)
            .unwrap();
        assert!(policy.admit(third.endpoint()));
    }
}
