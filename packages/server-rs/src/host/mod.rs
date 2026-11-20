//! The desktop host contract: native requests over stdout/stdin and the stdin commands.
//! Minimal stand-in for the `host-cli` module of the same name (same functions, kept on merge).
pub mod native_parent;

use std::io::{self, BufRead};

use tokio_util::sync::CancellationToken;

pub const SHUTDOWN_COMMAND: &str = "codenomad:shutdown";

/// `installShutdownStdinHandler`: whole lines only; `codenomad:shutdown` stops once, other lines
/// may be native responses. End of input changes nothing.
pub fn read_stdin(stop: CancellationToken) {
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match input.read_until(b'\n', &mut buffer) {
                Ok(_) if buffer.last() == Some(&b'\n') => {}
                _ => return,
            }
            let text = String::from_utf8_lossy(&buffer);
            let text = text.trim_end_matches('\n').trim_end_matches('\r');
            if text.trim() == SHUTDOWN_COMMAND {
                stop.cancel();
            } else {
                native_parent::handle_line(text);
            }
        }
    });
}
