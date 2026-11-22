use super::*;
use crate::{
    State,
    backend::Backend,
    platform::browser::{self, Request},
};

pub struct Pending {
    request: Request,
    serial: u64,
    load: bool,
    generation: u64,
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
                "Servo prototype only accepts credential-free loopback HTTP",
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
        if load {
            panel.address = TextEdit::new(command["url"].as_str().unwrap_or_default());
            panel.navigate(false);
        } else if !panel.loaded
            || !panel.send(
                json!({"id":self.serial,"op":"automation","epoch":panel.epoch,
            "deadline":v["deadline"],"command":command}),
            )
        {
            return reject(request, "Browser document changed or is still loading");
        }
        self.pending = Some(Pending {
            request,
            serial: self.serial,
            load,
            generation: panel.generation,
        });
        Ok(())
    }
    fn target(&self, panel: &Panel) -> String {
        // Single Rune session window per trial backend. Allocation identity, then document.
        format!(
            "servo:{}:{}:{}",
            panel.registration, panel.generation, panel.epoch
        )
    }
}

pub fn poll(s: &mut State) -> bool {
    let preview = &mut s.preview;
    let mut changed = false;
    for _ in 0..16 {
        let Some(request) = preview.requests.as_ref().and_then(|rx| rx.try_recv().ok()) else {
            break;
        };
        if s.launcher_visible || preview.hidden {
            request.finish(Err("No visible browser target".into()));
        } else {
            match preview.submit(request, s.wake.clone()) {
                Ok(()) => changed = true,
                Err((request, e)) => request.finish(Err(e)),
            }
        }
    }
    if let Some(pending) = preview.pending.take() {
        let Some(panel) = &preview.panel else {
            pending.request.finish(Err("Browser target changed".into()));
            return changed;
        };
        let timed_out = pending.request.value["deadline"]
            .as_u64()
            .is_none_or(|d| d <= browser::now_ms());
        let reply = panel
            .guest
            .output
            .lock()
            .ok()
            .and_then(|mut o| o.reply.take());
        let resolved = if panel.generation != pending.generation {
            Some(Err("Browser target changed".into()))
        } else if timed_out {
            Some(Err(
                "Browser command timed out; inspect before another action".into(),
            ))
        } else if panel.error {
            Some(Err("Servo preview unavailable".into()))
        } else if pending.load && panel.loaded {
            Some(Ok(json!({"url":panel.url})))
        } else if let Some(reply) = reply.filter(|r| r["id"] == pending.serial) {
            Some(match reply["result"]["error"].as_str() {
                Some(e) => Err(e.into()),
                None => Ok(reply["result"].clone()),
            })
        } else {
            None
        };
        if let Some(result) = resolved {
            pending.request.finish(result);
        } else {
            preview.pending = Some(pending);
        }
    }
    changed
}
