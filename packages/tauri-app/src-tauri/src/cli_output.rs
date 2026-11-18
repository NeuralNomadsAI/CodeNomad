//! Passive pipe ownership lasts until EOF, independently of UI generation authority.
use std::io::{self, BufRead};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "cli_output_tests.rs"]
mod tests;

#[derive(Debug)]
pub(super) struct ReaderReceipt {
    handle: Option<JoinHandle<io::Result<()>>>,
    result: Option<Result<(), String>>,
}

impl ReaderReceipt {
    pub(super) fn spawn(read: impl FnOnce() -> io::Result<()> + Send + 'static) -> Self {
        Self {
            handle: Some(thread::spawn(read)),
            result: None,
        }
    }

    fn poll(&mut self) -> Option<&Result<(), String>> {
        if self.result.is_none() && self.handle.as_ref().is_some_and(JoinHandle::is_finished) {
            self.result = Some(match self.handle.take().unwrap().join() {
                Ok(result) => result.map_err(|error| error.to_string()),
                Err(_) => Err("output reader panicked".to_string()),
            });
        }
        self.result.as_ref()
    }
}

#[derive(Debug)]
pub(super) struct OutputDrain {
    pub(super) contained: bool,
    readers: Vec<(&'static str, ReaderReceipt)>,
}

impl OutputDrain {
    pub(super) fn new(readers: Vec<(&'static str, ReaderReceipt)>) -> Self {
        Self {
            contained: false,
            readers,
        }
    }

    pub(super) fn wait_until(&mut self, deadline: Instant) -> Result<(), String> {
        if self.readers.len() != 2 {
            return Err("CLI output drain requires stdout and stderr readers".to_string());
        }
        loop {
            let mut pending = false;
            for (stream, reader) in &mut self.readers {
                match reader.poll() {
                    Some(Ok(())) => {}
                    Some(Err(error)) => return Err(format!("CLI {stream} drain failed: {error}")),
                    None => pending = true,
                }
            }
            if !pending {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("CLI output drain deadline elapsed".to_string());
            }
            thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }
}

pub(super) enum OutputLine<'a> {
    Request(&'a str),
    Token(&'a str),
    Diagnostic(&'a str),
}

pub(super) fn classify<'a>(line: &'a str, request_prefix: &str) -> OutputLine<'a> {
    if line.starts_with(request_prefix) {
        OutputLine::Request(line)
    } else if let Some(token) = line.strip_prefix("CODENOMAD_BOOTSTRAP_TOKEN:") {
        OutputLine::Token(token.trim())
    } else {
        OutputLine::Diagnostic(line)
    }
}

pub(super) fn pump(
    mut reader: impl BufRead,
    limit: usize,
    mut line: impl FnMut(Option<&str>),
) -> io::Result<()> {
    let mut buffer = String::new();
    loop {
        match read_bounded_line(&mut reader, &mut buffer, limit)? {
            0 => return Ok(()),
            size if size > limit => line(None),
            _ => line(Some(buffer.trim_end())),
        }
    }
}

pub(super) fn read_bounded_line(
    reader: &mut impl BufRead,
    buffer: &mut String,
    limit: usize,
) -> io::Result<usize> {
    buffer.clear();
    let mut total = 0usize;
    let mut oversized = false;
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            if !oversized {
                *buffer = String::from_utf8_lossy(&bytes).into_owned();
            }
            return Ok(if oversized { limit + 1 } else { total });
        }
        let length = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        let ended = available.get(length - 1) == Some(&b'\n');
        total = total.saturating_add(length);
        if !oversized && bytes.len() + length <= limit {
            bytes.extend_from_slice(&available[..length]);
        } else {
            oversized = true;
            bytes.clear();
        }
        reader.consume(length);
        if ended {
            if !oversized {
                *buffer = String::from_utf8_lossy(&bytes).into_owned();
            }
            return Ok(if oversized { limit + 1 } else { total });
        }
    }
}
