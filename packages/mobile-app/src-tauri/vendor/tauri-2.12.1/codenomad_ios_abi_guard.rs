// CodeNomad local integration guard; upstream Tauri is MIT OR Apache-2.0.
// Runs before the upstream iOS Swift library linker, including direct Cargo builds.
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};

pub fn verify() {
  let root = env::var("CARGO_MANIFEST_DIR").expect("Tauri manifest directory");
  let version = env::var("CARGO_PKG_VERSION").expect("Tauri version");
  verify_at(Path::new(&root), &version);
}

pub fn verify_at(root: &Path, version: &str) {
  assert_eq!(version, "2.12.1", "CodeNomad iOS ABI patch version drift");
  for line in include_str!("codenomad-ios-abi.sha256").lines() {
    let (expected, relative) = line.split_once("  ").expect("ABI hash receipt");
    let path = root.join(relative);
    println!("cargo:rerun-if-changed={}", path.display());
    let bytes = fs::read(&path).expect("CodeNomad iOS ABI input missing");
    let actual = format!("{:x}", Sha256::digest(&bytes));
    assert_eq!(actual, expected, "CodeNomad iOS ABI input drift: {relative}");
  }
  println!("cargo:rerun-if-changed=codenomad_ios_abi_guard.rs");
  println!("cargo:rerun-if-changed=codenomad-ios-abi.sha256");
}
