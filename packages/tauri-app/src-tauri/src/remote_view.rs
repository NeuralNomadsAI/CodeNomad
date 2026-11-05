//! Remote CodeNomad project tabs: a child webview per tab, inside the local
//! window that owns it, on the storage of that server's remote window. Its
//! `remote-view-*` label gives it the remote windows' capability (notifications
//! and the badge command, which refuses child webviews) and nothing local.
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, Url};

pub(crate) const LABEL_PREFIX: &str = "remote-view-";
const EMBED_PARAM: &str = "codenomadEmbed";
const EMBED_PROJECT: &str = "project";
const MAX_COORDINATE: i64 = 100_000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub(crate) struct RemoteViewBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteViewOpen {
    view_id: String,
    profile_id: String,
    base_url: String,
    url: String,
    bounds: RemoteViewBounds,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteViewUpdate {
    view_id: String,
    bounds: Option<RemoteViewBounds>,
    visible: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct Record {
    owner: String,
    origin: String,
    /// The single-project address the view returns to; follows the project it shows.
    entry: String,
}

#[derive(Default)]
pub(crate) struct RemoteViews {
    records: Mutex<HashMap<String, Record>>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Navigation {
    Allow,
    Entry,
    Help,
    Deny,
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Invalid remote view id".into());
    }
    Ok(())
}

fn validate_bounds(bounds: RemoteViewBounds) -> Result<RemoteViewBounds, String> {
    let valid = |value: i64, min: i64| value >= min && value <= MAX_COORDINATE;
    if !valid(bounds.x.into(), 0)
        || !valid(bounds.y.into(), 0)
        || !valid(bounds.width.into(), 1)
        || !valid(bounds.height.into(), 1)
    {
        return Err("Invalid remote view bounds".into());
    }
    Ok(bounds)
}

pub(crate) fn view_label(owner: &str, view_id: &str) -> Result<String, String> {
    validate_id(view_id)?;
    Ok(format!("{LABEL_PREFIX}{owner}-{view_id}"))
}

fn http_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Remote view addresses must use HTTP or HTTPS".into());
    }
    Ok(url)
}

/// A view stays on its server's origin. Login and pairing pages end on the bare
/// root: that returns to the tab's single-project entry instead.
pub(crate) fn decide(url: &Url, origin: &str) -> Navigation {
    if url.as_str() == "about:blank" {
        return Navigation::Allow;
    }
    if matches!(url.scheme(), "http" | "https") && url.origin().ascii_serialization() == origin {
        return if url.path() == "/" && url.query().is_none() {
            Navigation::Entry
        } else {
            Navigation::Allow
        };
    }
    if crate::open_remote_external_url(url, |_| {}) {
        Navigation::Help
    } else {
        Navigation::Deny
    }
}

fn is_embedded_entry(url: &Url) -> bool {
    url.query_pairs()
        .any(|(key, value)| key == EMBED_PARAM && value == EMBED_PROJECT)
}

/// The view's own single-project address, else the server's bare entry.
pub(crate) fn entry_for(url: &Url, origin: &str) -> String {
    if is_embedded_entry(url) {
        url.to_string()
    } else {
        format!("{origin}/?{EMBED_PARAM}={EMBED_PROJECT}")
    }
}

impl RemoteViews {
    fn record(&self, label: &str) -> Option<Record> {
        self.records.lock().ok()?.get(label).cloned()
    }

    fn owned(&self, owner: &str, view_id: &str) -> Result<String, String> {
        let label = view_label(owner, view_id)?;
        match self.record(&label) {
            Some(record) if record.owner == owner => Ok(label),
            _ => Err("Remote view is no longer available".into()),
        }
    }

    /// A page that loads again in the owning window reopens its tabs' views.
    pub(crate) fn renderer_page_started<R: Runtime>(&self, webview: &tauri::Webview<R>) {
        if webview.label() == webview.window().label()
            && crate::identity::local_window_id(webview.label()).is_ok()
        {
            self.remove_window(webview.app_handle(), webview.label());
        }
    }

    pub(crate) fn remove_window<R: Runtime>(&self, app: &AppHandle<R>, owner: &str) {
        let labels = match self.records.lock() {
            Ok(mut records) => {
                let labels = records
                    .iter()
                    .filter(|(_, record)| record.owner == owner)
                    .map(|(label, _)| label.clone())
                    .collect::<Vec<_>>();
                for label in &labels {
                    records.remove(label);
                }
                labels
            }
            Err(_) => return,
        };
        for label in labels {
            if let Some(view) = app.get_webview(&label) {
                let _ = view.close();
            }
        }
    }

