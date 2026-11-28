//! Interchangeable native HTTP and browser fetch adapters; cookies stay in their owner.
use crate::history::Result;
use reqwest::{Client, RequestBuilder};
use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(not(target_arch = "wasm32"))]
pub const PROMPT_CONNECT_TIMEOUT: Duration = REQUEST_TIMEOUT;
#[cfg(not(target_arch = "wasm32"))]
pub const PROMPT_IDLE_TIMEOUT: Duration = Duration::from_secs(330);
const MAX_TRACKED_DROPS: usize = 64;

#[cfg(not(target_arch = "wasm32"))]
struct PromptTransport {
    client: Client,
    idle_timeout: Duration,
}

type DropTable = Arc<Mutex<Vec<(String, u64, usize, bool, bool)>>>;
struct CapabilityState {
    drop_generation: Arc<AtomicU64>,
    observed: Mutex<(u64, u64, bool, bool)>,
    required: AtomicBool,
    identity_mismatch: AtomicBool,
    open_streams: Arc<AtomicUsize>,
    probe_seq: AtomicU64,
    stream_drop_epoch: AtomicU64,
    attested_drop_epoch: AtomicU64,
    #[cfg(not(target_arch = "wasm32"))]
    prompt: PromptTransport,
}

struct GuardState {
    opened: bool,
    closed: bool,
    recorded: bool,
    counted: bool,
}

pub(crate) struct StreamDropGuard {
    drops: DropTable,
    client_id: String,
    open_streams: Arc<AtomicUsize>,
    drop_generation: Arc<AtomicU64>,
    state: Mutex<GuardState>,
}

impl StreamDropGuard {
    pub(crate) fn try_mark_open(&self, client: &Http, count_open_stream: bool) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.closed || state.opened {
            return false;
        }
        state.opened = true;
        state.counted = count_open_stream;
        if count_open_stream {
            self.open_streams.fetch_add(1, Ordering::SeqCst);
        }
        client.mark_stream_opened(&self.client_id);
        true
    }

    pub(crate) fn close_and_revoke(
        &self,
        client: &Http,
        _count_open_stream: bool,
        record_drop: bool,
    ) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        let was_open = std::mem::replace(&mut state.opened, false);
        if std::mem::replace(&mut state.counted, false)
            && self.open_streams.fetch_sub(1, Ordering::SeqCst) == 1
        {
            self.drop_generation.fetch_add(1, Ordering::SeqCst);
        }
        if record_drop && !state.recorded {
            state.recorded = true;
            client.record_transport_drop(&self.client_id, was_open);
        }
    }
}

impl Drop for StreamDropGuard {
    fn drop(&mut self) {
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.opened = false;
            if std::mem::replace(&mut state.counted, false)
                && self.open_streams.fetch_sub(1, Ordering::SeqCst) == 1
            {
                self.drop_generation.fetch_add(1, Ordering::SeqCst);
            }
        }
        let mut drops = self.drops.lock().unwrap();
        if let Some((_, _, active, _, _)) = drops
            .iter_mut()
            .find(|(id, _, _, _, _)| id == &self.client_id)
        {
            *active = active.saturating_sub(1);
        }
    }
}

pub struct ClientDropWatch {
    drops: DropTable,
    client_ids: Vec<String>,
}

impl Drop for ClientDropWatch {
    fn drop(&mut self) {
        let mut drops = self.drops.lock().unwrap();
        for client_id in &self.client_ids {
            if let Some((_, _, active, _, _)) =
                drops.iter_mut().find(|(id, _, _, _, _)| id == client_id)
            {
                *active = active.saturating_sub(1);
            }
        }
    }
}

#[derive(Clone)]
pub struct Http(
    Client,
    Arc<OnceLock<Identity>>,
    Arc<crate::stream::Children>,
    Arc<AtomicBool>,
    Arc<[AtomicU64; 3]>,
    DropTable,
    Arc<CapabilityState>,
    Arc<crate::stream::Hub>,
);
struct Identity {
    server: String,
    capabilities: Vec<String>,
}
#[cfg(not(target_arch = "wasm32"))]
struct OriginCookieJar {
    origin: (String, Option<String>, Option<u16>),
    inner: reqwest::cookie::Jar,
}

