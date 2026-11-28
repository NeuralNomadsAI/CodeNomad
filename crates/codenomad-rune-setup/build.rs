//! Embeds the application (`CODENOMAD_RUNE_SETUP_PAYLOAD`: a zip of its install folder) and, on
//! Windows, the setup's icon, version and manifest. Without a payload the setup builds, and says
//! it has nothing to install.

fn main() {
    for name in ["CODENOMAD_RUNE_SETUP_PAYLOAD", "CODENOMAD_RUNE_VERSION"] {
        println!("cargo::rerun-if-env-changed={name}");
    }
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let out = std::path::PathBuf::from(env("OUT_DIR").unwrap()).join("payload.zip");
    let bytes = match env("CODENOMAD_RUNE_SETUP_PAYLOAD") {
        Some(path) => {
            println!("cargo::rerun-if-changed={path}");
            std::fs::read(&path)
                .unwrap_or_else(|e| panic!("CODENOMAD_RUNE_SETUP_PAYLOAD {path}: {e}"))
        }
        None => Vec::new(),
    };
    if std::fs::read(&out).ok().as_deref() != Some(bytes.as_slice()) {
        std::fs::write(&out, &bytes).unwrap_or_else(|e| panic!("{}: {e}", out.display()));
    }
    #[cfg(windows)]
    if env("CARGO_CFG_TARGET_OS").as_deref() == Some("windows") {
        let version =
            env("CODENOMAD_RUNE_VERSION").unwrap_or_else(|| env("CARGO_PKG_VERSION").unwrap());
        let dir = std::path::PathBuf::from(env("CARGO_MANIFEST_DIR").unwrap());
        let icon = dir.join("../../packages/tauri-app/src-tauri/icon.ico");
        let manifest = dir.join("setup.manifest");
        println!("cargo::rerun-if-changed={}", icon.display());
        println!("cargo::rerun-if-changed={}", manifest.display());
        let mut res = winresource::WindowsResource::new();
        res.set_icon(&icon.to_string_lossy())
            .set_manifest_file(&manifest.to_string_lossy())
            .set("FileDescription", "CodeNomad Setup")
            .set("ProductName", "CodeNomad")
            .set("CompanyName", "neuralnomads")
            .set("OriginalFilename", "codenomad-rune-setup.exe")
            .set("FileVersion", &version)
            .set("ProductVersion", &version);
        res.compile()
            .unwrap_or_else(|e| panic!("windows resources: {e}"));
    }
}
