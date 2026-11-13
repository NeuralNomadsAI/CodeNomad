use super::*;
use std::io::{BufReader, Cursor};
use std::sync::{mpsc, Arc, Mutex};

#[test]
fn fragmented_partial_and_oversized_lines_reach_eof() {
    let reader = BufReader::with_capacity(1, Cursor::new("é\n123456789\nlast"));
    let mut lines = Vec::new();
    pump(reader, 8, |line| lines.push(line.map(str::to_owned))).unwrap();
    assert_eq!(lines, [Some("é".into()), None, Some("last".into())]);
    let mut lines = Vec::new();
    pump(Cursor::new("123456789"), 8, |line| {
        lines.push(line.map(str::to_owned))
    })
    .unwrap();
    assert_eq!(lines, [None]);
}

#[test]
fn protocol_is_classified_before_diagnostics_even_after_revocation() {
    let mut diagnostics = Vec::new();
    pump(Cursor::new("CODENOMAD_BOOTSTRAP_TOKEN:secret\nREQUEST:secret\nCODENOMAD_SHUTDOWN_STATUS:incomplete\n"), 1024, |line| {
        if let Some(line) = line {
            if let OutputLine::Diagnostic(line) = classify(line, "REQUEST:") {
                diagnostics.push(line.to_owned());
            }
        }
    }).unwrap();
    assert_eq!(diagnostics, ["CODENOMAD_SHUTDOWN_STATUS:incomplete"]);
}

#[test]
fn two_receipts_wait_in_either_order_and_retry_without_replaying() {
    for first in [0, 1] {
        let (tx0, rx0) = mpsc::channel();
        let (tx1, rx1) = mpsc::channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let readers = [rx0, rx1]
            .into_iter()
            .enumerate()
            .map(|(index, rx)| {
                let events = events.clone();
                (
                    if index == 0 { "stdout" } else { "stderr" },
                    ReaderReceipt::spawn(move || {
                        rx.recv().unwrap();
                        pump(Cursor::new("terminal\n"), 1024, |line| {
                            events.lock().unwrap().push(line.unwrap().to_owned());
                        })
                    }),
                )
            })
            .collect();
        let mut drain = OutputDrain::new(readers);
        let senders = [tx0, tx1];
        senders[first].send(()).unwrap();
        assert!(drain
            .wait_until(Instant::now() + Duration::from_millis(30))
            .is_err());
        assert_eq!(events.lock().unwrap().len(), 1);
        senders[1 - first].send(()).unwrap();
        drain
            .wait_until(Instant::now() + Duration::from_secs(2))
            .unwrap();
        assert_eq!(events.lock().unwrap().len(), 2);
        drain.wait_until(Instant::now()).unwrap();
        assert_eq!(events.lock().unwrap().len(), 2);
    }
}

#[test]
fn io_error_and_panic_are_retained_failures() {
    for panic in [false, true] {
        let mut drain = OutputDrain::new(vec![
            (
                "stdout",
                ReaderReceipt::spawn(move || {
                    if panic {
                        panic!("private reader failed");
                    }
                    pump(BufReader::new(FailingRead), 1024, |_| {})
                }),
            ),
            ("stderr", ReaderReceipt::spawn(|| Ok(()))),
        ]);
        let error = drain
            .wait_until(Instant::now() + Duration::from_secs(2))
            .unwrap_err();
        assert!(
            error.contains(if panic { "panicked" } else { "read failed" }),
            "{error}"
        );
        assert_eq!(drain.wait_until(Instant::now()).unwrap_err(), error);
    }
}

struct FailingRead;
impl io::Read for FailingRead {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("read failed"))
    }
}