#[cfg(not(target_arch = "wasm32"))]
impl OriginCookieJar {
    fn new(url: &reqwest::Url) -> Self {
        Self {
            origin: (
                url.scheme().to_owned(),
                url.host_str().map(str::to_owned),
                url.port_or_known_default(),
            ),
            inner: reqwest::cookie::Jar::default(),
        }
    }

    fn matches(&self, url: &reqwest::Url) -> bool {
        url.scheme() == self.origin.0
            && url.host_str() == self.origin.1.as_deref()
            && url.port_or_known_default() == self.origin.2
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl reqwest::cookie::CookieStore for OriginCookieJar {
    fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &reqwest::header::HeaderValue>,
        url: &reqwest::Url,
    ) {
        if self.matches(url) {
            self.inner.set_cookies(cookie_headers, url);
        }
    }

    fn cookies(&self, url: &reqwest::Url) -> Option<reqwest::header::HeaderValue> {
        self.matches(url).then(|| self.inner.cookies(url)).flatten()
    }
}

impl Http {
    #[cfg(not(target_arch = "wasm32"))]
    fn build_prompt_transport<C: reqwest::cookie::CookieStore + 'static>(
        cookies: Arc<C>,
        connect_timeout: Duration,
        idle_timeout: Duration,
    ) -> Result<PromptTransport> {
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .cookie_provider(cookies)
            .connect_timeout(connect_timeout)
            .build()?;
        Ok(PromptTransport {
            client,
            idle_timeout,
        })
    }
    fn from_parts(
        client: Client,
        #[cfg(not(target_arch = "wasm32"))] prompt: PromptTransport,
    ) -> Self {
        Self(
            client,
            Arc::new(OnceLock::new()),
            Arc::default(),
            Arc::new(AtomicBool::new(true)),
            Arc::new(std::array::from_fn(|_| AtomicU64::new(0))),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(CapabilityState {
                drop_generation: Arc::new(AtomicU64::new(0)),
                observed: Mutex::new((0, 0, false, false)),
                required: AtomicBool::new(false),
                identity_mismatch: AtomicBool::new(false),
                open_streams: Arc::new(AtomicUsize::new(0)),
                probe_seq: AtomicU64::new(0),
                stream_drop_epoch: AtomicU64::new(0),
                attested_drop_epoch: AtomicU64::new(0),
                #[cfg(not(target_arch = "wasm32"))]
                prompt,
            }),
            Arc::default(),
        )
    }
    pub fn new() -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let jar = Arc::new(reqwest::cookie::Jar::default());
            let client = Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .cookie_provider(jar.clone())
                .build()?;
            let prompt =
                Self::build_prompt_transport(jar, PROMPT_CONNECT_TIMEOUT, PROMPT_IDLE_TIMEOUT)?;
            Ok(Self::from_parts(client, prompt))
        }
        #[cfg(target_arch = "wasm32")]
        Ok(Self::from_parts(Client::new()))
    }
    #[cfg(all(test, not(target_arch = "wasm32")))]
    pub(crate) fn with_prompt_timeouts(
        connect_timeout: Duration,
        idle_timeout: Duration,
    ) -> Result<Self> {
        let jar = Arc::new(reqwest::cookie::Jar::default());
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .cookie_provider(jar.clone())
            .build()?;
        let prompt = Self::build_prompt_transport(jar, connect_timeout, idle_timeout)?;
        Ok(Self::from_parts(client, prompt))
    }
    /// Pre-seed a loopback session cookie issued over the owned child host's stdio channel.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn with_session_cookie(address: &str, name: &str, value: &str) -> Result<Self> {
        let valid_token = |token: &str| {
            !token.is_empty()
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        };
        if !valid_token(name) || !valid_token(value) {
            return Err("invalid session cookie".into());
        }
        let base = endpoint(address)?;
        let url = reqwest::Url::parse(&base)?;
        let jar = Arc::new(OriginCookieJar::new(&url));
        jar.inner
            .add_cookie_str(&format!("{name}={value}; Path=/"), &url);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .cookie_provider(jar.clone())
            .build()?;
        let prompt =
            Self::build_prompt_transport(jar, PROMPT_CONNECT_TIMEOUT, PROMPT_IDLE_TIMEOUT)?;
        Ok(Self::from_parts(client, prompt))
    }
    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.1, &other.1)
    }
    pub(crate) fn sse_hub(&self) -> &Arc<crate::stream::Hub> {
        &self.7
    }
    pub fn location_revision(&self, workspace: &str, session: Option<&str>) -> u64 {
        self.7.location_revision(workspace, session)
    }
    pub fn workspace_upstream_healthy(&self, workspace: &str) -> bool {
        self.7.workspace_upstream_healthy(workspace)
    }
    pub fn location_state(&self, workspace: &str, session: Option<&str>) -> (u64, bool) {
        self.7.location_state(workspace, session)
    }
    pub(crate) fn preferences_notices(&self) -> Arc<[AtomicU64; 3]> {
        self.4.clone()
    }
    pub fn preferences_revision(&self, owner: crate::settings::Owner) -> u64 {
        self.4[owner.index()].load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub(crate) fn open_streams_counter(&self) -> Arc<AtomicUsize> {
        self.6.open_streams.clone()
    }
    fn evict_inactive(drops: &mut Vec<(String, u64, usize, bool, bool)>) {
        while drops.len() >= MAX_TRACKED_DROPS {
            if let Some(index) = drops
                .iter()
                .position(|(_, count, active, _, _)| *active == 0 && *count == 0)
                .or_else(|| drops.iter().position(|(_, _, active, _, _)| *active == 0))
            {
                drops.remove(index);
            } else {
                break;
            }
        }
    }
    pub(crate) fn track_stream(&self, client_id: &str) -> StreamDropGuard {
        let mut drops = self.5.lock().unwrap();
        if let Some((_, _, active, _, _)) =
            drops.iter_mut().find(|(id, _, _, _, _)| id == client_id)
        {
            *active += 1;
        } else {
            Self::evict_inactive(&mut drops);
            drops.push((client_id.to_owned(), 0, 1, false, false));
        }
        StreamDropGuard {
            drops: self.5.clone(),
            client_id: client_id.to_owned(),
            open_streams: self.6.open_streams.clone(),
            drop_generation: self.6.drop_generation.clone(),
            state: Mutex::new(GuardState {
                opened: false,
                closed: false,
                recorded: false,
                counted: false,
            }),
        }
    }
    pub fn watch_drops(&self, client_ids: &[String]) -> ClientDropWatch {
        let mut pinned = Vec::new();
        let mut drops = self.5.lock().unwrap();
        for client_id in client_ids {
            if pinned.iter().any(|existing| existing == client_id) {
                continue;
            }
            if let Some((_, _, active, _, _)) =
                drops.iter_mut().find(|(id, _, _, _, _)| id == client_id)
            {
                *active += 1;
            } else {
                Self::evict_inactive(&mut drops);
                drops.push((client_id.clone(), 0, 1, false, false));
            }
            pinned.push(client_id.clone());
        }
        ClientDropWatch {
            drops: self.5.clone(),
            client_ids: pinned,
        }
    }
    pub(crate) fn mark_stream_opened(&self, client_id: &str) {
        let mut drops = self.5.lock().unwrap();
        if let Some((_, _, _, in_outage, reconnect_noted)) =
            drops.iter_mut().find(|(id, _, _, _, _)| id == client_id)
        {
            *in_outage = false;
            *reconnect_noted = false;
        }
    }
    pub(crate) fn record_transport_drop(&self, client_id: &str, was_open: bool) {
        let mut drops = self.5.lock().unwrap();
        if let Some((_, count, _, in_outage, reconnect_noted)) =
            drops.iter_mut().find(|(id, _, _, _, _)| id == client_id)
        {
            if was_open || !*in_outage {
                self.6.stream_drop_epoch.fetch_add(1, Ordering::SeqCst);
                *count += 1;
                *in_outage = true;
                *reconnect_noted = false;
            }
        } else {
            self.6.stream_drop_epoch.fetch_add(1, Ordering::SeqCst);
            Self::evict_inactive(&mut drops);
            drops.push((client_id.to_owned(), 1, 0, true, false));
        }
    }
    pub(crate) fn note_reconnect_attempt(&self, client_id: &str) {
        let mut drops = self.5.lock().unwrap();
        if let Some((_, _, _, _, reconnect_noted)) =
            drops.iter_mut().find(|(id, _, _, _, _)| id == client_id)
        {
            if !*reconnect_noted {
                *reconnect_noted = true;
                self.6.stream_drop_epoch.fetch_add(1, Ordering::SeqCst);
            }
        } else {
            Self::evict_inactive(&mut drops);
            drops.push((client_id.to_owned(), 0, 0, false, true));
            self.6.stream_drop_epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
    pub(crate) fn observed_capability_stamp(&self) -> (u64, u64) {
        let state = self.6.observed.lock().unwrap();
        (state.0, state.1)
    }
    pub fn stream_drop_epoch(&self) -> u64 {
        self.6.stream_drop_epoch.load(Ordering::SeqCst)
    }
    pub fn has_unattested_stream_drop(&self) -> bool {
        self.6.attested_drop_epoch.load(Ordering::SeqCst)
            < self.6.stream_drop_epoch.load(Ordering::SeqCst)
    }
    pub(crate) fn mark_drop_epoch_attested(&self, drop_epoch: u64) {
        self.6
            .attested_drop_epoch
            .fetch_max(drop_epoch, Ordering::SeqCst);
    }
    pub fn transport_drops(&self, client_id: &str) -> u64 {
        self.5
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _, _, _, _)| id == client_id)
            .map_or(0, |(_, count, _, _, _)| *count)
    }
    pub fn is_in_outage(&self, client_id: &str) -> bool {
        self.5
            .lock()
            .unwrap()
            .iter()
            .find(|(id, _, _, _, _)| id == client_id)
            .is_some_and(|(_, _, _, in_outage, _)| *in_outage)
    }
    pub fn transport_drops_sum(&self, client_ids: &[String]) -> u64 {
        let drops = self.5.lock().unwrap();
        client_ids
            .iter()
            .map(|client_id| {
                drops
                    .iter()
                    .find(|(id, _, _, _, _)| id == client_id)
                    .map_or(0, |(_, count, _, _, _)| *count)
            })
            .sum()
    }
    pub(crate) fn children(&self) -> &crate::stream::Children {
        &self.2
    }
    pub fn server_identity(&self) -> Option<&str> {
        self.1.get().map(|identity| identity.server.as_str())
    }
    pub fn supports(&self, capability: &str) -> bool {
        self.1
            .get()
            .is_some_and(|identity| identity.capabilities.iter().any(|item| item == capability))
    }
    pub fn require_attestation(&self) {
        self.6.required.store(true, Ordering::SeqCst);
    }
    pub(crate) fn revoke_server_attestation_at(&self, generation: u64, seq: u64) -> bool {
        let state = self.6.observed.lock().unwrap();
        seq >= state.1
            && self
                .6
                .drop_generation
                .compare_exchange(
                    generation,
                    generation + 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
    }
    #[cfg(test)]
    pub(crate) fn attest(&self, id: &str, capabilities: Vec<String>) -> bool {
        let matched = self
            .1
            .get_or_init(|| Identity {
                server: id.to_owned(),
                capabilities,
            })
            .server
            == id;
        if !matched {
            self.6.identity_mismatch.store(true, Ordering::SeqCst);
            self.6.drop_generation.fetch_add(1, Ordering::SeqCst);
        }
        matched
    }
    pub(crate) fn record_server_identity_mismatch(&self, generation: u64, seq: u64) -> bool {
        let state = self.6.observed.lock().unwrap();
        if seq >= state.1
            && self
                .6
                .drop_generation
                .compare_exchange(
                    generation,
                    generation + 1,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
        {
            self.6.identity_mismatch.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }
    pub(crate) fn verify_server_identity_at(
        &self,
        id: &str,
        capabilities: Vec<String>,
        generation: u64,
        seq: u64,
    ) -> bool {
        let matched = self
            .1
            .get_or_init(|| Identity {
                server: id.to_owned(),
                capabilities,
            })
            .server
            == id;
        if !matched {
            self.record_server_identity_mismatch(generation, seq);
        }
        matched
    }
    pub fn server_identity_mismatch(&self) -> bool {
        self.6.identity_mismatch.load(Ordering::SeqCst)
    }
    pub fn supports_service_usage(&self) -> bool {
        self.3.load(Ordering::Relaxed)
    }
    pub fn drop_generation(&self) -> u64 {
        self.6.drop_generation.load(Ordering::SeqCst)
    }
    pub(crate) fn begin_meta_probe(&self) -> (u64, u64, u64) {
        let generation = self.6.drop_generation.load(Ordering::SeqCst);
        let seq = self.6.probe_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let drop_epoch = self.6.stream_drop_epoch.load(Ordering::SeqCst);
        (generation, seq, drop_epoch)
    }
    pub fn supports_atomic_settings_patches(&self) -> bool {
        let current = self.6.drop_generation.load(Ordering::SeqCst);
        let state = self.6.observed.lock().unwrap();
        state.2 && state.0 == current
    }
    pub fn needs_capability_recheck(&self) -> bool {
        let current = self.6.drop_generation.load(Ordering::SeqCst);
        let state = self.6.observed.lock().unwrap();
        let required = self.6.required.load(Ordering::SeqCst);
        (required && self.server_identity().is_none())
            || ((required || state.3 || self.server_identity().is_some()) && state.0 < current)
    }
    pub fn attestation_revoked(&self) -> bool {
        let current = self.6.drop_generation.load(Ordering::SeqCst);
        let state = self.6.observed.lock().unwrap();
        let required = self.6.required.load(Ordering::SeqCst);
        (required || state.3 || self.server_identity().is_some()) && state.0 < current
    }
    pub fn tracks_server_attestation(&self) -> bool {
        self.6.required.load(Ordering::SeqCst)
            || self.server_identity().is_some()
            || self.6.observed.lock().unwrap().3
    }
    pub(crate) fn observe_capabilities_at(
        &self,
        generation: u64,
        seq: u64,
        service_usage: bool,
        atomic_settings: bool,
    ) -> bool {
        let mut state = self.6.observed.lock().unwrap();
        if generation == self.6.drop_generation.load(Ordering::SeqCst) && seq >= state.1 {
            self.3.store(service_usage, Ordering::Relaxed);
            *state = (generation, seq, atomic_settings, true);
            true
        } else {
            false
        }
    }
    pub fn observe_atomic_settings_patches(&self, advertised: bool) {
        let mut state = self.6.observed.lock().unwrap();
        let current = self.6.drop_generation.load(Ordering::SeqCst);
        let seq = self.6.probe_seq.fetch_add(1, Ordering::SeqCst) + 1;
        *state = (current, seq, advertised, true);
    }
    fn request(&self, method: reqwest::Method, url: impl reqwest::IntoUrl) -> RequestBuilder {
        let request = self.0.request(method, url).timeout(REQUEST_TIMEOUT);
        #[cfg(target_arch = "wasm32")]
        let request = request.fetch_credentials_same_origin();
        request
    }
    pub fn get(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::GET, url)
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn stream_get(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.0.get(url)
    }
    pub fn post(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::POST, url)
    }
    pub(crate) fn post_prompt(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.6.prompt.client.post(url)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.0.post(url).fetch_credentials_same_origin()
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn prompt_idle_timeout(&self) -> Duration {
        self.6.prompt.idle_timeout
    }
    pub fn put(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::PUT, url)
    }
    pub fn patch(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::PATCH, url)
    }
    pub fn delete(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.request(reqwest::Method::DELETE, url)
    }
}

#[cfg(target_arch = "wasm32")]
pub async fn pairing_required() -> Result<Option<bool>> {
    let base = endpoint("/")?;
    let response = Http::new()?
        .get(format!("{base}api/auth/status"))
        .fetch_cache_no_store()
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?;
    let status = crate::backend::read_json_limited(response, 4096).await?;
    Ok(match status["authenticated"].as_bool() {
        Some(true) => Some(false),
        Some(false) if status["pairingRequired"].as_bool() == Some(true) => Some(true),
        _ => None,
    })
}

pub fn is_unauthorized(error: &crate::history::Error) -> bool {
    error.downcast_ref::<crate::files::FileError>() == Some(&crate::files::FileError::Unauthorized)
        || error
            .downcast_ref::<reqwest::Error>()
            .and_then(reqwest::Error::status)
            == Some(reqwest::StatusCode::UNAUTHORIZED)
}

pub fn authentication_expired(error: &crate::history::Error) -> bool {
    cfg!(not(target_arch = "wasm32"))
        && (error.is::<crate::stream::hub::AuthenticationExpired>()
            || error.downcast_ref::<crate::files::FileError>()
                == Some(&crate::files::FileError::Unauthorized)
            || error
                .downcast_ref::<reqwest::Error>()
                .and_then(reqwest::Error::status)
                == Some(reqwest::StatusCode::UNAUTHORIZED))
}

pub fn endpoint(address: &str) -> Result<String> {
    #[cfg(target_arch = "wasm32")]
    let origin = web_sys::window()
        .ok_or("browser window required")?
        .location()
        .origin()
        .map_err(|_| "browser origin unavailable")?;
    #[cfg(target_arch = "wasm32")]
    let url = reqwest::Url::parse(&origin)?.join(address.trim())?;
    #[cfg(not(target_arch = "wasm32"))]
    let url = reqwest::Url::parse(address.trim())?;
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("server root endpoint required".into());
    }
    #[cfg(not(target_arch = "wasm32"))]
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("explicit loopback endpoint required".into());
    }
    #[cfg(target_arch = "wasm32")]
    if url.origin().ascii_serialization() != origin
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err("same-origin HTTPS endpoint required".into());
    }
    Ok(url.to_string())
}

