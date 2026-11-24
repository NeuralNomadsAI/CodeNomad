//! Host-only actions. The backend supplies checkout ownership, not a launch command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Default,
    Reveal,
    Terminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefaultMode {
    Open,
    Edit,
    Choose,
}

pub const AVAILABLE: bool = cfg!(windows);

pub fn copy_path(
    path: &str,
    out: codenomad_client::Sender<(crate::shell::notifications::Category, bool, String)>,
    wake: codenomad_client::Wake,
    tx: &mut rune::Tx,
) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        tx.copy(path);
        let path = path.to_owned();
        let locale = crate::strings::locale();
        tx.read_clipboard(move |_: &mut crate::State, content, _| {
            let copied = content.text() == path;
            let _ = out.try_send(copy_feedback(locale, copied));
            wake();
        });
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = tx;
        web::copy_path(path, out, wake);
    }
}

fn copy_feedback(
    locale: &str,
    copied: bool,
) -> (crate::shell::notifications::Category, bool, String) {
    let key = if copied {
        "instanceShell.filesShell.toast.copyPathSuccess"
    } else {
        "instanceShell.filesShell.toast.copyPathError"
    };
    (
        crate::shell::notifications::Category::Copy,
        copied,
        rune_theme_codenomad::catalogue::format(locale, key, &[]),
    )
}

#[cfg(target_arch = "wasm32")]
mod web;

pub fn windows_default_mode(path: &str) -> DefaultMode {
    let extension = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .rsplit_once('.')
        .filter(|(name, _)| !name.is_empty())
        .map_or(String::new(), |(_, ext)| ext.to_ascii_lowercase());
    match extension.as_str() {
        "7z" | "avi" | "bmp" | "c" | "cc" | "cfg" | "conf" | "cpp" | "cs" | "css" | "csv"
        | "dart" | "diff" | "docx" | "env" | "flac" | "fs" | "fsx" | "gif" | "go" | "gz" | "h"
        | "hpp" | "htm" | "html" | "ini" | "java" | "jpeg" | "jpg" | "json" | "jsonc" | "jsx"
        | "kt" | "kts" | "less" | "lock" | "log" | "lua" | "md" | "markdown" | "mkv" | "mov"
        | "mp3" | "mp4" | "ogg" | "patch" | "pdf" | "png" | "pptx" | "r" | "rar" | "rmd" | "rs"
        | "scss" | "sql" | "svg" | "svelte" | "swift" | "tar" | "toml" | "ts" | "tsx" | "txt"
        | "vue" | "wav" | "webm" | "webp" | "xlsx" | "xml" | "yaml" | "yml" | "zip" => {
            DefaultMode::Open
        }
        "bat" | "cmd" | "js" | "jse" | "pl" | "ps1" | "psd1" | "psm1" | "py" | "pyw" | "rb"
        | "reg" | "vbe" | "vbs" | "wsf" | "wsh" => DefaultMode::Edit,
        _ => DefaultMode::Choose,
    }
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::open;

#[cfg(not(windows))]
pub async fn open(
    _: crate::backend::Backend,
    _: String,
    _: String,
    _: String,
    _: Target,
    _: std::sync::Weak<()>,
) -> Result<(), String> {
    Err("Native workspace actions are unavailable".into())
}
