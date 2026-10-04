#[cfg(windows)]
fn main() {
    let result = std::env::args()
        .nth(1)
        .ok_or(codenomad_native_host_lifetime::Error(
            "fixture-role-required",
        ))
        .and_then(|role| codenomad_native_host_lifetime::fixture::run(&role));
    if let Err(error) = result {
        // Static codes only: no child output, native error, path, env or challenge.
        eprintln!("{}", error.0);
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    std::process::exit(1);
}
