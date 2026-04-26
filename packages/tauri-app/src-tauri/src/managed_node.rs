use anyhow::anyhow;
use dirs::home_dir;
use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tar::Archive;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use zip::ZipArchive;

const MANAGED_NODE_VERSION: &str = "v22.22.2";

struct NodeArtifactSpec {
    archive_name: &'static str,
    archive_root: &'static str,
    binary_relative_path: &'static str,
}

pub fn ensure_managed_node_binary<R: Runtime>(app: &AppHandle<R>) -> anyhow::Result<String> {
    let runtime_root = managed_node_root()?;
    let spec = artifact_spec()?;
    let binary_path = runtime_root.join(spec.binary_relative_path);
    if binary_path.is_file() {
        return Ok(binary_path.to_string_lossy().into_owned());
    }

    if !prompt_to_download(app) {
        return Err(anyhow!(
            "CodeNomad requires the managed Node.js runtime to start. Download was cancelled."
        ));
    }

    install_managed_node_runtime(&runtime_root, &spec)?;

    if !binary_path.is_file() {
        return Err(anyhow!(
            "Managed Node binary missing after installation: {}",
            binary_path.display()
        ));
    }

    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&binary_path)?.permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary_path, permissions)?;
    }

    Ok(binary_path.to_string_lossy().into_owned())
}

fn prompt_to_download<R: Runtime>(app: &AppHandle<R>) -> bool {
    let app = app.clone();
    thread::spawn(move || {
        app.dialog()
            .message(format!(
                "CodeNomad needs its managed Node.js runtime to start the server. Download {} for {}-{} into ~/.config/codenomad?",
                MANAGED_NODE_VERSION,
                platform_label(),
                rust_arch_label().unwrap_or("unknown")
            ))
            .title("Download Node Runtime")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Download".into(),
                "Cancel".into(),
            ))
            .kind(MessageDialogKind::Info)
            .blocking_show()
    })
    .join()
    .unwrap_or(false)
}

fn managed_node_root() -> anyhow::Result<PathBuf> {
    Ok(config_dir()?.join("node").join(MANAGED_NODE_VERSION).join(platform_dir_name()?))
}

fn config_dir() -> anyhow::Result<PathBuf> {
    let home = home_dir().ok_or_else(|| anyhow!("Unable to resolve the user home directory."))?;
    Ok(home.join(".config").join("codenomad"))
}

fn platform_dir_name() -> anyhow::Result<String> {
    Ok(format!("{}-{}", platform_label(), rust_arch_label()?))
}

fn platform_label() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn rust_arch_label() -> anyhow::Result<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        other => Err(anyhow!("Managed Node runtime is not supported on architecture '{other}'.")),
    }
}

fn artifact_spec() -> anyhow::Result<NodeArtifactSpec> {
    let arch = rust_arch_label()?;
    match (std::env::consts::OS, arch) {
        ("macos", "x64") => Ok(NodeArtifactSpec {
            archive_name: "node-v22.22.2-darwin-x64.tar.gz",
            archive_root: "node-v22.22.2-darwin-x64",
            binary_relative_path: "bin/node",
        }),
        ("macos", "arm64") => Ok(NodeArtifactSpec {
            archive_name: "node-v22.22.2-darwin-arm64.tar.gz",
            archive_root: "node-v22.22.2-darwin-arm64",
            binary_relative_path: "bin/node",
        }),
        ("linux", "x64") => Ok(NodeArtifactSpec {
            archive_name: "node-v22.22.2-linux-x64.tar.gz",
            archive_root: "node-v22.22.2-linux-x64",
            binary_relative_path: "bin/node",
        }),
        ("linux", "arm64") => Ok(NodeArtifactSpec {
            archive_name: "node-v22.22.2-linux-arm64.tar.gz",
            archive_root: "node-v22.22.2-linux-arm64",
            binary_relative_path: "bin/node",
        }),
        ("windows", "x64") => Ok(NodeArtifactSpec {
            archive_name: "node-v22.22.2-win-x64.zip",
            archive_root: "node-v22.22.2-win-x64",
            binary_relative_path: "node.exe",
        }),
        ("windows", "arm64") => Ok(NodeArtifactSpec {
            archive_name: "node-v22.22.2-win-arm64.zip",
            archive_root: "node-v22.22.2-win-arm64",
            binary_relative_path: "node.exe",
        }),
        (os, arch) => Err(anyhow!("Managed Node runtime is not supported on {os}-{arch}.")),
    }
}

