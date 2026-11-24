pub fn build(directory: &std::path::Path) {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os != "macos" && os != "linux" {
        return;
    }
    let source = directory.join(format!(
        "input_{os}.{}",
        if os == "macos" { "m" } else { "c" }
    ));
    println!("cargo:rerun-if-changed={}", source.display());
    println!(
        "cargo:rerun-if-changed={}",
        directory.join("input.h").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        directory.join("page_read.generated.h").display()
    );
    let mut build = cc::Build::new();
    build.file(source);
    let mobile = directory.join(format!(
        "mobile_{os}.{}",
        if os == "macos" { "m" } else { "c" }
    ));
    println!("cargo:rerun-if-changed={}", mobile.display());
    build.file(mobile);
    let zoom = directory.join(format!(
        "zoom_{os}.{}",
        if os == "macos" { "m" } else { "c" }
    ));
    println!("cargo:rerun-if-changed={}", zoom.display());
    println!(
        "cargo:rerun-if-changed={}",
        directory.join("zoom.h").display()
    );
    build.file(zoom);
    if std::env::var_os("CARGO_FEATURE_BROWSER_PARENT_QUALIFICATION").is_some() {
        let trial = directory.join(format!(
            "../../../tests/browser-parent/mobile-trial-{os}.{}",
            if os == "macos" { "m" } else { "c" }
        ));
        println!("cargo:rerun-if-changed={}", trial.display());
        build.file(trial);
    }
    if os == "macos" {
        let navigation = directory.join("input_navigation_macos.m");
        println!("cargo:rerun-if-changed={}", navigation.display());
        build
            .file(navigation)
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .flag("-mmacosx-version-min=14.0");
        for framework in ["AppKit", "WebKit", "ApplicationServices"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    } else {
        let webkit = pkg_config::Config::new()
            .atleast_version("2.40")
            .probe("webkit2gtk-4.1")
            .expect("WebKitGTK 4.1 development files");
        build.includes(webkit.include_paths);
    }
    build.compile("codenomad_webkit_input");
}
