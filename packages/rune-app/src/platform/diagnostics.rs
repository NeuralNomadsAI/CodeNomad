pub(crate) const RUNTIME: &str = if cfg!(target_arch = "wasm32") {
    "Web"
} else {
    "Rune"
};
pub(crate) const PLATFORM: &str = if cfg!(target_arch = "wasm32") {
    "WebAssembly"
} else {
    std::env::consts::ARCH
};

pub(crate) fn os() -> &'static str {
    #[cfg(target_arch = "wasm32")]
    if let Some(agent) = web_sys::window().and_then(|window| window.navigator().user_agent().ok()) {
        for (marker, os) in [
            ("Windows", "Windows"),
            ("Android", "Android"),
            ("iPhone", "iOS"),
            ("iPad", "iPadOS"),
            ("Mac OS", "macOS"),
            ("CrOS", "ChromeOS"),
            ("Linux", "Linux"),
        ] {
            if agent.contains(marker) {
                return os;
            }
        }
    }
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        _ => "—",
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn copy(text: &str, done: impl FnOnce(bool) + 'static) {
    use wasm_bindgen::JsCast;
    let pending = web_sys::window().and_then(|window| {
        js_sys::Reflect::get(window.navigator().as_ref(), &"clipboard".into())
            .ok()?
            .dyn_into::<web_sys::Clipboard>()
            .ok()
            .map(|clipboard| clipboard.write_text(text))
    });
    super::spawn(async move {
        done(match pending {
            Some(promise) => wasm_bindgen_futures::JsFuture::from(promise).await.is_ok(),
            None => false,
        });
    });
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn save(path: std::path::PathBuf, text: String) -> bool {
    tokio::task::spawn_blocking(move || std::fs::write(path, text))
        .await
        .is_ok_and(|result| result.is_ok())
}
