#[cfg(target_os = "linux")]
use crate::device_speech_ipc::remote_microphone;
use crate::{
    cli_manager::CliState,
    device_speech::{self, DeviceSpeech, Engine, MicrophonePurpose, Request as SpeechRequest},
    AppState,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::{mpsc, Arc, Weak},
    time::Duration,
};
use tauri::{
    ipc::{Invoke, InvokeBody, InvokeResolver},
    webview::PageLoadEvent,
    AppHandle, Manager, Runtime, Webview,
};
use url::Url;
use uuid::Uuid;

const MAX_TEXT_BYTES: usize = 64 * 1024;
const LIFETIME: Duration = Duration::from_secs(5 * 60);
const MAX_CANCELLED_IDS: usize = 256;

#[path = "remote_dictation_window.rs"]
mod window;
use window::{open_sheet, sheet_target_matches};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct RemoteDocument {
    instance: Arc<()>,
    started: bool,
    pub(crate) ready: bool,
    microphone_ready: bool,
    cancelled: HashSet<Uuid>,
}

impl RemoteDocument {
    fn matches(&self, instance: &Arc<()>) -> bool {
        Arc::ptr_eq(&self.instance, instance)
    }

    fn allows(&self, id: Uuid) -> bool {
        self.ready && self.cancelled.len() < MAX_CANCELLED_IDS && !self.cancelled.contains(&id)
    }

