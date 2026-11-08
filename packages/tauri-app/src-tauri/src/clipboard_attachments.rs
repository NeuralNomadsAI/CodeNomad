use serde::Serialize;

#[derive(Debug, Serialize)]
pub(crate) struct ClipboardFile {
    name: String,
    size: u64,
    mime: String,
    data: Option<String>,
}

#[tauri::command]
pub(crate) async fn read_clipboard_attachments(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ClipboardFile>, String> {
    crate::require_local_app_webview(&webview, &state)?;
    #[cfg(target_os = "linux")]
    {
        linux::read(&app).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        // WebView2 and WKWebView supply the browser File paste path.
        let _ = app;
        Ok(Vec::new())
    }
}

#[cfg(any(target_os = "linux", test))]
mod files {
    use super::ClipboardFile;
    use base64::Engine;
    use std::io::Read;

    // Match PROMPT_INLINE_FILE_LIMITS; the composer also applies its live draft
    // budget to these bytes together with picker/drop/browser-paste batches.
    pub(super) const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
    const MAX_FILES: usize = 10;

    pub(super) fn image(data: Vec<u8>) -> ClipboardFile {
        ClipboardFile {
            name: "image.png".into(),
            size: data.len() as u64,
            mime: "image/png".into(),
            data: (data.len() as u64 <= MAX_FILE_BYTES)
                .then(|| base64::engine::general_purpose::STANDARD.encode(data)),
        }
    }

    pub(super) fn read_uris(uris: Vec<String>) -> Vec<ClipboardFile> {
        let mut seen = std::collections::HashSet::new();
        let mut count = 0;
        let mut bytes = 0;
        uris.into_iter()
            .filter_map(|uri| {
                let url = url::Url::parse(uri.trim()).ok()?;
                if url.query().is_some()
                    || url.fragment().is_some()
                    || url
                        .host_str()
                        .is_some_and(|host| host != "localhost" && !host.is_empty())
                {
                    return None;
                }
                let path = url.to_file_path().ok()?;
                if !seen.insert(path.clone()) {
                    return None;
                }
                let name = path.file_name()?.to_string_lossy().into_owned();
                let mut entry = ClipboardFile {
                    name,
                    size: 0,
                    mime: String::new(),
                    data: None,
                };
                let mut read = || -> std::io::Result<Vec<u8>> {
                    let mut options = std::fs::OpenOptions::new();
                    options.read(true);
                    // A copied special file (or a symlink changed to one) must never
                    // block a worker while opening a FIFO/device.
                    #[cfg(target_os = "linux")]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.custom_flags(libc::O_NONBLOCK);
                    }
                    let file = options.open(&path)?;
                    let metadata = file.metadata()?;
                    entry.size = metadata.len();
                    if !metadata.is_file()
                        || entry.size > MAX_FILE_BYTES
                        || count >= MAX_FILES
                        || bytes + entry.size > MAX_TOTAL_BYTES
                    {
                        return Err(std::io::Error::other(
                            "Clipboard file is outside the attachment budget",
                        ));
                    }
                    let mut data = Vec::new();
                    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut data)?;
                    entry.size = data.len() as u64;
                    if entry.size > MAX_FILE_BYTES || bytes + entry.size > MAX_TOTAL_BYTES {
                        return Err(std::io::Error::other(
                            "Clipboard file grew outside the attachment budget",
                        ));
                    }
                    Ok(data)
                };
                if let Ok(data) = read() {
                    count += 1;
                    bytes += entry.size;
                    entry.data = Some(base64::engine::general_purpose::STANDARD.encode(data));
                }
                Some(entry)
            })
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn clipboard_uris_are_local_files_with_bounded_bytes() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("outside project café.txt");
            std::fs::write(&path, "clipboard bytes").unwrap();
            let uri = url::Url::from_file_path(&path).unwrap().to_string();
            let large = dir.path().join("large.bin");
            std::fs::File::create(&large)
                .unwrap()
                .set_len(MAX_FILE_BYTES + 1)
                .unwrap();
            let files = read_uris(vec![
                "https://example.com/file".into(),
                "file://other-host/private.txt".into(),
                format!("{uri}#fragment"),
                uri.clone(),
                uri,
                url::Url::from_file_path(&large).unwrap().into(),
                url::Url::from_file_path(dir.path().join("missing.txt"))
                    .unwrap()
                    .into(),
            ]);
            assert_eq!(files.len(), 3);
            assert_eq!(files[0].name, "outside project café.txt");
            assert_eq!(files[0].data.as_deref(), Some("Y2xpcGJvYXJkIGJ5dGVz"));
            assert_eq!(files[1].size, MAX_FILE_BYTES + 1);
            assert!(files[1].data.is_none());
            assert!(files[2].data.is_none());
        }

        #[test]
        fn clipboard_image_and_file_count_obey_the_device_budget() {
            assert_eq!(image(vec![1, 2, 3]).data.as_deref(), Some("AQID"));
            assert!(image(vec![0; MAX_FILE_BYTES as usize + 1]).data.is_none());
            let dir = tempfile::tempdir().unwrap();
            let uris = (0..11)
                .map(|i| {
                    let path = dir.path().join(format!("{i}.txt"));
                    std::fs::write(&path, "data").unwrap();
                    url::Url::from_file_path(path).unwrap().into()
                })
                .collect();
            let files = read_uris(uris);
            assert_eq!(files.len(), 11);
            assert_eq!(files.iter().filter(|file| file.data.is_some()).count(), 10);
        }

        #[test]
        fn clipboard_aggregate_bytes_are_bounded_and_directories_are_unreadable() {
            let dir = tempfile::tempdir().unwrap();
            let mut uris = Vec::new();
            for i in 0..5 {
                let path = dir.path().join(format!("{i}.bin"));
                std::fs::File::create(&path)
                    .unwrap()
                    .set_len(MAX_FILE_BYTES)
                    .unwrap();
                uris.push(url::Url::from_file_path(path).unwrap().into());
            }
            uris.push(url::Url::from_directory_path(dir.path()).unwrap().into());
            let files = read_uris(uris);
            assert_eq!(files.iter().filter(|file| file.data.is_some()).count(), 4);
            assert!(files[4].data.is_none());
            assert!(files[5].data.is_none());
        }

        #[test]
        fn clipboard_capability_is_primary_local_only() {
            let local: serde_json::Value =
                serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
            assert_eq!(local["webviews"], serde_json::json!(["local-*"]));
            assert!(local["permissions"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("allow-read-clipboard-attachments")));
            for content in [
                include_str!("../capabilities/preferences-window.json"),
                include_str!("../capabilities/remote-window-notifications.json"),
                include_str!("../capabilities/owned-webview-zoom.json"),
            ] {
                assert!(!content.contains("allow-read-clipboard-attachments"));
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{files, ClipboardFile};

    enum Content {
        Uris(Vec<String>),
        Image(Vec<u8>),
        Empty,
    }

    pub(super) async fn read(app: &tauri::AppHandle) -> Result<Vec<ClipboardFile>, String> {
        let (send, mut receive) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
            // Prefer file offers: a copied PNG file remains a device file. GTK
            // uses the app's display backend for both XWayland and Wayland.
            clipboard.request_uris(move |clipboard, uris| {
                if !uris.is_empty() {
                    let _ = send.try_send(Ok(Content::Uris(
                        uris.iter().map(ToString::to_string).collect(),
                    )));
                } else {
                    clipboard.request_image(move |_, image| {
                        let result = match image {
                            Some(image) => image
                                .save_to_bufferv("png", &[])
                                .map(Content::Image)
                                .map_err(|error| error.to_string()),
                            None => Ok(Content::Empty),
                        };
                        let _ = send.try_send(result);
                    });
                }
            });
        })
        .map_err(|error| error.to_string())?;
        let content = receive.recv().await.ok_or("Clipboard request closed")??;
        tauri::async_runtime::spawn_blocking(move || match content {
            Content::Uris(uris) => files::read_uris(uris),
            Content::Image(data) => vec![files::image(data)],
            Content::Empty => Vec::new(),
        })
        .await
        .map_err(|error| error.to_string())
    }
}