pub fn client_id() -> Result<String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        Ok(format!(
            "rune-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos(),
            SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }
    #[cfg(target_arch = "wasm32")]
    {
        let mut bytes = [0u8; 16];
        web_sys::window()
            .ok_or("browser window required")?
            .crypto()
            .map_err(|_| "browser crypto unavailable")?
            .get_random_values_with_u8_array(&mut bytes)
            .map_err(|_| "browser entropy unavailable")?;
        Ok(format!(
            "rune-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ))
    }
}

/// Cryptographic lowercase RFC 4122 v4 UUID for native control correlation and recovered drafts.
pub fn random_uuid_v4() -> Result<String> {
    let mut bytes = [0u8; 16];
    #[cfg(not(target_arch = "wasm32"))]
    {
        getrandom::fill(&mut bytes).map_err(|_| "random source unavailable")?;
    }
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .ok_or("browser window required")?
            .crypto()
            .map_err(|_| "browser crypto unavailable")?
            .get_random_values_with_u8_array(&mut bytes)
            .map_err(|_| "browser entropy unavailable")?;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    ))
}
/// Parse a `file:` URL with the WHATWG URL parser, returning any non-localhost host and raw path.
pub fn file_url_parts(raw: &str) -> Option<(Option<String>, String)> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost"))
        .map(str::to_owned);
    Some((host, url.path().to_owned()))
}