fn install_managed_node_runtime(runtime_root: &Path, spec: &NodeArtifactSpec) -> anyhow::Result<()> {
    let runtime_parent = runtime_root
        .parent()
        .ok_or_else(|| anyhow!("Managed Node runtime path is invalid."))?;
    fs::create_dir_all(runtime_parent)?;

    let temp_root = runtime_parent.join(format!(
        ".download-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    ));

    if temp_root.exists() {
        fs::remove_dir_all(&temp_root).ok();
    }
    fs::create_dir_all(&temp_root)?;

    let archive_path = temp_root.join(spec.archive_name);
    let extract_root = temp_root.join("extract");
    fs::create_dir_all(&extract_root)?;

    let result = (|| {
        let expected_sha = fetch_expected_sha(spec.archive_name)?;
        download_file(spec.archive_name, &archive_path)?;

        let actual_sha = sha256_file(&archive_path)?;
        if actual_sha != expected_sha {
            return Err(anyhow!("Checksum mismatch for {}.", spec.archive_name));
        }

        extract_archive(&archive_path, &extract_root)?;

        let extracted_root = extract_root.join(spec.archive_root);
        let extracted_binary = extracted_root.join(spec.binary_relative_path);
        if !extracted_binary.is_file() {
            return Err(anyhow!(
                "Managed Node binary missing after extraction: {}",
                extracted_binary.display()
            ));
        }

        if runtime_root.exists() {
            fs::remove_dir_all(runtime_root)?;
        }
        fs::rename(&extracted_root, runtime_root)?;
        Ok(())
    })();

    fs::remove_dir_all(&temp_root).ok();
    result
}

fn fetch_expected_sha(archive_name: &str) -> anyhow::Result<String> {
    let url = format!("https://nodejs.org/dist/{MANAGED_NODE_VERSION}/SHASUMS256.txt");
    let response = Client::builder()
        .build()?
        .get(url)
        .send()?
        .error_for_status()?;
    let body = response.text()?;

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let checksum = parts.next();
        let file_name = parts.next();
        if let (Some(checksum), Some(file_name)) = (checksum, file_name) {
            if file_name == archive_name {
                return Ok(checksum.to_string());
            }
        }
    }

    Err(anyhow!("Unable to find checksum for {archive_name}."))
}

fn download_file(archive_name: &str, destination: &Path) -> anyhow::Result<()> {
    let url = format!("https://nodejs.org/dist/{MANAGED_NODE_VERSION}/{archive_name}");
    let mut response = Client::builder()
        .build()?
        .get(url)
        .send()?
        .error_for_status()?;
    let mut output = File::create(destination)?;
    io::copy(&mut response, &mut output)?;
    Ok(())
}

fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];

    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_archive(archive_path: &Path, destination: &Path) -> anyhow::Result<()> {
    if archive_path.extension().and_then(|value| value.to_str()) == Some("zip") {
        extract_zip(archive_path, destination)
    } else {
        extract_tar_gz(archive_path, destination)
    }
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> anyhow::Result<()> {
    let file = File::open(archive_path)?;
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    archive.unpack(destination)?;
    Ok(())
}

fn extract_zip(archive_path: &Path, destination: &Path) -> anyhow::Result<()> {
    let file = File::open(archive_path)?;
    let mut archive = ZipArchive::new(file)?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative_path = entry
            .enclosed_name()
            .map(|path| path.to_path_buf())
            .ok_or_else(|| anyhow!("Zip archive contains an invalid path."))?;
        let output_path = destination.join(relative_path);

        if entry.is_dir() {
            fs::create_dir_all(&output_path)?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut output = File::create(&output_path)?;
        io::copy(&mut entry, &mut output)?;
    }

    Ok(())
}
