fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH");
    if arch.as_deref() == Ok("wasm32") {
        println!("cargo::rustc-link-arg=-zstack-size=2097152");
    }
    // The AVIF decoder's x86 assembly addresses its exported tables directly, which a shared
    // library accepts only when its own symbols bind inside it.
    if arch.as_deref() == Ok("x86_64")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android")
    {
        println!("cargo::rustc-link-arg=-Wl,-Bsymbolic");
    }
}
