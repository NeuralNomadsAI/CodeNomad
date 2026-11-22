//! Blocking CLI-fixture adapter. Production state uses the shared async transport.
use crate::transport::{Command, Event};
use std::sync::mpsc::{Receiver, SyncSender};
pub fn run(out: SyncSender<Event>, input: Receiver<Command>, wake: rune::Waker) {
    let (events_out, events) = codenomad_client::bounded(64);
    let (commands, commands_in) = codenomad_client::bounded(1);
    let reader = std::thread::spawn(move || {
        while let Ok(command) = input.recv() {
            if commands.send_blocking(command).is_err() {
                break;
            }
        }
    });
    let writer = std::thread::spawn(move || {
        while let Ok(event) = events.recv_blocking() {
            if out.send(event).is_err() {
                break;
            }
        }
    });
    crate::platform::block_on(crate::transport::run_async(events_out, commands_in, wake));
    // Fixture owners close their command sender when finished. Detached readers own no UI.
    drop(reader);
    drop(writer);
}