/// Parse an external link without accepting credentials or active schemes.
pub fn external_http_url(raw: &str) -> Option<(String, String)> {
    let url = credential_free_http_url(raw)?;
    let mut host = url.host_str()?.to_owned();
    if let Some(port) = url.port() {
        host.push_str(&format!(":{port}"));
    }
    Some((url.into(), host))
}

fn credential_free_http_url(raw: &str) -> Option<reqwest::Url> {
    let trimmed = raw.trim();
    if trimmed.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let (scheme, rest) = trimmed.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    if rest.split(['/', '?', '#']).next()?.contains('@') {
        return None;
    }
    let url = reqwest::Url::parse(trimmed).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url)
}

/// Match Solid's explicit HTTP(S) conversation links, using the parsed host.
pub fn is_loopback_http_url(raw: &str) -> bool {
    credential_free_http_url(raw).is_some_and(|url| {
        url.host_str().is_some_and(|host| {
            matches!(host, "localhost" | "0.0.0.0" | "[::1]")
                || host
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    })
}

#[cfg(test)]
#[test]
fn loopback_requires_an_explicit_http_scheme_and_literal_host() {
    for host in ["localhost", "127.0.0.1", "[::1]", "127.1", "0.0.0.0"] {
        assert!(is_loopback_http_url(&format!(
            "http://{host}:9200/a%2Fb?mode=1#target"
        )));
    }
    assert!(is_loopback_http_url(" http://127.0.0.1:8123/view "));
    for raw in [
        "https://127.0.0.1.example.org/",
        "//localhost:8080/",
        "http:localhost:8123/",
        "mailto:local@example.org",
        "http://alice:demo@localhost:8123/",
        "http://alice@127.0.0.1:8123/",
        "https://:demo@[::1]:8123/",
        "http://@localhost:8123/",
        "http://:@localhost:8123/",
        "http://127.0.0.1:8123/ok\ncmd",
        "http://127.0.0.1:8123/ok\tcmd",
        "http://127.0.0.1:8123\\@evil.example/",
    ] {
        assert!(!is_loopback_http_url(raw), "{raw:?}");
    }
    for rejected in [
        "http:localhost:8123/",
        "http://alice:demo@localhost:8123/",
        "http://@localhost:8123/",
        "http://127.0.0.1:8123/ok\ncmd",
        "http://127.0.0.1:8123\\@evil.example/",
    ] {
        assert!(external_http_url(rejected).is_none(), "{rejected:?}");
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[test]
fn session_cookie_helper_validates_tokens_and_formats_uuid_v4() {
    let id = random_uuid_v4().unwrap();
    assert_eq!(id.len(), 36);
    assert_eq!(&id[14..15], "4");
    assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
    assert!(
        id.bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
    );
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "", "abc").is_err());
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "name;bad", "abc").is_err());
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "codenomad_session", "a;b").is_err());
    assert!(Http::with_session_cookie("http://127.0.0.1:9/", "codenomad_session", "a\nb").is_err());
    assert!(Http::with_session_cookie("http://example.com/", "codenomad_session", "abc").is_err());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let other_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let other_port = other_listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            req
        });
        let other_server = std::thread::spawn(move || {
            let (mut stream, _) = other_listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = stream.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nSet-Cookie: foreign=1; Path=/\r\nContent-Length: 2\r\n\r\nok",
            );
            req
        });
        let http = Http::with_session_cookie(
            &format!("http://127.0.0.1:{port}"),
            "codenomad_session_42",
            "renewed_cookie_value_1234567890123456789012",
        )
        .unwrap();
        let res = http
            .get(format!("http://127.0.0.1:{port}/api/meta"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        let raw = server.join().unwrap();
        assert!(
            raw.to_ascii_lowercase().contains(
                "cookie: codenomad_session_42=renewed_cookie_value_1234567890123456789012"
            ),
            "missing session cookie in request: {raw}"
        );
        let other_res = http
            .get(format!("http://127.0.0.1:{other_port}/api/meta"))
            .send()
            .await
            .unwrap();
        assert_eq!(other_res.status(), 200);
        let other_raw = other_server.join().unwrap();
        assert!(
            !other_raw.to_ascii_lowercase().contains("cookie:"),
            "cookie leaked to another loopback port: {other_raw}"
        );
    });
}

