//! Platform boundary for task execution, connection defaults and local file picking.
pub(crate) mod collation;
mod connection;
#[cfg(target_arch = "wasm32")]
pub(crate) mod pairing;
pub(crate) mod reads;
pub(crate) mod storage;
pub(crate) mod titlebar;
pub(crate) use connection::configured_backend;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod host;
use std::{future::Future, time::Duration};
#[cfg(not(target_arch = "wasm32"))]
mod boot;
#[cfg(not(target_arch = "wasm32"))]
pub use boot::LocalHost;
#[cfg(target_arch = "wasm32")]
#[derive(Debug)]
pub struct LocalHost;
pub fn local_server_available() -> bool {
    cfg!(not(target_arch = "wasm32"))
}
/// Called after Rune releases the event loop; process waits remain outside active UI work.
pub fn finish() {
    #[cfg(not(target_arch = "wasm32"))]
    boot::finish();
}
pub fn release_records_on_exit(
    records: Vec<(crate::backend::Backend, String)>,
    openings: crate::workspace::opening::Openings,
) {
    #[cfg(not(target_arch = "wasm32"))]
    block_on(async move {
        openings.allow_cleanup();
        let mut jobs = tokio::task::JoinSet::new();
        for (backend, id) in records {
            jobs.spawn(async move {
                let _ = backend.release_project(&id).await;
            });
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            while jobs.join_next().await.is_some() {}
            while !openings.settled() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
    });
    #[cfg(target_arch = "wasm32")]
    let _ = (records, openings);
}
pub fn start_local(
    wake: rune::Waker,
) -> Option<codenomad_client::Receiver<crate::history::Result<(crate::backend::Backend, LocalHost)>>>
{
    #[cfg(not(target_arch = "wasm32"))]
    {
        boot::start(wake)
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = wake;
        None
    }
}
#[cfg(not(target_arch = "wasm32"))]
pub trait TaskBound: Send {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send> TaskBound for T {}
#[cfg(target_arch = "wasm32")]
pub trait TaskBound {}
#[cfg(target_arch = "wasm32")]
impl<T> TaskBound for T {}

#[cfg(not(target_arch = "wasm32"))]
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("application executor")
    })
}
#[cfg(not(target_arch = "wasm32"))]
pub fn spawn(task: impl Future<Output = ()> + Send + 'static) {
    runtime().spawn(task);
}
#[cfg(target_arch = "wasm32")]
pub fn spawn(task: impl Future<Output = ()> + 'static) {
    wasm_bindgen_futures::spawn_local(task);
}
#[cfg(not(target_arch = "wasm32"))]
pub fn block_on<T>(task: impl Future<Output = T>) -> T {
    runtime().block_on(task)
}
pub async fn sleep(duration: Duration) {
    codenomad_client::runtime::sleep(duration).await;
}

#[cfg(not(target_arch = "wasm32"))]
pub fn setting(key: &str) -> Option<String> {
    std::env::var(key).ok()
}
#[cfg(target_arch = "wasm32")]
pub fn setting(_: &str) -> Option<String> {
    None
}
pub fn locale() -> String {
    #[cfg(not(target_arch = "wasm32"))]
    {
        setting("RUNE_LOCALE").unwrap_or_else(|| "fr".into())
    }
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .and_then(|w| w.location().search().ok())
            .and_then(|query| web_sys::UrlSearchParams::new_with_str(&query).ok())
            .and_then(|query| query.get("locale"))
            .unwrap_or_else(|| "fr".into())
    }
}
pub fn default_backend() -> String {
    if let Some(base) = setting("RUNE_BACKEND") {
        return base;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        "http://127.0.0.1:3000/".into()
    }
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .and_then(|window| web_sys::Location::origin(&window.location()).ok())
            .map(|origin| format!("{origin}/"))
            .unwrap_or_default()
    }
}
pub fn has_flag(flag: &str) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::args().any(|arg| arg == flag)
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = flag;
        false
    }
}
#[cfg(feature = "test-support")]
pub fn synthetic_scene() -> bool {
    scene_is("synthetic")
}
#[cfg(feature = "test-support")]
pub fn scene_is(name: &str) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::args()
            .skip_while(|arg| arg != "--scene")
            .nth(1)
            .as_deref()
            == Some(name)
    }
    #[cfg(target_arch = "wasm32")]
    {
        web_sys::window()
            .and_then(|w| w.location().search().ok())
            .and_then(|query| web_sys::UrlSearchParams::new_with_str(&query).ok())
            .and_then(|query| query.get("scene"))
            .as_deref()
            == Some(name)
    }
}
pub fn folder_picker_available() -> bool {
    cfg!(not(target_arch = "wasm32"))
}
pub fn browse(s: &mut crate::State, tx: &mut rune::Tx) {
    let scope = s.input_scope.clone();
    #[cfg(not(target_arch = "wasm32"))]
    tx.open_folder(
        rune::file_dialog::FileDialogOptions {
            title: crate::strings::t("instanceInfo.labels.folder").into(),
            ..Default::default()
        },
        move |s: &mut crate::State, result, tx| {
            if !s.current_scope(&scope) {
                return;
            }
            let Some(l) = s.screen.launcher_mut() else {
                return;
            };
            match result {
                Ok(Some(path)) => {
                    l.folder = rune::edit::TextEdit::new(path.to_string_lossy());
                    crate::launcher::open(s, tx);
                }
                Ok(None) => {}
                Err(_) => l.error = Some("rune.open_error"),
            }
        },
    );
    #[cfg(target_arch = "wasm32")]
    {
        let _ = tx;
        if let Some(launcher) = s.screen.launcher_mut() {
            launcher.error = Some("rune.open_error");
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = s;
}
