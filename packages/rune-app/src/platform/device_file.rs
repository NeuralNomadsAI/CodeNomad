use crate::composer::device::Error;
#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;
use std::{path::PathBuf, sync::Arc};

pub async fn read(path: PathBuf, limit: usize) -> Result<Arc<[u8]>, Error> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        tokio::task::spawn_blocking(move || read_bounded(&path, limit))
            .await
            .map_err(|_| Error::Unreadable)?
    }
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (path, limit);
        Err(Error::Unreadable)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn read_bounded(path: &Path, limit: usize) -> Result<Arc<[u8]>, Error> {
    use std::io::Read;
    let limit = limit.min(crate::composer::draft::MAX_FILE);
    let over = if limit == crate::composer::draft::MAX_FILE {
        Error::TooLarge
    } else {
        Error::Limit
    };
    let metadata = std::fs::metadata(path).map_err(|_| Error::Unreadable)?;
    if !metadata.is_file() {
        return Err(Error::Unreadable);
    }
    if metadata.len() > limit as u64 {
        return Err(over);
    }
    let mut file = std::fs::File::open(path).map_err(|_| Error::Unreadable)?;
    let metadata = file.metadata().map_err(|_| Error::Unreadable)?;
    if !metadata.is_file() {
        return Err(Error::Unreadable);
    }
    if metadata.len() > limit as u64 {
        return Err(over);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut block = [0u8; 16 * 1024];
    loop {
        let remaining = limit - bytes.len();
        let count = file
            .read(&mut block[..(remaining + 1).min(16 * 1024)])
            .map_err(|_| Error::Unreadable)?;
        if count > remaining {
            return Err(over);
        }
        if count == 0 {
            break;
        }
        let needed = bytes.len() + count;
        if needed > bytes.capacity() {
            bytes.reserve_exact(needed.max(bytes.capacity() * 2).min(limit) - bytes.len());
        }
        bytes.extend_from_slice(&block[..count]);
    }
    Ok(bytes.into())
}

#[cfg(not(target_arch = "wasm32"))]
pub fn mime(path: &Path) -> &'static str {
    let extension = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.rsplit_once('.').map(|(_, extension)| extension))
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "apng" => "image/apng",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "txt" | "bashrc" | "config" | "env" | "gitignore" | "log" => "text/plain",
        "c" | "h" => "text/x-c",
        "cpp" => "text/x-c++src",
        "cs" => "text/x-csharp",
        "css" => "text/css",
        "go" => "text/x-go",
        "hpp" => "text/x-c++hdr",
        "html" => "text/html",
        "java" => "text/x-java-source",
        "js" | "jsx" | "mjs" => "text/javascript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "sh" => "text/x-shellscript",
        "toml" => "text/toml",
        "ts" | "tsx" => "text/typescript",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        _ => "application/octet-stream",
    }
}
