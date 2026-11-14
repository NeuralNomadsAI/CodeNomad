//! Native guest windows retain the engine's real opener, never an app IPC bridge.
use super::*;

pub(super) fn page_permission_subject(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    if is_allowed_url(&url) {
        return Some(presentation_title(&url, None));
    }
    if url.scheme() == "about" && url.path() == "blank" {
        return Some("about:blank".into());
    }
    if url.scheme() == "blob" {
        let inner = tauri::Url::parse(url.path()).ok()?;
        if is_allowed_url(&inner) {
            return Some(presentation_title(&inner, None));
        }
    }
    None
}

fn presentation_title(url: &tauri::Url, logical: Option<&str>) -> String {
    if private_preview_url(url) {
        return logical
            .and_then(|value| tauri::Url::parse(value).ok())
            .filter(|value| is_allowed_url(value) && !private_preview_url(value))
            .map(|value| value.origin().ascii_serialization())
            .unwrap_or_else(|| "CodeNomad".into());
    }
    url.origin().ascii_serialization()
}

fn download_path(directory: &Path, suggested: &Path) -> Option<PathBuf> {
    if !directory.is_dir() {
        return None;
    }
    let name: String = suggested
        .file_name()?
        .to_string_lossy()
        .chars()
        .filter(|c| !c.is_control() && !"/\\:*?\"<>|".contains(*c))
        .scan(0, |bytes, c| {
            *bytes += c.len_utf8();
            (*bytes <= 180).then_some(c)
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    let name = if name.is_empty() { "download" } else { name };
    // WebKit refuses an existing destination; the random prefix also separates
    // concurrent downloads before either engine has created its file.
    let path = directory.join(format!("{}-{name}", uuid::Uuid::new_v4()));
    if path.exists() {
        return None;
    }
    #[cfg(windows)]
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    Some(path)
}

pub(super) fn permission<R: Runtime>(
    webview: tauri::Webview<R>,
    kind: tauri::webview::PermissionKind,
) -> tauri::webview::PermissionResponse {
    use tauri::webview::{PermissionKind as K, PermissionResponse as R};
    if webview
        .app_handle()
        .try_state::<EmbeddedViews>()
        .is_some_and(|views| views.restricted_browser(webview.label()))
    {
        return R::Deny;
    }
    match kind {
        K::Camera | K::Microphone | K::Geolocation | K::Notifications => R::Deny,
        // Mandatory desktop adapters classify the raw request, including its
        // requester metadata, before allowing consent or reporting a denial.
        K::Other if cfg!(any(windows, target_os = "linux")) => R::Default,
        K::ClipboardRead
        | K::DisplayCapture
        | K::Midi
        | K::Sensors
        | K::MediaKeySystemAccess
        | K::LocalFonts
        | K::WindowManagement
        | K::PointerLock
        | K::AutomaticDownloads
        | K::FileSystemAccess
        | K::Autoplay => R::Default,
        _ => {
            unknown_permission(&webview, &kind.to_string());
            R::Deny
        }
    }
}

pub(super) fn unknown_permission<R: Runtime>(webview: &tauri::Webview<R>, kind: &str) {
    use tauri_plugin_dialog::DialogExt;
    let text = webview
        .app_handle()
        .try_state::<crate::AppState>()
        .map(|state| state.menu_labels.text("browserPermissionUnknown"))
        .unwrap_or_else(|| crate::menu_labels::label("browserPermissionUnknown").to_string())
        .replace("{permission}", kind);
    webview
        .app_handle()
        .dialog()
        .message(text)
        .parent(&webview.window())
        .show(|_| {});
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub(super) fn download<R: Runtime>(
    view: tauri::Webview<R>,
    event: tauri::webview::DownloadEvent<'_>,
) -> bool {
    if view
        .app_handle()
        .try_state::<EmbeddedViews>()
        .is_some_and(|views| views.restricted_browser(view.label()))
    {
        return false;
    }
    match event {
        tauri::webview::DownloadEvent::Requested { url, destination } => {
            if !is_allowed_url(&url) && !matches!(url.scheme(), "blob" | "data") {
                return false;
            }
            let Some(path) = dirs::download_dir().and_then(|dir| download_path(&dir, destination))
            else {
                return false;
            };
            *destination = path;
            true
        }
        _ => true,
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
impl EmbeddedViews {
    pub(super) fn open_popup<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        opener: &str,
        storage: &Storage,
        url: tauri::Url,
        features: tauri::webview::NewWindowFeatures,
    ) -> tauri::webview::NewWindowResponse<R> {
        use tauri::webview::NewWindowResponse;
        // Only browser previews opt in; remote-view consumers keep their policy.
        let Ok(opener_record) = self.owned(owner, opener) else {
            return NewWindowResponse::Deny;
        };
        if opener_record.logical_address.is_some() || private_preview_url(&url) {
            return NewWindowResponse::Deny;
        }
        if !opener.starts_with("browser-")
            || !site_url_allowed(&url, opener_record.origin.as_deref())
        {
            return NewWindowResponse::Deny;
        }
        let Some(parent) = app.get_window(owner) else {
            return NewWindowResponse::Deny;
        };
        let label = format!("browser-popup-{}", uuid::Uuid::new_v4());
        let Ok(mut record) = self.reserve(owner, &label) else {
            return NewWindowResponse::Deny;
        };
        record.opener = Some(opener.into());
        record.origin = opener_record.origin.clone();
        if let Ok(mut inner) = self.0.lock() {
            if !inner.records.get(opener).is_some_and(|current| {
                current.token == opener_record.token && current.document == opener_record.document
            }) {
                inner.records.remove(&label);
                return NewWindowResponse::Deny;
            }
            let Some(current) = inner
                .records
                .get_mut(&label)
                .filter(|current| current.token == record.token)
            else {
                return NewWindowResponse::Deny;
            };
            current.opener = record.opener.clone();
            current.origin = record.origin.clone();
        } else {
            return NewWindowResponse::Deny;
        }
        let policy = self.clone();
        let navigation_label = label.clone();
        let page_policy = self.clone();
        let token = record.token;
        let downloads = self.clone();
        let download_label = label.clone();
        let popups = self.clone();
        let popup_app = app.clone();
        let popup_owner = owner.to_string();
        let popup_opener = label.clone();
        let popup_storage = Storage {
            directory: storage.directory.clone(),
            domain: storage.domain.clone(),
        };
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .window_features(features)
        .title(presentation_title(
            &url,
            opener_record.logical_address.as_deref(),
        ))
        .inner_size(520.0, 680.0)
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(cfg!(windows))
        .visible(false);
        #[cfg(target_os = "linux")]
        let builder = parent
            .gtk_window()
            .map(|parent| builder.transient_for_raw(&parent));
        #[cfg(target_os = "macos")]
        let builder = parent.ns_window().map(|parent| builder.parent_raw(parent));
        #[cfg(windows)]
        let builder = parent.hwnd().map(|parent| builder.owner_raw(parent));
        let builder = builder.map(|builder| {
            builder
                .data_directory(storage.directory.clone())
                .on_page_load(move |view, payload| {
                    page_policy.page_load(view.as_ref(), token, &payload);
                })
                .on_navigation(move |url| {
                    policy.current(&navigation_label, token)
                        && policy.navigation_allowed(&navigation_label, url) == Some(true)
                })
                .on_permission_request({
                    let permissions = self.clone();
                    let permission_label = label.clone();
                    move |view, kind| {
                        if permissions.current(&permission_label, token) {
                            permission(view, kind)
                        } else {
                            tauri::webview::PermissionResponse::Deny
                        }
                    }
                })
                .on_download(move |view, event| {
                    downloads.current(&download_label, token) && download(view, event)
                })
                .on_new_window(move |url, features| {
                    if !popups.current(&popup_opener, token) {
                        return NewWindowResponse::Deny;
                    }
                    popups.open_popup(
                        &popup_app,
                        &popup_owner,
                        &popup_opener,
                        &popup_storage,
                        url,
                        features,
                    )
                })
        });
        let result = builder.and_then(|builder| builder.build());
        let window = match result {
            Ok(window) => window,
            Err(_) => {
                self.remove_exact(&label, &record);
                return NewWindowResponse::Deny;
            }
        };
        self.install_fullscreen_window(&window.as_ref().window());
        let cleanup = self.clone();
        let cleanup_app = app.clone();
        let cleanup_label = label.clone();
        let cleanup_record = record.clone();
        let close_view: tauri::Webview<R> = window.as_ref().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if !cleanup.current(&cleanup_label, cleanup_record.token) {
                    return;
                }
                #[cfg(target_os = "linux")]
                let result = super::linux::request_close(&close_view);
                #[cfg(target_os = "macos")]
                let result = super::macos::request_close(&close_view);
                #[cfg(windows)]
                let result = super::windows::request_close(&close_view);
                if let Err(error) = result {
                    eprintln!("[browser-close] {error}");
                }
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = cleanup.dispose_tree(&cleanup_app, &cleanup_label, cleanup_record.token);
            }
        });
        #[cfg(target_os = "linux")]
        let configured = super::linux::install(window.as_ref());
        #[cfg(target_os = "macos")]
        let configured = super::macos::install(window.as_ref());
        #[cfg(windows)]
        let configured = super::windows::install(window.as_ref());
        if configured
            .and_then(|()| self.finish_creation(&label, &record))
            .is_err()
            || !self.owned(owner, opener).is_ok_and(|current| {
                current.token == opener_record.token && current.document == opener_record.document
            })
        {
            self.remove_exact(&label, &record);
            let _ = window.destroy();
            return NewWindowResponse::Deny;
        }
        if window.show().is_err() {
            self.remove_exact(&label, &record);
            let _ = window.destroy();
            return NewWindowResponse::Deny;
        }
        // WebKit performs the requested navigation after this return, using the
        // supplied related-view/configuration so opener/postMessage stay native.
        NewWindowResponse::Create { window }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn page_scoped_permission_subject_is_native_document_identity() {
        assert_eq!(
            page_permission_subject("https://example.com:8443/path?q=secret"),
            Some("https://example.com:8443".into())
        );
        assert_eq!(
            page_permission_subject("about:blank"),
            Some("about:blank".into())
        );
        assert_eq!(
            page_permission_subject("blob:https://example.com/id"),
            Some("https://example.com".into())
        );
        for raw in [
            "file:///private",
            "tauri://localhost",
            "https://user:pass@example.com",
            "blob:null/id",
        ] {
            assert_eq!(page_permission_subject(raw), None);
        }
    }
    #[test]
    fn downloads_are_sanitized_unique_and_confined() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "../../report.txt",
            "..\\..\\report.txt",
            ".",
            "...",
            "a\n:b?.txt",
            "résumé.txt",
        ] {
            let first = download_path(dir.path(), Path::new(name));
            if name == "." {
                assert!(first.is_none());
                continue;
            }
            let first = first.unwrap();
            assert_eq!(first.parent(), Some(dir.path()));
            assert!(!first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains(['\\', '/', '\n', ':', '?']));
            std::fs::write(&first, "original").unwrap();
            assert_ne!(
                Some(first.clone()),
                download_path(dir.path(), Path::new(name))
            );
            assert_eq!(std::fs::read_to_string(first).unwrap(), "original");
        }
        assert!(download_path(&dir.path().join("missing"), Path::new("file")).is_none());
    }
}
#[test]
fn private_preview_titles_use_a_logical_or_neutral_origin() {
    assert_eq!(
        page_permission_subject(
            "http://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.preview.localhost:9999/path"
        ),
        Some("CodeNomad".into())
    );
    let url = tauri::Url::parse(
        "http://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.preview.localhost:9999/path",
    )
    .unwrap();
    assert_eq!(
        presentation_title(&url, Some("https://app.example/path?q=secret")),
        "https://app.example"
    );
}