    fn cancel(&mut self, id: Uuid) {
        // Fail closed for this document on overflow instead of evicting an
        // earlier cancellation and potentially admitting its queued begin.
        if self.cancelled.len() < MAX_CANCELLED_IDS {
            self.cancelled.insert(id);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments<T> {
    request: T,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Read {},
    Begin {
        id: String,
        locale: String,
    },
    Cancel {
        id: String,
    },
    ClaimMicrophone {
        id: String,
        purpose: MicrophonePurpose,
    },
    ReleaseMicrophone {
        id: String,
    },
    #[cfg(target_os = "linux")]
    StartApiMicrophone {
        id: String,
    },
    #[cfg(target_os = "linux")]
    StartApiInputTest {
        id: String,
    },
    #[cfg(target_os = "linux")]
    StatusApiMicrophone {
        id: String,
    },
    #[cfg(target_os = "linux")]
    FinishApiMicrophone {
        id: String,
    },
    #[cfg(target_os = "linux")]
    RevokeApiMicrophone {
        id: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum Settlement {
    Complete { text: String },
    Cancel {},
    Settings {},
}

fn request_id(value: &str) -> Result<Uuid, &'static str> {
    device_speech::microphone_id(value).ok_or("Invalid dictation request ID")
}

pub(crate) fn is_sheet(label: &str) -> bool {
    label.starts_with("dictation-")
}

pub(crate) fn remote_unloading<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    window_generation: Option<u64>,
) {
    retire_remote_document(app, label, window_generation, true);
}

pub(crate) fn remote_navigation_pending<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    window_generation: Option<u64>,
) {
    retire_remote_document(app, label, window_generation, false);
}

fn retire_remote_document<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    window_generation: Option<u64>,
    document_gone: bool,
) {
    let state = app.state::<AppState>();
    let Ok(mut entries) = state.remote_navigation.lock() else {
        return;
    };
    let Some(entry) = entries.get_mut(label).filter(|entry| {
        window_generation.is_none_or(|generation| generation == entry.window_generation)
    }) else {
        return;
    };
    let speech = app.state::<DeviceSpeech>();
    entry.dictation_document = RemoteDocument {
        microphone_ready: !document_gone && entry.dictation_document.microphone_ready,
        ..RemoteDocument::default()
    };
    if document_gone {
        speech.revoke(Some(label));
    } else {
        // A requested navigation or close can fail. The old document's
        // renderer stream still owns its lease until the native unload.
        #[cfg(target_os = "linux")]
        speech.revoke_remote_microphone(Some(label), None);
    }
    let sheet = take(app, |sheet| sheet.originator == label);
    drop(entries);
    if let Some(sheet) = sheet {
        finish(app, sheet, None);
    }
}

pub(crate) fn remote_page_load(
    app: &AppHandle,
    label: &str,
    window_generation: u64,
    event: PageLoadEvent,
    url: &Url,
) {
    if event == PageLoadEvent::Started {
        remote_unloading(app, label, Some(window_generation));
    }
    if let Ok(mut entries) = app.state::<AppState>().remote_navigation.lock() {
        if let Some(entry) = entries.get_mut(label) {
            if entry.window_generation == window_generation
                && remote_origin_matches(&entry.origin, url)
            {
                let document = &mut entry.dictation_document;
                match event {
                    PageLoadEvent::Started => document.started = true,
                    PageLoadEvent::Finished if document.started => {
                        document.ready = true;
                        document.microphone_ready = microphone_document_url(url);
                    }
                    PageLoadEvent::Finished => (),
                }
            }
        }
    }
}

pub(crate) fn bind_termination(webview: &Webview, remote_window_generation: Option<u64>) {
    let host = webview
        .app_handle()
        .state::<RemoteDictation>()
        .1
        .lock()
        .clone();
    let label = webview.label().to_owned();
    crate::notification_badge_lifetime::bind(webview, move || {
        if let Some(app) = host.upgrade() {
            if remote_window_generation.is_some() {
                remote_unloading(&app, &label, remote_window_generation);
            } else if is_sheet(&label) {
                revoke(&app, Some(&label));
            } else {
                app.state::<DeviceSpeech>().revoke(Some(&label));
            }
        }
    });
}

fn remote_origin_matches(origin: &str, url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && origin == url.origin().ascii_serialization()
}

fn secure_microphone_origin(url: &Url) -> bool {
    // Keep the browser's secure-context boundary for remote capture.
    url.scheme() == "https"
        || url.scheme() == "http"
            && match url.host() {
                Some(url::Host::Domain(host)) => host == "localhost",
                Some(url::Host::Ipv4(host)) => host.is_loopback(),
                Some(url::Host::Ipv6(host)) => host.is_loopback(),
                None => false,
            }
}

fn microphone_document_url(url: &Url) -> bool {
    secure_microphone_origin(url) && crate::device_speech_ipc::is_microphone_document(url)
}

fn is_microphone_document(entry: &crate::RemoteWindowMetadata, current: &Url) -> bool {
    entry.dictation_document.microphone_ready
        && remote_origin_matches(&entry.origin, current)
        && microphone_document_url(current)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn authorize_renderer_microphone(webview: &Webview, generation: u64) -> bool {
    let Ok(current) = webview.url() else {
        return false;
    };
    let app = webview.app_handle();
    let state = app.state::<AppState>();
    let Ok(metadata) = state.remote_navigation.lock() else {
        return false;
    };
    metadata.get(webview.label()).is_some_and(|entry| {
        entry.window_generation == generation && is_microphone_document(entry, &current)
    }) && app
        .state::<DeviceSpeech>()
        .authorize_remote_renderer_microphone(webview.label())
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ApiMicrophonePurpose {
    Dictation,
    InputTest,
}

#[cfg(target_os = "linux")]
impl ApiMicrophonePurpose {
    pub(crate) fn microphone_purpose(self) -> MicrophonePurpose {
        match self {
            Self::Dictation => MicrophonePurpose::Dictation,
            Self::InputTest => MicrophonePurpose::Test,
        }
    }

    pub(crate) fn allows_engine(self, api_selected: impl FnOnce() -> bool) -> bool {
        // An input test is independent of the engine choice, but still needs
        // the same document checks and its own native consent to open the source.
        self == Self::InputTest || api_selected()
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn with_api_microphone_document<T>(
    app: &AppHandle,
    label: &str,
    current: &Url,
    window_generation: u64,
    action: impl FnOnce(&str) -> T,
) -> Option<T> {
    let state = app.state::<AppState>();
    let entries = state.remote_navigation.lock().ok()?;
    let entry = entries.get(label)?;
    if entry.window_generation != window_generation
        || !entry.dictation_document.ready
        || !is_microphone_document(entry, current)
    {
        return None;
    }
    crate::shutdown::with_navigation_authority(app, || action(&entry.dictation_destination))
}

struct Sheet {
    originator: String,
    id: Uuid,
    label: String,
    target: Url,
    backend_generation: u64,
    remote_generation: u64,
    // Exactly one top-level load, including when a platform reports only
    // page-load events for its initial navigation.
    started: bool,
    ready: bool,
    reply: Box<dyn FnOnce(Option<String>) + Send>,
    _deadline: mpsc::Sender<()>,
}

impl Sheet {
    fn originates_from(&self, label: &str, id: Option<Uuid>) -> bool {
        self.originator == label && id.is_none_or(|id| id == self.id)
    }

    fn bound_to(&self, label: &str) -> bool {
        self.label == label || self.originates_from(label, None)
    }
}

#[derive(Default)]
struct Slot {
    sheet: Option<Sheet>,
    retiring: Option<String>,
}

impl Slot {
    fn take(&mut self, matches: impl FnOnce(&Sheet) -> bool) -> Option<Sheet> {
        if !matches(self.sheet.as_ref()?) {
            return None;
        }
        let sheet = self.sheet.take()?;
        self.retiring = Some(sheet.label.clone());
        Some(sheet)
    }
}

#[derive(Default)]
pub(crate) struct RemoteDictation(Mutex<Slot>, Mutex<Weak<AppHandle>>);

impl RemoteDictation {
    pub(crate) fn set_host(&self, host: &Arc<AppHandle>) {
        *self.1.lock() = Arc::downgrade(host);
    }
}

fn backend_target(state: &AppState, locale: &str, destination: &str) -> Option<(Url, u64)> {
    let generation = state.manager.generation();
    let status = state.manager.status();
    if status.state != CliState::Ready || !state.manager.is_current_generation(generation) {
        return None;
    }
    sheet_target(status.url.as_deref()?, locale, destination).map(|target| (target, generation))
}

fn sheet_target(base: &str, locale: &str, destination: &str) -> Option<Url> {
    let mut target = Url::parse(base).ok()?;
    if !matches!(target.scheme(), "http" | "https")
        || !matches!(target.host_str(), Some("localhost" | "127.0.0.1"))
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return None;
    }
    target.set_path("/");
    target.set_fragment(None);
    target.set_query(None);
    target
        .query_pairs_mut()
        .append_pair("dictationLocale", locale);
    target.set_fragment(Some(&format!(
        "dictationDestination={}",
        url::form_urlencoded::byte_serialize(destination.as_bytes()).collect::<String>()
    )));
    Some(target)
}

fn sheet_matches(sheet: &Sheet, label: &str, current: &Url, backend_current: bool) -> bool {
    sheet.ready
        && sheet.label == label
        && sheet.target.origin() == current.origin()
        && backend_current
}

fn sheet_can_read_while_loading(
    sheet: &Sheet,
    label: &str,
    current: &Url,
    backend_current: bool,
) -> bool {
    sheet.started
        && sheet.label == label
        && sheet_target_matches(&sheet.target, current)
        && backend_current
}

pub(crate) fn with_trusted_sheet<R: Runtime, T>(
    app: &AppHandle<R>,
    label: &str,
    current: &Url,
    read_only: bool,
    action: impl FnOnce() -> T,
) -> Option<T> {
    let relay = app.state::<RemoteDictation>();
    let slot = relay.0.lock();
    let sheet = slot.sheet.as_ref()?;
    let state = app.state::<AppState>();
    let backend_current = state.manager.is_ready_generation(sheet.backend_generation);
    (sheet_matches(sheet, label, current, backend_current)
        || (read_only && sheet_can_read_while_loading(sheet, label, current, backend_current)))
    .then(action)
}

fn take<R: Runtime>(app: &AppHandle<R>, matches: impl FnOnce(&Sheet) -> bool) -> Option<Sheet> {
    let relay = app.state::<RemoteDictation>();
    let mut slot = relay.0.lock();
    let sheet = slot.take(matches)?;
    app.state::<DeviceSpeech>().revoke(Some(&sheet.label));
    Some(sheet)
}

fn finish<R: Runtime>(app: &AppHandle<R>, sheet: Sheet, text: Option<String>) {
    (sheet.reply)(text);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wry executes run_on_main_thread inline when called by a native
        // callback. Destroy outside navigation, load and close callbacks.
        let dispatch = app.clone();
        let label = sheet.label;
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = dispatch.get_webview_window(&label) {
                let _ = window.destroy();
            } else {
                retired(&dispatch, &label);
            }
        });
    });
}

