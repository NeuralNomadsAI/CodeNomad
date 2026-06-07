use anyhow::anyhow;
use std::path::{Path, PathBuf};

pub fn resolve_bundled_node_binary() -> anyhow::Result<String> {
    let relative_binary = binary_relative_path();
    let platform_dir = platform_dir_name()?;

    for root in candidate_resource_roots() {
        let binary_path = root.join("node").join(&platform_dir).join(relative_binary);
        if binary_path.is_file() {
            return Ok(binary_path.to_string_lossy().into_owned());
        }
    }

    Err(anyhow!(
        "Bundled Node runtime is missing for {}. Rebuild the desktop bundle with packaged Node resources.",
        platform_dir
    ))
}

fn binary_relative_path() -> &'static Path {
    if cfg!(target_os = "windows") {
        Path::new("node.exe")
    } else {
        Path::new("bin/node")
    }
}

fn candidate_resource_roots() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources"));
            candidates.push(dir.join("../Resources"));
            candidates.push(dir.join("../Resources/resources"));

            let linux_resource_roots = [dir.join("../lib/CodeNomad"), dir.join("../lib/codenomad")];
            for root in linux_resource_roots {
                candidates.push(root.clone());
                candidates.push(root.join("resources"));
            }
        }
    }

    candidates
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
        other => Err(anyhow!(
            "Bundled Node runtime is not supported on architecture '{other}'."
        )),
    }
}