    pub(crate) fn update(
        &self,
        app: &AppHandle,
        owner: &str,
        input: RemoteViewUpdate,
    ) -> Result<(), String> {
        let label = self.owned(owner, &input.view_id)?;
        let view = app
            .get_webview(&label)
            .ok_or("Remote view is no longer available")?;
        if !input.visible {
            return view.hide().map_err(|error| error.to_string());
        }
        let bounds = validate_bounds(input.bounds.ok_or("Visible remote view bounds are required")?)?;
        view.set_position(PhysicalPosition::new(bounds.x, bounds.y))
            .and_then(|()| view.set_size(PhysicalSize::new(bounds.width, bounds.height)))
            .and_then(|()| view.show())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn close(&self, app: &AppHandle, owner: &str, view_id: &str) -> Result<(), String> {
        let Ok(label) = self.owned(owner, view_id) else {
            return Ok(());
        };
        if let Ok(mut records) = self.records.lock() {
            records.remove(&label);
        }
        if let Some(view) = app.get_webview(&label) {
            view.close().map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn open(
        &self,
        app: &AppHandle,
        window: &tauri::Window,
        owner: &str,
        input: RemoteViewOpen,
    ) -> Result<(), String> {
        use tauri::webview::{NewWindowResponse, WebviewBuilder};
        use tauri::WebviewUrl;

        let base = http_url(&input.base_url)?;
        let target = http_url(&input.url)?;
        let origin = base.origin().ascii_serialization();
        if target.origin().ascii_serialization() != origin {
            return Err("Remote view must open on its server's origin".into());
        }
        if input.profile_id.trim().is_empty() {
            return Err("Remote view requires a saved server".into());
        }
        let bounds = validate_bounds(input.bounds)?;
        let label = view_label(owner, &input.view_id)?;
        let _ = self.close(app, owner, &input.view_id);
        let record = Record {
            owner: owner.to_string(),
            origin: origin.clone(),
            entry: entry_for(&target, &origin),
        };
        self.records
            .lock()
            .map_err(|error| error.to_string())?
            .insert(label.clone(), record);

        let navigation_app = app.clone();
        let navigation_label = label.clone();
        let navigation_origin = origin.clone();
        let help_app = app.clone();
        let title_app = app.clone();
        let title_label = label.clone();
        let title_owner = owner.to_string();
        let title_view_id = input.view_id.clone();
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
            // The remote window's storage: its sessions and paired device cookie.
            .data_directory(crate::remote_profile_data_directory(app, &input.profile_id))
            .initialization_script(crate::REMOTE_WINDOW_CONTEXT_SCRIPT)
            .on_navigation(move |url| match decide(url, &navigation_origin) {
                Navigation::Allow => true,
                Navigation::Entry => {
                    let app = navigation_app.clone();
                    let label = navigation_label.clone();
                    tauri::async_runtime::spawn(async move {
                        let views = app.state::<RemoteViews>();
                        let Some(entry) = views.record(&label).and_then(|record| Url::parse(&record.entry).ok()) else {
                            return;
                        };
                        if let Some(view) = app.get_webview(&label) {
                            let _ = view.navigate(entry);
                        }
                    });
                    false
                }
                Navigation::Help => {
                    if let Err(error) = crate::external_open::open_url(&navigation_app, url.as_str()) {
                        eprintln!("[tauri] failed to open help: {error}");
                    }
                    false
                }
                Navigation::Deny => false,
            })
            .on_new_window(move |url, _| {
                crate::open_remote_external_url(&url, |url| {
                    let _ = crate::external_open::open_url(&help_app, url.as_str());
                });
                NewWindowResponse::Deny
            })
            .on_download(|_, _| false)
            .on_document_title_changed(move |view, title| {
                let Ok(url) = view.url() else { return };
                let views = title_app.state::<RemoteViews>();
                if let Ok(mut records) = views.records.lock() {
                    if let Some(record) = records.get_mut(&title_label) {
                        if url.origin().ascii_serialization() == record.origin && is_embedded_entry(&url) {
                            record.entry = url.to_string();
                        }
                    }
                }
                let _ = title_app.emit_to(
                    tauri::EventTarget::webview(title_owner.clone()),
                    "remote-view:updated",
                    json!({ "viewId": title_view_id, "url": url.as_str(), "title": title }),
                );
            });
        let view = match window.add_child(
            builder,
            PhysicalPosition::new(bounds.x, bounds.y),
            PhysicalSize::new(bounds.width, bounds.height),
        ) {
            Ok(view) => view,
            Err(error) => {
                if let Ok(mut records) = self.records.lock() {
                    records.remove(&label);
                }
                return Err(format!("failed to create remote view: {error}"));
            }
        };
        crate::windows_browser_accelerators::bind(&view);
        view.show().map_err(|error| error.to_string())
    }

    #[cfg(not(windows))]
    pub(crate) fn open(
        &self,
        _app: &AppHandle,
        _window: &tauri::Window,
        _owner: &str,
        _input: RemoteViewOpen,
    ) -> Result<(), String> {
        Err("Remote project tabs are available on Windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://box.example";

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn remote_views_stay_on_their_server_and_return_to_their_entry() {
        assert_eq!(decide(&url("https://box.example/?codenomadEmbed=project"), ORIGIN), Navigation::Allow);
        assert_eq!(decide(&url("https://box.example/login"), ORIGIN), Navigation::Allow);
        assert_eq!(decide(&url("https://box.example/"), ORIGIN), Navigation::Entry);
        assert_eq!(decide(&url("about:blank"), ORIGIN), Navigation::Allow);
        assert_eq!(decide(&url("https://evil.example/"), ORIGIN), Navigation::Deny);
        assert_eq!(decide(&url("http://box.example/"), ORIGIN), Navigation::Deny);
        assert_eq!(decide(&url("file:///C:/Windows"), ORIGIN), Navigation::Deny);
        assert_eq!(
            decide(&url("https://neuralnomadsai.github.io/CodeNomad/en/"), ORIGIN),
            Navigation::Help
        );
        let project = url("https://box.example/?codenomadEmbed=project&folder=%2Fsrv");
        assert_eq!(entry_for(&project, ORIGIN), project.to_string());
        assert_eq!(
            entry_for(&url("https://box.example/remote-pair#code"), ORIGIN),
            "https://box.example/?codenomadEmbed=project"
        );
    }

    #[test]
    fn remote_view_labels_and_bounds_are_validated() {
        let owner = "local-11111111-1111-4111-8111-111111111111";
        let label = view_label(owner, "tab_1-a").unwrap();
        assert!(label.starts_with("remote-view-local-"));
        // The remote windows' capability pattern, never a local window's.
        assert!(label.starts_with("remote-"));
        assert!(crate::identity::local_window_id(&label).is_err());
        assert!(view_label(owner, "../x").is_err());
        assert!(view_label(owner, "").is_err());
        assert!(validate_bounds(RemoteViewBounds { x: 0, y: 0, width: 0, height: 1 }).is_err());
        assert!(validate_bounds(RemoteViewBounds { x: -1, y: 0, width: 1, height: 1 }).is_err());
        assert!(validate_bounds(RemoteViewBounds { x: 0, y: 40, width: 800, height: 600 }).is_ok());
    }

    #[test]
    fn remote_view_children_have_only_the_remote_windows_capability() {
        use std::collections::BTreeMap;
        use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
        let manifests: BTreeMap<String, Manifest> =
            serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
        let capabilities: BTreeMap<String, Capability> =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        let resolved = Resolved::resolve(
            &manifests,
            capabilities,
            tauri::utils::platform::Target::current(),
        )
        .unwrap();
        let authority = tauri::runtime_authority!(manifests, resolved);
        let owner = "local-11111111-1111-4111-8111-111111111111";
        let child = view_label(owner, "tab").unwrap();
        let remote = tauri::ipc::Origin::Remote {
            url: "https://box.example/?codenomadEmbed=project".parse().unwrap(),
        };
        assert!(authority
            .resolve_access("plugin:notification|notify", owner, &child, &remote)
            .is_some());
        for command in [
            "remote_view_open",
            "remote_view_update",
            "remote_view_close",
            "open_remote_window",
            "open_external_url",
            "browser_target_register",
            "client_state_load",
            "cli_restart",
            "window_control",
            "plugin:dialog|open",
            "plugin:event|listen",
        ] {
            assert!(
                authority.resolve_access(command, owner, &child, &remote).is_none(),
                "remote view gained {command}"
            );
        }
        let local = tauri::ipc::Origin::Remote {
            url: "http://127.0.0.1:32123/app".parse().unwrap(),
        };
        assert!(authority
            .resolve_access("remote_view_open", owner, owner, &local)
            .is_some());
    }

    #[test]
    fn remote_views_belong_to_their_owner_window() {
        let views = RemoteViews::default();
        let owner = "local-a";
        let label = view_label(owner, "tab").unwrap();
        views.records.lock().unwrap().insert(
            label.clone(),
            Record { owner: owner.into(), origin: ORIGIN.into(), entry: format!("{ORIGIN}/?codenomadEmbed=project") },
        );
        assert_eq!(views.owned(owner, "tab").unwrap(), label);
        assert!(views.owned("local-b", "tab").is_err());
        assert!(views.owned(owner, "other").is_err());
    }
}
