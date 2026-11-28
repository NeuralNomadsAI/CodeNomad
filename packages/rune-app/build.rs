fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH");
    if arch.as_deref() == Ok("wasm32") {
        println!("cargo::rustc-link-arg=-zstack-size=2097152");
    }
}
