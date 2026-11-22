use super::*;
use crate::{
    State,
    backend::Backend,
    platform::browser::{self, Request},
};

pub struct Pending {
    request: Request,
    serial: u64,
    step: Option<actions::Step>,
    generation: u64,
    epoch: u64,
    deadline: u64,
}

impl Preview {
    pub fn listen(&mut self, wake: rune::Waker) {
        if Guest::available() {
            self.requests = Some(browser::listen(wake));
        }
    }
    pub fn bind(&mut self, backend: &Backend) {
        self.close();
        self.owner = Some((backend.workspace.clone(), backend.session.clone()));
    }
    pub fn unbind(&mut self) {
        self.close();
        self.owner = None;
    }
    pub fn close(&mut self) {
        if let Some(p) = self.pending.take() {
            p.request.finish(Err("Browser target changed".into()));
        }
        self.panel = None;
        self.serial += 1;
    }
    fn submit(&mut self, request: Request, wake: rune::Waker) -> Result<(), (Request, String)> {
        let v = &request.value;
        let p = &v["params"];
        let command = &p["command"];
        let action = command["action"].as_str().unwrap_or_default();
        let reject = |r: Request, msg: &str| Err((r, msg.into()));
        if v["deadline"]
            .as_u64()
            .is_none_or(|d| d <= browser::now_ms())
        {
            return reject(request, "Browser command expired");
        }
        let Some((workspace, session)) = &self.owner else {
            return reject(request, "No visible browser target");
        };
        if p["sessionID"] != *session {
            return reject(request, "No visible browser target");
        }
        if v["method"] == "browser.probe" {
            let Some(panel) = &self.panel else {
                return reject(request, "No visible browser target");
            };
            let target = self.target(panel);
            request.finish(Ok(json!({"available":true,"target":target})));
            return Ok(());
        }
        if self.pending.is_some() {
            return reject(request, "Browser command already in progress");
        }
        let load = matches!(action, "navigate" | "open");
        if load && !command["url"].as_str().is_some_and(permitted) {
            return reject(
                request,
                "Ladybird prototype only accepts credential-free loopback HTTP",
            );
        }
        if action == "open" {
            if !p["workspaceIDs"]
                .as_array()
                .is_some_and(|xs| xs.iter().any(|x| x == workspace))
            {
                return reject(
                    request,
                    "No visible local window has the owning project tab",
                );
            }
            if self.panel.is_some() {
                return reject(request, "Browser preview already exists");
            }
            self.panel = Guest::start(wake).map(Panel::new);
        } else if self
            .panel
            .as_ref()
            .is_none_or(|panel| p["target"] != self.target(panel))
        {
            return reject(request, "Browser target changed");
        }
        let Some(panel) = &mut self.panel else {
            return reject(request, "No visible browser target");
        };
        self.serial += 1;
        let deadline = v["deadline"].as_u64().unwrap_or_default();
        let mut deadline = deadline;
        if action == "wait" {
            deadline = deadline
                .min(browser::now_ms() + command["timeout"].as_u64().unwrap_or(5_000).min(15_000));
        }
        let step = if load {
            panel.address = TextEdit::new(command["url"].as_str().unwrap_or_default());
            panel.navigate(false);
            None
        } else {
            let (step, command) = actions::first(command);
            if !panel.loaded || !send(panel, self.serial, deadline, command) {
                return reject(request, "Browser document changed or is still loading");
            }
            Some(step)
        };
        self.pending = Some(Pending {
            request,
            serial: self.serial,
            step,
            generation: panel.generation,
            epoch: panel.epoch,
            deadline,
        });
        Ok(())
    }
    fn target(&self, panel: &Panel) -> String {
        // Single Rune session window per trial backend. Allocation identity, then document.
        format!(
            "ladybird:{}:{}:{}",
            panel.registration, panel.generation, panel.epoch
        )
    }
}

fn send(panel: &mut Panel, serial: u64, deadline: u64, mut message: Value) -> bool {
    message["id"] = serial.into();
    message["deadline"] = deadline.into();
    message["epoch"] = panel.epoch.into();
    panel.send(message)
}

pub fn poll(s: &mut State, tx: &mut rune::Tx) -> bool {
    let preview = &mut s.preview;
    let mut changed = false;
    for _ in 0..16 {
        let Some(request) = preview.requests.as_ref().and_then(|rx| rx.try_recv().ok()) else {
            break;
        };
        if s.launcher_visible || s.commands.is_none() || preview.hidden {
            request.finish(Err("No visible browser target".into()));
        } else {
            match preview.submit(request, s.wake.clone()) {
                Ok(()) => changed = true,
                Err((request, e)) => request.finish(Err(e)),
            }
        }
    }
    if let Some(mut pending) = preview.pending.take() {
        let Some(panel) = &mut preview.panel else {
            pending.request.finish(Err("Browser target changed".into()));
            return changed;
        };
        let now = browser::now_ms();
        let reply = panel
            .guest
            .output
            .lock()
            .ok()
            .and_then(|mut o| o.reply.take());
        let resolved = if panel.generation != pending.generation
            || (pending.step.is_some() && pending.epoch != panel.epoch)
        {
            Some(Err("Browser target changed".into()))
        } else if pending.deadline <= now {
            Some(Err(
                if pending.request.value["params"]["command"]["action"] == "wait" {
                    "Text wait timed out"
                } else {
                    "Browser command timed out; inspect before another action"
                }
                .into(),
            ))
        } else if panel.error {
            Some(Err("Ladybird preview unavailable".into()))
        } else if pending.step.is_none() && panel.loaded && panel.last_frame != 0 {
            Some(Ok(json!({"url":panel.url})))
        } else if matches!(pending.step, Some(actions::Step::Wait))
            || reply.as_ref().is_some_and(|r| r["id"] == pending.serial)
        {
            let Some(step) = pending.step.take() else {
                pending
                    .request
                    .finish(Err("Unexpected browser response".into()));
                return changed;
            };
            let c = &pending.request.value["params"]["command"];
            match actions::advance(
                panel,
                c,
                step,
                reply.map(|r| r["result"].clone()).unwrap_or_default(),
            ) {
                Ok(actions::Next::Return(result)) => Some(Ok(result)),
                Ok(actions::Next::Again) => {
                    pending.step = Some(actions::Step::Wait);
                    None
                }
                Ok(actions::Next::Send(step, message)) => {
                    preview.serial += 1;
                    pending.serial = preview.serial;
                    pending.step = Some(step);
                    if send(panel, pending.serial, pending.deadline, message) {
                        None
                    } else {
                        Some(Err("Browser command not sent".into()))
                    }
                }
                Err(error) => Some(Err(error)),
            }
        } else {
            None
        };
        if let Some(result) = resolved {
            pending.request.finish(result);
        } else {
            let remaining = pending.deadline.saturating_sub(now);
            let delay = if matches!(pending.step, Some(actions::Step::Wait)) {
                remaining.min(40)
            } else {
                remaining
            };
            tx.wake_at(tx.clock() + delay as f64 * 0.001);
            preview.pending = Some(pending);
        }
    }
    changed
}
