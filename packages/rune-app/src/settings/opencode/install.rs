use crate::{backend::Backend, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{OpenCodeStatus, install_opencode, local_opencode_offer, opencode_status},
};

const FAILED: &str = "settings.opencode.setup.actionFailed";

#[derive(Default)]
pub(in crate::settings) struct Install {
    check: Option<Check>,
    write: Option<(String, Receiver<Completion>)>,
    completion: Option<(String, Option<&'static str>, Option<Diagnostic>)>,
}

struct Check {
    owner: String,
    _cancel: Sender<()>,
    reply: Receiver<Option<OpenCodeStatus>>,
    expected: Offer,
}

struct Completion {
    error: Option<&'static str>,
    status: Option<OpenCodeStatus>,
}

pub(in crate::settings) struct Diagnostic(pub Option<OpenCodeStatus>);

#[derive(PartialEq, Eq)]
struct Offer {
    binary: String,
    current: Option<String>,
    latest: Option<String>,
    shared: bool,
    foreign: bool,
}

impl Offer {
    fn read(status: &OpenCodeStatus) -> Option<Self> {
        if !status.can_upgrade || status.check_failed {
            return None;
        }
        Some(Self {
            binary: status.binary_path.clone()?,
            current: status.current.clone(),
            latest: status.latest.clone(),
            shared: status.needs_shared_installation,
            foreign: status.foreign_installation,
        })
    }
}

impl Install {
    pub fn offered(status: &OpenCodeStatus) -> bool {
        Offer::read(status).is_some()
    }

    pub fn start(&mut self, backend: &Backend, status: &OpenCodeStatus, wake: rune::Waker) {
        if self.busy() {
            return;
        }
        let Some(expected) = Offer::read(status) else {
            return;
        };
        let (out, reply) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        self.completion = None;
        self.check = Some(Check {
            owner: backend.client_id.clone(),
            _cancel: cancel,
            reply,
            expected,
        });
        let backend = backend.clone();
        platform::spawn(async move {
            if let Some(status) =
                platform::reads::cancellable(&cancelled, local_opencode_offer(&backend)).await
                && out.send(status.ok()).await.is_ok()
            {
                wake();
            }
        });
    }

    pub fn busy(&self) -> bool {
        self.check.is_some() || self.write.is_some()
    }

    pub fn cancel_check(&mut self) {
        self.check = None;
    }

    pub fn label(&self) -> Option<&'static str> {
        if self.check.is_some() {
            Some("settings.opencode.update.checking")
        } else if self.write.is_some() {
            Some("settings.opencode.update.updating")
        } else {
            None
        }
    }

    pub fn error(&self, backend: Option<&Backend>) -> Option<&'static str> {
        let (owner, error, _) = self.completion.as_ref()?;
        (backend?.client_id == *owner).then_some(*error).flatten()
    }

    pub fn take_status(&mut self, backend: Option<&Backend>) -> Option<Diagnostic> {
        let (owner, _, status) = self.completion.as_mut()?;
        if backend?.client_id != *owner {
            return None;
        }
        status.take()
    }

    // Only the live OpenCode view may turn a checked offer into a POST.
    pub fn admit(
        &mut self,
        backend: Option<&Backend>,
        main: Option<rune::Waker>,
        window: rune::Waker,
    ) -> bool {
        let Some(check) = &self.check else {
            return false;
        };
        let Some(backend) = backend.filter(|backend| backend.client_id == check.owner) else {
            self.cancel_check();
            return true;
        };
        let status = match check.reply.try_recv() {
            Ok(status) => status,
            Err(_) if check.reply.is_closed() => None,
            Err(_) => return false,
        };
        let expected = self.check.take().unwrap().expected;
        if status.as_ref().and_then(Offer::read).as_ref() != Some(&expected) {
            self.record(
                backend.client_id.clone(),
                Completion {
                    error: Some(FAILED),
                    status,
                },
            );
            return true;
        }
        let (out, input) = bounded(1);
        let backend = backend.clone();
        self.write = Some((backend.client_id.clone(), input));
        platform::spawn(async move {
            let error = install_opencode(&backend).await.err();
            let status = opencode_status(&backend, true).await.ok();
            let _ = out.send(Completion { error, status }).await;
            for wake in main.into_iter().chain([window]) {
                wake();
            }
        });
        true
    }

    pub fn poll(&mut self) -> bool {
        let Some((_, reply)) = &self.write else {
            return false;
        };
        let completion = match reply.try_recv() {
            Ok(completion) => completion,
            Err(_) if reply.is_closed() => Completion {
                error: Some(FAILED),
                status: None,
            },
            Err(_) => return false,
        };
        let (owner, _) = self.write.take().unwrap();
        self.record(owner, completion);
        true
    }

    fn record(&mut self, owner: String, completion: Completion) {
        self.completion = Some((owner, completion.error, Some(Diagnostic(completion.status))));
    }
}
