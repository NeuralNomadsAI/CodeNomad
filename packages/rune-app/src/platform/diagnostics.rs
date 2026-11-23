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

pub(crate) struct Client {
    pub os: String,
    pub runtime: &'static str,
    pub platform: &'static str,
    pub context: &'static str,
    pub browser: Option<String>,
}

impl Client {
    pub fn snapshot() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        return Self {
            os: format!("{} {PLATFORM}", os()),
            runtime: RUNTIME,
            platform: "desktop",
            context: "preferences",
            browser: None,
        };
        #[cfg(target_arch = "wasm32")]
        {
            let browser = navigator()
                .and_then(|nav| nav.user_agent().ok())
                .filter(|ua| {
                    ua.len() <= 1024
                        && !ua.contains(char::is_control)
                        && !ua.contains("://")
                        && !ua.contains('\\')
                });
            let mobile = hint_source()
                .is_some_and(|data| property(&data, "mobile").as_bool() == Some(true))
                || browser.as_ref().is_some_and(|ua| {
                    let ua = ua.to_ascii_lowercase();
                    [
                        "android",
                        "iphone",
                        "ipad",
                        "ipod",
                        "blackberry",
                        "mini",
                        "mobile",
                        "silk",
                    ]
                    .iter()
                    .any(|name| ua.contains(name))
                });
            Self {
                os: browser_os(browser.as_deref().unwrap_or_default(), None),
                runtime: "Web browser",
                platform: if mobile { "mobile" } else { "desktop" },
                context: "remote",
                browser,
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn navigator() -> Option<web_sys::Navigator> {
    web_sys::window().map(|window| window.navigator())
}

#[cfg(target_arch = "wasm32")]
fn property(object: &wasm_bindgen::JsValue, key: &str) -> wasm_bindgen::JsValue {
    js_sys::Reflect::get(object, &key.into()).unwrap_or_default()
}

#[cfg(target_arch = "wasm32")]
fn hint_source() -> Option<wasm_bindgen::JsValue> {
    let data = property(navigator()?.as_ref(), "userAgentData");
    (!data.is_undefined() && !data.is_null()).then_some(data)
}

#[cfg(target_arch = "wasm32")]
pub(crate) async fn client_os_hint() -> Option<String> {
    use wasm_bindgen::JsCast;
    let source = hint_source()?;
    let load = property(&source, "getHighEntropyValues")
        .dyn_into::<js_sys::Function>()
        .ok()?;
    let fields = js_sys::Array::new();
    for field in ["platformVersion", "architecture", "bitness"] {
        fields.push(&field.into());
    }
    let promise = load
        .call1(&source, fields.as_ref())
        .ok()?
        .dyn_into::<js_sys::Promise>()
        .ok()?;
    let hints = wasm_bindgen_futures::JsFuture::from(promise).await.ok()?;
    Some(browser_os(&navigator()?.user_agent().ok()?, Some(&hints)))
}

#[cfg(target_arch = "wasm32")]
fn browser_os(ua: &str, hints: Option<&wasm_bindgen::JsValue>) -> String {
    let hint = |key| hints.and_then(|h| property(h, key).as_string());
    let platform = hint_source()
        .and_then(|data| property(&data, "platform").as_string())
        .filter(|name| {
            matches!(
                name.as_str(),
                "Windows" | "macOS" | "Linux" | "Android" | "Chrome OS" | "iOS"
            )
        });
    let platform = platform.as_deref().unwrap_or(os());
    let version = hint("platformVersion").filter(|v| {
        !v.is_empty() && v.len() <= 24 && v.bytes().all(|b| b.is_ascii_digit() || b == b'.')
    });
    let version = match (platform, version.as_deref()) {
        ("Windows", Some(v)) => match v.split('.').next().and_then(|v| v.parse::<u32>().ok()) {
            Some(13..) => Some("11"),
            Some(1..=10) => Some("10"),
            _ => None,
        },
        ("macOS", Some(v)) => Some(v.trim_end_matches(".0")),
        _ => None,
    };
    let arch = match (hint("architecture").as_deref(), hint("bitness").as_deref()) {
        (Some("x86"), Some("64")) => Some("x64"),
        (Some("x86"), _) => Some("x86"),
        (Some("arm"), Some("64")) => Some("arm64"),
        (Some("arm"), _) => Some("arm"),
        _ => [
            "x86_64", "aarch64", "arm64", "x64", "i686", "i386", "armv7l",
        ]
        .into_iter()
        .find(|arch| ua.contains(arch))
        .or_else(|| ua.contains("Win64").then_some("x64")),
    };
    [Some(platform), version, arch]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
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
