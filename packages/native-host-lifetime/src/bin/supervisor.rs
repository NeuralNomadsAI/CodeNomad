#[cfg(windows)]
fn main() {
    if let Err(error) = codenomad_native_host_lifetime::run_supervisor_stdio() {
        eprintln!("{}", error.0);
        std::process::exit(1);
    }
}
#[cfg(not(windows))]
fn main() {
    std::process::exit(1);
}
