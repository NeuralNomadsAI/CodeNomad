//! Provenance and delivery of one input sequence; cleanup may only release the original recipient.
use super::page::{Fail, Result, Session};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(super) struct Target<'a> {
    pub(super) reference: &'a str,
    pub(super) handle: &'a str,
    pub(super) drag_source: Option<&'a str>,
}

impl<'a> Target<'a> {
    pub(super) fn new(reference: &'a str, handle: &'a str) -> Self {
        Self {
            reference,
            handle,
            drag_source: None,
        }
    }
}

#[derive(Debug)]
pub(super) struct Refusal {
    pub(super) message: String,
    pub(super) same_document: bool,
    pub(super) timeout: bool,
}

pub(crate) struct Guard<'a> {
    pub(super) check: &'a dyn Fn() -> std::result::Result<(), Refusal>,
    pub(super) destination:
        &'a dyn Fn(&str, &mut Value, Option<Target<'_>>) -> std::result::Result<(), Refusal>,
}

struct Held<'a> {
    id: Value,
    kind: &'static str,
    params: Value,
    target: Option<Target<'a>>,
}

pub(super) fn marked<'a, T>(
    s: &Session,
    run: impl FnOnce(&mut dyn FnMut(&'static str, Value, Option<Target<'a>>) -> Result<()>) -> Result<T>,
) -> Result<T> {
    await_acceptance(s)?;
    let mut held: Vec<Held<'a>> = Vec::new();
    let mut point = None;
    let mut marked = false;
    let mut attempted = false;
    let mut lost = None;
    let check = || match &s.guard {
        Some(guard) => (guard.check)().map_err(Fail::from),
        None => s.check(),
    };
    let outcome = run(&mut |kind, mut params, target| {
        let mouse = matches!(kind, "pointer" | "wheel");
        let id = params[if mouse { "button" } else { "code" }].clone();
        let ty = params["type"].as_str().unwrap_or_default();
        let down = matches!(ty, "mousePressed" | "keyDown" | "rawKeyDown");
        let up = matches!(ty, "mouseReleased" | "keyUp");
        if s.mark {
            check()?;
            marked = true;
            let stamp = s.call("mark-input", None, vec![])?["value"]
                .as_f64()
                .filter(|t| t.is_finite() && *t > 0.0)
                .ok_or("Cannot establish automation input provenance")?;
            if kind != "insert-text" {
                params["timestamp"] = json!(stamp);
            }
            check()?;
        }
        if let Some(guard) = &s.guard {
            if let Err(refusal) = (guard.destination)(kind, &mut params, target) {
                if up && !refusal.timeout {
                    held.retain(|h| h.id != id);
                }
                return Err(refusal.into());
            }
        }
        if mouse {
            point = Some((params["x"].clone(), params["y"].clone(), target));
        }
        if up {
            held.retain(|h| h.id != id);
        }
        if down {
            let mut release = params.clone();
            release["type"] = json!(if mouse { "mouseReleased" } else { "keyUp" });
            release["buttons"] = json!(0);
            release["modifiers"] = json!(0);
            held.retain(|h| h.id != id);
            held.push(Held { id, kind, params: release, target });
        }
        attempted = true;
        send(s, kind, params)?;
        s.check()
    })
    .map_err(|mut fail| {
        lost = fail.refusal.take();
        let lower = fail.message.to_ascii_lowercase();
        if attempted && lost.is_none() && (lower.contains("timed out") || lower.contains("timeout")) {
            return "Input timed out: its outcome is unknown. The page was busy and the input may still be delivered; inspect before retrying.".into();
        }
        if attempted && s.mark {
            fail.message.push_str(". Input already sent may still be delivered; inspect before retrying.");
        }
        fail
    });
    for mut release in held.into_iter().rev() {
        if lost.as_ref().is_some_and(|r| !r.same_document) {
            break;
        }
        let cleanup = || -> Result<()> {
            if release.kind == "pointer" {
                let Some((x, y, target)) = &point else {
                    return Ok(());
                };
                if s.guard.is_some() && target.is_none() {
                    return Ok(());
                }
                release.params["x"] = x.clone();
                release.params["y"] = y.clone();
                release.target = *target;
            }
            check()?;
            if s.mark {
                if let Err(fail) = s.call("mark-input", None, vec![]) {
                    if fail.refusal.as_ref().is_some_and(|r| !r.timeout) {
                        return Err(fail);
                    }
                }
            }
            check()?;
            let object = release.params.as_object_mut().unwrap();
            object.remove("text");
            object.remove("unmodifiedText");
            if let Some(guard) = &s.guard {
                (guard.destination)(release.kind, &mut release.params, release.target)?;
            }
            send(s, release.kind, release.params)
        };
        if let Err(Fail {
            refusal: Some(refusal),
            ..
        }) = cleanup()
        {
            lost = Some(refusal);
            break;
        }
    }
    if marked && lost.is_none_or(|r| r.same_document) {
        let _ = s.call("unmark-input", None, vec![]);
    }
    outcome
}

fn send(s: &Session, kind: &str, params: Value) -> Result<()> {
    s.run(match kind {
        "insert-text" => json!({"op": "insert-text", "text": params["text"]}),
        _ => json!({"op": kind, "event": params}),
    })
    .map(drop)
}

/// Chromium drops input during paint holding; bound the wait to one second.
fn await_acceptance(s: &Session) -> Result<()> {
    let started = Instant::now();
    loop {
        let result = match s.call("input-acceptance", None, vec![]) {
            Err(fail) if fail.unsupported => return Err(fail),
            result => result.ok(),
        };
        s.check()?;
        let delay = result
            .as_ref()
            .and_then(|r| r["value"]["inputDelayMs"].as_f64());
        let remaining = 1_000.0 - started.elapsed().as_millis() as f64;
        match delay {
            Some(delay) if delay > 0.0 && remaining > 0.0 => {
                std::thread::sleep(Duration::from_millis(delay.min(remaining).min(50.0) as u64))
            }
            _ => return Ok(()),
        }
    }
}