pub(crate) fn revoke<R: Runtime>(app: &AppHandle<R>, label: Option<&str>) {
    #[cfg(target_os = "linux")]
    if label.is_none() {
        app.state::<DeviceSpeech>()
            .revoke_remote_microphone(None, None);
    }
    if let Some(sheet) = take(app, |sheet| label.is_none_or(|label| sheet.bound_to(label))) {
        finish(app, sheet, None);
    }
}

pub(crate) fn retired<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let relay = app.state::<RemoteDictation>();
    let mut slot = relay.0.lock();
    if slot.retiring.as_deref() == Some(label) {
        slot.retiring = None;
    }
}

fn primary_origin(invoke: &Invoke) -> Result<Url, String> {
    let webview = invoke.message.webview_ref();
    if invoke.acl.is_none() || webview.label() != webview.window().label() {
        return Err("Dictation requires an authorized primary webview".into());
    }
    let url = webview.url().map_err(|error| error.to_string())?;
    // The custom protocol supplies the browser Origin. IPC postMessage uses
    // the native webview URL (Tauri also checks the source URL against its ACL).
    if let Some(origin) = invoke.message.headers().get("Origin") {
        let origin = origin
            .to_str()
            .ok()
            .and_then(|value| Url::parse(value).ok());
        if origin.is_none_or(|origin| origin.origin() != url.origin()) {
            return Err("Dictation requires the current renderer origin".into());
        }
    }
    Ok(url)
}