#[cfg(test)]
#[test]
fn watched_streams_cannot_evict_and_stale_capability_generation_is_discarded() {
    let http = Http::new().unwrap();
    let (gen0, seq0, _) = http.begin_meta_probe();
    assert!(http.observe_capabilities_at(gen0, seq0, true, true));
    assert!(http.supports_atomic_settings_patches());
    // Out-of-order probe in the same drop generation cannot re-enable atomic patches after downgrade.
    let (gen_same, seq_old, _) = http.begin_meta_probe();
    let (gen_same2, seq_new, _) = http.begin_meta_probe();
    assert!(http.observe_capabilities_at(gen_same2, seq_new, true, false));
    assert!(!http.supports_atomic_settings_patches());
    assert!(!http.observe_capabilities_at(gen_same, seq_old, true, true));
    assert!(!http.supports_atomic_settings_patches());
    let (gen_re, seq_re, _) = http.begin_meta_probe();
    assert!(http.observe_capabilities_at(gen_re, seq_re, true, true));
    assert!(http.supports_atomic_settings_patches());
    let guard_a = http.track_stream("stream-a");
    let guard_b = http.track_stream("stream-b");
    let watch_a = http.watch_drops(&["stream-a".to_owned()]);
    let watch_healthy = http.watch_drops(&["stream-healthy".to_owned()]);
    // Closing one of two open streams keeps attestation valid; closing the last open stream
    // (even voluntarily during SSE handoff) bumps drop_generation and revokes attestation.
    assert!(guard_a.try_mark_open(&http, true));
    assert!(guard_b.try_mark_open(&http, true));
    guard_b.close_and_revoke(&http, true, false);
    assert!(http.supports_atomic_settings_patches());
    assert!(!http.needs_capability_recheck());
    // Start a probe with an admissible sequence (>= seq_re) right before the last stream drops.
    let (gen_before_drop, seq_before_drop, _) = http.begin_meta_probe();
    guard_a.close_and_revoke(&http, true, false);
    let gen_after_drop = http.drop_generation();
    assert_ne!(gen_after_drop, gen_before_drop);
    assert!(!http.supports_atomic_settings_patches());
    assert!(http.needs_capability_recheck());
    // A probe started before the generation bump must be rejected by both CAS gates solely on
    // generation mismatch without mutating drop_generation or setting server_identity_mismatch.
    assert!(!http.revoke_server_attestation_at(gen_before_drop, seq_before_drop));
    assert!(!http.record_server_identity_mismatch(gen_before_drop, seq_before_drop));
    assert_eq!(http.drop_generation(), gen_after_drop);
    assert!(!http.server_identity_mismatch());
    http.record_transport_drop("stream-a", false);
    assert_eq!(http.transport_drops("stream-a"), 1);
    // Repeated failed SSE reconnect attempts (was_open=false while already in outage) must not
    // keep incrementing transport_drops and starving slow HTTP revalidation reads during flush().
    http.record_transport_drop("stream-a", false);
    http.record_transport_drop("stream-a", false);
    assert_eq!(http.transport_drops("stream-a"), 1);
    http.mark_stream_opened("stream-a");
    http.record_transport_drop("stream-a", true);
    assert_eq!(http.transport_drops("stream-a"), 2);
    // A delayed /api/meta response started at gen0 cannot re-enable atomic mode or set identity mismatch after the drop.
    assert!(!http.observe_capabilities_at(gen0, seq0, true, true));
    assert!(!http.record_server_identity_mismatch(gen0, seq0));
    assert!(!http.server_identity_mismatch());
    assert!(!http.supports_atomic_settings_patches());
    assert!(http.needs_capability_recheck());
    // A stale mismatch from an older probe sequence cannot revoke a newer confirmed attestation.
    let (gen_cur, seq_stale, _) = http.begin_meta_probe();
    let (gen_cur2, seq_fresh, drop_epoch_fresh) = http.begin_meta_probe();
    assert!(http.has_unattested_stream_drop());
    assert!(http.observe_capabilities_at(gen_cur2, seq_fresh, true, true));
    http.mark_drop_epoch_attested(drop_epoch_fresh);
    assert!(!http.has_unattested_stream_drop());
    assert!(!http.revoke_server_attestation_at(gen_cur, seq_stale));
    assert!(!http.record_server_identity_mismatch(gen_cur, seq_stale));
    assert!(!http.server_identity_mismatch());
    assert!(http.supports_atomic_settings_patches());
    assert!(!http.needs_capability_recheck());
    drop((guard_a, guard_b));
    // Filling past MAX_TRACKED_DROPS never evicts watched stream-a.
    let mut guards = Vec::new();
    for i in 0..MAX_TRACKED_DROPS {
        guards.push(http.track_stream(&format!("stream-other-{i}")));
    }
    assert_eq!(http.transport_drops_sum(&["stream-a".to_owned()]), 2);
    // Once stream-a is unwatched and evicted, healthy streams stay at 0 drops with no false positive.
    drop(watch_a);
    let _extra = http.track_stream("stream-extra");
    assert_eq!(http.transport_drops_sum(&["stream-healthy".to_owned()]), 0);
    drop((guards, watch_healthy));
}
