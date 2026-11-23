use crate::{backend::Backend, platform};
use codenomad_client::{
    Receiver, bounded,
    settings::{OpenCodeStatus, install_opencode, local_opencode_offer},
};

const FAILED: &str = "settings.opencode.setup.actionFailed";

#[derive(Default)]
pub(in crate::settings) struct Install {
    flight: Option<(String, Receiver<Reply>)>,
    phase: Option<Phase>,
    expected: Option<Offer>,
    error: Option<(&'static str, String)>,
    revision: u64,
}

#[derive(Clone, PartialEq, Eq)]
struct Offer {
    binary: String,
    current: Option<String>,
    latest: Option<String>,
    shared: bool,
    foreign: bool,
}

enum Phase {
    Checking,
    Installing,
}
enum Reply {
    Checked(Option<OpenCodeStatus>),
    Installed(Result<(), &'static str>),
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

    pub fn start(
        &mut self,
        backend: &Backend,
        status: &OpenCodeStatus,
        main: Option<rune::Waker>,
        window: Option<rune::Waker>,
    ) {
        if self.busy() {
            return;
        }
        let Some(offer) = Offer::read(status) else {
            return;
        };
        self.expected = Some(offer);
        self.error = None;
        self.phase = Some(Phase::Checking);
        self.launch(backend, main, window, |backend| async move {
            Reply::Checked(local_opencode_offer(&backend).await.ok())
        });
    }

    pub fn busy(&self) -> bool {
        self.flight.is_some()
    }

    pub fn cancel_check(&mut self) {
        if matches!(self.phase, Some(Phase::Checking)) {
            self.flight = None;
            self.phase = None;
            self.expected = None;
        }
    }

    pub fn label(&self) -> Option<&'static str> {
        match self.phase {
            Some(Phase::Checking) => Some("settings.opencode.update.checking"),
            Some(Phase::Installing) => Some("settings.opencode.update.updating"),
            None => None,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn error(&self, backend: Option<&Backend>) -> Option<&'static str> {
        self.error
            .as_ref()
            .filter(|(_, owner)| backend.is_some_and(|b| b.client_id == *owner))
            .map(|(key, _)| *key)
    }

    pub fn poll(
        &mut self,
        backend: Option<&Backend>,
        main: Option<rune::Waker>,
        window: Option<rune::Waker>,
    ) -> bool {
        let Some((old, receiver)) = &self.flight else {
            return false;
        };
        let reply = match receiver.try_recv() {
            Ok(reply) => reply,
            Err(_) if receiver.is_closed() => Reply::Installed(Err(FAILED)),
            Err(_) => return false,
        };
        let current = backend.filter(|backend| backend.client_id == *old);
        self.flight = None;
        self.phase = None;
        let expected = self.expected.take();
        match reply {
            Reply::Checked(Some(status))
                if current.is_some() && expected.is_some() && Offer::read(&status) == expected =>
            {
                if let Some(backend) = current {
                    self.phase = Some(Phase::Installing);
                    self.launch(backend, main, window, |backend| async move {
                        Reply::Installed(install_opencode(&backend).await)
                    });
                }
                return true;
            }
            Reply::Checked(_) => {
                self.error = current.map(|backend| (FAILED, backend.client_id.clone()))
            }
            Reply::Installed(result) => {
                self.error = current
                    .zip(result.err())
                    .map(|(backend, error)| (error, backend.client_id.clone()))
            }
        }
        self.revision = self.revision.wrapping_add(1);
        true
    }

    fn launch<F: std::future::Future<Output = Reply> + platform::TaskBound + 'static>(
        &mut self,
        backend: &Backend,
        main: Option<rune::Waker>,
        window: Option<rune::Waker>,
        task: impl FnOnce(Backend) -> F,
    ) {
        let (out, input) = bounded(1);
        let future = task(backend.clone());
        self.flight = Some((backend.client_id.clone(), input));
        platform::spawn(async move {
            let _ = out.send(future.await).await;
            for wake in [main, window].into_iter().flatten() {
                wake();
            }
        });
    }
}