fn parse<T: serde::de::DeserializeOwned>(invoke: &Invoke) -> Result<T, String> {
    // Deserialize the existing value without another allocation of the full IPC payload.
    if let InvokeBody::Json(value) = invoke.message.payload() {
        return Arguments::<T>::deserialize(value)
            .map(|args| args.request)
            .map_err(|_| "Invalid dictation request".into());
    }
    Err("Invalid dictation request".into())
}

fn remote_request(
    webview: &Webview,
    request: Request,
    current: Url,
    document_instance: Option<Arc<()>>,
    resolver: &InvokeResolver,
) -> Result<(), &'static str> {
    let app = webview.app_handle();
    let state = app.state::<AppState>();
    let label = webview.label();
    let speech = app.state::<DeviceSpeech>();
    let preference = document_instance.as_ref().map(|_| speech.preferred_engine());
    let read_choice = || match &preference {
        Some(Ok(choice)) => Ok(*choice),
        _ => Err("Device speech preference unavailable"),
    };
    let requires_focus = matches!(
        request,
        Request::Begin { .. } | Request::ClaimMicrophone { .. }
    );
    #[cfg(target_os = "linux")]
    let requires_focus = requires_focus
        || matches!(
            request,
            Request::StartApiMicrophone { .. } | Request::StartApiInputTest { .. }
        );
    let focused = !requires_focus || webview.window().is_focused().unwrap_or(false);
    let mut metadata = state
        .remote_navigation
        .lock()
        .map_err(|_| "Remote window registry unavailable")?;
    let registered = metadata
        .get_mut(label)
        .filter(|entry| {
            remote_origin_matches(&entry.origin, &current)
                && document_instance.as_ref().is_none_or(|expected| {
                    entry.dictation_document.matches(expected)
                })
        })
        .ok_or("Dictation requires a registered remote document")?;
    let document = &mut registered.dictation_document;
    match request {
        Request::ClaimMicrophone { .. } | Request::ReleaseMicrophone { .. } => {
            if !is_microphone_document(registered, &current) || !focused {
                return Err("Microphone requires the registered remote application document");
            }
            let input = match request {
                Request::ClaimMicrophone { id, purpose } => {
                    SpeechRequest::ClaimMicrophone { id, purpose }
                }
                Request::ReleaseMicrophone { id } => SpeechRequest::ReleaseMicrophone { id },
                _ => unreachable!(),
            };
            if !input.valid() {
                return Err("Invalid dictation request ID");
            }
            let result = crate::shutdown::with_navigation_authority(app, || {
                speech.request_remote(label, input)
            })
            .ok_or("unavailable")?;
            drop(metadata);
            resolver
                .clone()
                .resolve(crate::device_speech_ipc::speech_response(result));
        }
        #[cfg(target_os = "linux")]
        Request::StartApiMicrophone { ref id } | Request::StartApiInputTest { ref id } => {
            let id = request_id(id)?;
            let purpose = match request {
                Request::StartApiInputTest { .. } => ApiMicrophonePurpose::InputTest,
                _ => ApiMicrophonePurpose::Dictation,
            };
            if !is_microphone_document(registered, &current)
                || !registered.dictation_document.allows(id)
                || !focused
                || !purpose.allows_engine(|| read_choice() == Ok(Some(Engine::Api)))
            {
                return Err("API microphone requires the focused remote application document");
            }
            let capture = crate::shutdown::with_navigation_authority(app, || {
                speech.reserve_remote_microphone(label, id, purpose)
            })
            .ok_or("unavailable")?
            .ok_or("busy")?;
            let generation = registered.window_generation;
            drop(metadata);
            remote_microphone::prompt(webview, capture, generation, current, resolver)?;
        }
        #[cfg(target_os = "linux")]
        Request::StatusApiMicrophone { ref id } | Request::FinishApiMicrophone { ref id } => {
            if !registered.dictation_document.ready || !is_microphone_document(registered, &current)
            {
                return Err("unavailable");
            }
            let capture = speech
                .get_remote_microphone(label, request_id(id)?)
                .ok_or("unavailable")?;
            if !capture
                .purpose()
                    .allows_engine(|| read_choice() == Ok(Some(Engine::Api)))
            {
                return Err("unavailable");
            }
            crate::shutdown::with_navigation_authority(app, || match request {
                Request::FinishApiMicrophone { .. } => capture.finish(resolver),
                _ => {
                    resolver.clone().resolve(capture.status()?);
                    Ok(())
                }
            })
            .ok_or("unavailable")??;
        }
        #[cfg(target_os = "linux")]
        Request::RevokeApiMicrophone { id } => {
            let id = request_id(&id)?;
            if !speech.revoke_remote_microphone(Some(label), Some(id)) {
                document.cancel(id);
            }
            resolver.clone().resolve(Value::Null);
        }
        Request::Read {} => {
            let choice = read_choice()?;
            drop(metadata);
            resolver.clone().resolve(choice);
        }
        Request::Cancel { id } => {
            let id = request_id(&id)?;
            let cancelled = take(app, |sheet| sheet.originates_from(label, Some(id)));
            if cancelled.is_none() {
                document.cancel(id);
            }
            drop(metadata);
            if let Some(sheet) = cancelled {
                finish(app, sheet, None);
            }
            resolver.clone().resolve(Value::Null);
        }
        Request::Begin { id, locale } => {
            let id = request_id(&id)?;
            if !device_speech::valid_locale(&locale) {
                return Err("Invalid dictation locale");
            }
            if !document.allows(id) {
                drop(metadata);
                resolver.clone().resolve(Value::Null);
                return Ok(());
            }
            if !focused {
                return Err("Focus the remote window to begin dictation");
            }
            let (target, generation) =
                backend_target(&state, &locale, &registered.dictation_destination)
                    .ok_or("Local dictation backend unavailable")?;
            if read_choice()? != Some(Engine::Hex) {
                return Err("Select native dictation in local Preferences");
            }
            let relay = app.state::<RemoteDictation>();
            let sheet_label = format!("dictation-{}", Uuid::new_v4());
            let (deadline, wait) = mpsc::channel();
            crate::shutdown::with_navigation_authority(app, || {
                let mut slot = relay.0.lock();
                if slot.sheet.is_some() || slot.retiring.is_some() {
                    return Err("A dictation window is already open");
                }
                if !state.manager.is_ready_generation(generation) {
                    return Err("Local dictation backend changed");
                }
                let resolver = resolver.clone();
                slot.sheet = Some(Sheet {
                    originator: label.to_owned(),
                    id,
                    label: sheet_label.clone(),
                    target: target.clone(),
                    backend_generation: generation,
                    remote_generation: registered.generation,
                    started: false,
                    ready: false,
                    reply: Box::new(move |text| resolver.resolve(text)),
                    _deadline: deadline,
                });
                Ok(())
            })
            .ok_or("Application is shutting down")??;
            drop(metadata);
            let open_app = app.clone();
            let open_label = sheet_label.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let access = open_app.state::<AppState>().manager.local_cli_access();
                let dispatch = open_app.clone();
                let dispatch_label = open_label.clone();
                if open_app
                    .run_on_main_thread(move || {
                        let active = dispatch
                            .state::<RemoteDictation>()
                            .0
                            .lock()
                            .sheet
                            .as_ref()
                            .is_some_and(|sheet| sheet.label == dispatch_label);
                        if active
                            && open_sheet(&dispatch, &dispatch_label, target, generation, access)
                                .is_err()
                        {
                            revoke(&dispatch, Some(&dispatch_label));
                        }
                    })
                    .is_err()
                {
                    revoke(&open_app, Some(&open_label));
                }
            });
            let deadline_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if wait.recv_timeout(LIFETIME) == Err(mpsc::RecvTimeoutError::Timeout) {
                    revoke(&deadline_app, Some(&sheet_label));
                }
            });
        }
    }
    Ok(())
}

