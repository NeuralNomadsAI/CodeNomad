fn main() {
    let rune = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.prototype-deps/rune");
    let head = std::process::Command::new("git")
        .arg("-C")
        .arg(&rune)
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("git is required to verify the Rune pin");
    assert!(
        head.status.success(),
        "Run setup.ps1 to install the pinned Rune source"
    );
    assert_eq!(
        String::from_utf8(head.stdout).unwrap().trim(),
        "21e5342b9a4cc33eeee88071b4b1f0eafb1247d4",
        "Unexpected Rune source revision"
    );
    println!(
        "cargo:rerun-if-changed={}",
        rune.join(".git/HEAD").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        rune.join(".git/refs/heads/dev").display()
    );
}