fn settle_text(request: Settlement) -> Result<(Option<String>, bool), String> {
    match request {
        Settlement::Complete { text } if text.len() <= MAX_TEXT_BYTES => Ok((Some(text), false)),
        Settlement::Complete { .. } => Err("Dictation text exceeds 64 KiB".into()),
        Settlement::Cancel {} => Ok((None, false)),
        Settlement::Settings {} => Ok((None, true)),
    }
}

fn settle(webview: &Webview, current: Url, request: Settlement) -> Result<(), String> {
    let (text, settings) = settle_text(request)?;
    let app = webview.app_handle();
    let state = app.state::<AppState>();
    let entries = state
        .remote_navigation
        .lock()
        .map_err(|_| "Remote window registry unavailable")?;
    let sheet = crate::shutdown::with_navigation_authority(app, || {
        take(app, |sheet| {
            sheet_matches(
                sheet,
                webview.label(),
                &current,
                state.manager.is_ready_generation(sheet.backend_generation),
            ) && entries.get(&sheet.originator).is_some_and(|entry| {
                entry.generation == sheet.remote_generation && entry.dictation_document.ready
            })
        })
    })
    .flatten()
    .ok_or("Dictation requires the registered local sheet")?;
    let generation = sheet.backend_generation;
    finish(app, sheet, text);
    drop(entries);
    if settings {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if crate::shutdown::with_navigation_authority(&app, || {
                app.state::<AppState>()
                    .manager
                    .is_ready_generation(generation)
            }) == Some(true)
            {
                let _ = crate::preferences_window::open_speech(&app);
            }
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "remote_dictation_tests.rs"]
mod tests;

pub(crate) fn with_relay(generated: impl Fn(Invoke) -> bool) -> impl Fn(Invoke) -> bool {
    move |invoke| match dispatch(invoke) {
        Ok(()) => true,
        Err(invoke) => generated(invoke),
    }
}

fn dispatch(invoke: Invoke) -> Result<(), Invoke> {
    match invoke.message.command() {
        "remote_dictation_request" => {
            let result = primary_origin(&invoke).and_then(|url| {
                let request = parse(&invoke)?;
                let webview = invoke.message.webview_ref();
                let reads_preference = match &request {
                    Request::Read {} | Request::Begin { .. } => true,
                    #[cfg(target_os = "linux")]
                    Request::StartApiMicrophone { .. } | Request::StartApiInputTest { .. }
                    | Request::StatusApiMicrophone { .. } | Request::FinishApiMicrophone { .. } => true,
                    _ => false,
                };
                if !reads_preference {
                    return remote_request(webview, request, url, None, &invoke.resolver)
                        .map_err(str::to_owned);
                }
                let state = webview.app_handle().state::<AppState>();
                let document = state.remote_navigation.lock().ok()
                    .and_then(|entries| entries.get(webview.label()).map(|entry| entry.dictation_document.instance.clone()))
                    .ok_or("Dictation requires a registered remote document")?;
                let webview = webview.clone();
                let resolver = invoke.resolver.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = remote_request(&webview, request, url, Some(document), &resolver) {
                        resolver.reject(error);
                    }
                });
                Ok(())
            });
            if let Err(error) = result {
                invoke.resolver.reject(error);
            }
        }
        "settle_remote_dictation" => {
            let result = primary_origin(&invoke)
                .and_then(|url| settle(invoke.message.webview_ref(), url, parse(&invoke)?));
            invoke.resolver.respond(result.map_err(Into::into));
        }
        _ => return Err(invoke),
    }
    Ok(())
}
