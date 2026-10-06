//! S owns the authenticated independent Node peer, admission ledger and worker.
use crate::bound_channel::BoundChannel;
use crate::channel_wire::{self as wire, ChannelBootstrap};
use crate::service_control::{ControlServer, SharedLedger};
use crate::service_permit::Ledger;
use crate::supervised_runtime::Authority;
use crate::supervisor_config::BrokerConfig;
use crate::{Child, Error, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
pub(crate) enum Work {
    Start {
        id: u64,
        work: Value,
        cancelled: Arc<AtomicBool>,
    },
    Cancel(u64),
    Shutdown,
}
pub(crate) struct Completion {
    pub(crate) id: u64,
    pub(crate) result: Result<ServiceOutcome>,
}
pub(crate) enum ServiceOutcome {
    Succeeded(Vec<u8>, Value),
    RequestFailed(crate::service_reply::RequestFailure),
}
pub(crate) struct Services {
    pub(crate) sender: SyncSender<Work>,
    pub(crate) results: Receiver<Completion>,
    pub(crate) ledger: SharedLedger,
    thread: Option<std::thread::JoinHandle<()>>,
    controls: Vec<ControlServer>,
    stop_deadline: Arc<Mutex<Option<Instant>>>,
}
struct Broker {
    child: Child,
    channel: BoundChannel,
    stop_deadline: Arc<Mutex<Option<Instant>>>,
}
impl Drop for Broker {
    fn drop(&mut self) {
        let ending = match self.stop_deadline.lock() {
            Ok(ending) => *ending,
            Err(_) => Some(Instant::now()),
        };
        // Always request exact-handle cleanup, even at expiry, but never grant a
        // second wait budget after the Stop cutoff. No daemon handle is owned.
        let _ = self.child.process().terminate_owned_before(ending);
    }
}
impl Services {
    pub(crate) fn start(
        config: &BrokerConfig,
        authority: Arc<Authority>,
        manager: &mut ChannelBootstrap,
    ) -> Result<Self> {
        crate::supervisor_config::verify_artifact(&config.binding_file, &config.binding_sha256)?;
        crate::supervisor_config::verify_artifact(&config.program.entry, &config.entry_sha256)?;
        let command = config.program.command()?;
        let mut child = if authority.independent() {
            crate::launch_independent(&command)?
                .authenticate(Duration::from_secs(5))?
                .child
        } else {
            #[cfg(feature = "fixtures")]
            {
                let pending = crate::launch::spawn_suspended(&command, 0)?;
                authority.require_external(pending.process())?;
                let mut child = pending.resume()?;
                let frame = crate::launch::challenge_for(child.process())?;
                child.write_bootstrap(&frame)?;
                if child.read_private(64, Duration::from_secs(5))? != frame {
                    return Err(Error("native-service-peer-challenge"));
                }
                child
            }
            #[cfg(not(feature = "fixtures"))]
            return Err(Error("native-service-independent-proof-required"));
        };
        authority.require_external(child.process())?;
        let mut channel = BoundChannel::new(
            child.process(),
            "broker",
            &manager.profile,
            &manager.generation,
            json!({"launcherModule":config.launcher_module,"launcherSha256":config.launcher_sha256,"policy":config.policy,"profile":manager.profile,"generation":manager.generation}),
        )?;
        let ledger = Arc::new(Mutex::new(Ledger::new(
            authority.clone(),
            manager.clone(),
            channel.boot.clone(),
            config.policy.clone(),
            child.process(),
        )?));
        let (peer_control, peer_locator) =
            ControlServer::start(child.process(), &channel.boot, ledger.clone())?;
        let (manager_control, manager_locator) =
            ControlServer::start(authority.manager(), manager, ledger.clone())?;
        manager.control_pipe = manager_locator;
        channel.boot.control_pipe = peer_locator;
        channel.publish_child(&mut child)?;
        let stop_deadline = Arc::new(Mutex::new(None));
        let mut broker = Broker {
            child,
            channel,
            stop_deadline: stop_deadline.clone(),
        };
        broker.channel.authenticate()?;
        let (sender, work) = mpsc::sync_channel(wire::MAX_PENDING);
        let (done, results) = mpsc::sync_channel(wire::MAX_PENDING);
        let l = ledger.clone();
        let thread = std::thread::spawn(move || {
            let mut sequence = 0u64;
            let mut pending: HashMap<u64, (u64, String, Arc<AtomicBool>)> = HashMap::new();
            let mut acknowledgements = HashSet::new();
            let run = (|| -> Result<()> {
                loop {
                    match work.recv_timeout(Duration::from_millis(5)) {
                        Ok(Work::Start {
                            id,
                            work,
                            cancelled,
                        }) => {
                            if pending.len() >= 16 || cancelled.load(Ordering::Acquire) {
                                return Err(Error("native-service-backpressure"));
                            }
                            sequence = sequence
                                .checked_add(1)
                                .filter(|n| *n <= u32::MAX as u64)
                                .ok_or(Error("native-service-sequence"))?;
                            let grant = crate::runtime_wire::verify_receipt(
                                &broker.channel.boot,
                                &crate::service_control::decode(&work["grant"])?,
                            )?;
                            let nonce = grant["nonce"]
                                .as_str()
                                .ok_or(Error("native-service-grant-invalid"))?
                                .to_owned();
                            broker.channel.revalidate()?;
                            broker.channel.pipe.write(&json!({"v":1,"id":sequence,"profile":broker.channel.boot.profile,"generation":broker.channel.boot.generation,
                            "method":"service.start","params":work,"deadline":grant["deadline"]}),Duration::from_secs(2))?;
                            pending.insert(sequence, (id, nonce, cancelled));
                        }
                        Ok(Work::Cancel(id)) => {
                            for (key, (mid, nonce, c)) in &pending {
                                if *mid == id {
                                    c.store(true, Ordering::Release);
                                    l.lock()
                                        .map_err(|_| Error("native-service-ledger-poisoned"))?
                                        .cancel(nonce);
                                    sequence = sequence
                                        .checked_add(1)
                                        .filter(|n| *n <= u32::MAX as u64)
                                        .ok_or(Error("native-service-sequence"))?;
                                    if acknowledgements.len() >= 16 {
                                        return Err(Error("native-service-cancel-backpressure"));
                                    }
                                    acknowledgements.insert(sequence);
                                    broker.channel.pipe.write(&json!({"v":1,"id":sequence,"profile":broker.channel.boot.profile,"generation":broker.channel.boot.generation,
                            "method":"cancel","params":{"id":key},"deadline":wire::now()+5000}),Duration::from_secs(2))?;
                                }
                            }
                        }
                        Ok(Work::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    authority.revalidate()?;
                    broker.channel.revalidate()?;
                    l.lock()
                        .map_err(|_| Error("native-service-ledger-poisoned"))?
                        .expire();
                    if let Some(reply) = broker.channel.pipe.read(Duration::from_millis(10))? {
                        let (key, reply) =
                            crate::service_reply::parse(&broker.channel.boot, &reply)?;
                        if acknowledgements.remove(&key) {
                            if !matches!(reply, crate::service_reply::PeerReply::CancelAck) {
                                return Err(Error("native-service-cancel-response-invalid"));
                            }
                            continue;
                        }
                        let (id, nonce, cancelled) = pending
                            .remove(&key)
                            .ok_or(Error("native-service-response-unknown"))?;
                        let mut ledger = l
                            .lock()
                            .map_err(|_| Error("native-service-ledger-poisoned"))?;
                        let outcome = match reply {
                            crate::service_reply::PeerReply::Failure => {
                                ServiceOutcome::RequestFailed(ledger.request_failure(&nonce)?)
                            }
                            crate::service_reply::PeerReply::Refused
                                if cancelled.load(Ordering::Acquire) =>
                            {
                                ServiceOutcome::RequestFailed(ledger.request_failure(&nonce)?)
                            }
                            crate::service_reply::PeerReply::Success { receipt, output } => {
                                let facts =
                                    crate::runtime_wire::verify_receipt(&ledger.manager, &receipt)?;
                                if facts["nonce"] != nonce {
                                    return Err(Error("native-service-response-permit-mismatch"));
                                }
                                let digest = facts["requestDigest"]
                                    .as_str()
                                    .ok_or(Error("native-service-response-digest"))?;
                                ledger.verify_complete(digest, &receipt)?;
                                if cancelled.load(Ordering::Acquire) {
                                    return Err(Error("native-service-cancelled-success"));
                                }
                                ServiceOutcome::Succeeded(receipt, output)
                            }
                            _ => return Err(Error("native-service-response-unconfirmed")),
                        };
                        drop(ledger);
                        done.try_send(Completion {
                            id,
                            result: Ok(outcome),
                        })
                        .map_err(|_| Error("native-service-response-backpressure"))?;
                    }
                }
                Ok(())
            })();
            if let Ok(mut ledger) = l.lock() {
                ledger.fence();
            }
            // Pipe EOF makes peer cancel exact starter handles and drain before exiting.
            broker.channel.pipe.disconnect();
            let fallback = Instant::now() + Duration::from_secs(5);
            loop {
                // Re-read while waiting: Stop may arrive after peer loss has
                // already started teardown. Never hold this lock over a wait.
                let end = match broker.stop_deadline.lock() {
                    Ok(ending) => ending.map_or(fallback, |end| end.min(fallback)),
                    Err(_) => break,
                };
                let Some(left) = end
                    .checked_duration_since(Instant::now())
                    .filter(|left| !left.is_zero())
                else {
                    break;
                };
                match broker
                    .child
                    .process()
                    .wait_exit(left.as_millis().min(20) as u32)
                {
                    Ok(false) => std::thread::yield_now(),
                    _ => break,
                }
            }
            if let Err(error) = run {
                let _ = done.try_send(Completion {
                    id: 0,
                    result: Err(error),
                });
            } else {
                for (_, (id, _, _)) in pending {
                    let _ = done.try_send(Completion {
                        id,
                        result: Err(Error("native-service-channel-closed")),
                    });
                }
            }
        });
        Ok(Self {
            sender,
            results,
            ledger,
            thread: Some(thread),
            controls: vec![peer_control, manager_control],
            stop_deadline,
        })
    }
    pub(crate) fn begin_stop(&self, end: Instant) -> Result<()> {
        *self
            .stop_deadline
            .lock()
            .map_err(|_| Error("native-service-stop-deadline-poisoned"))? = Some(end);
        Ok(())
    }
    pub(crate) fn submit(
        &self,
        id: u64,
        permit: &[u8],
        bytes: &[u8],
        cancelled: Arc<AtomicBool>,
    ) -> Result<crate::service_response::RequestIdentity> {
        let ledger = self
            .ledger
            .lock()
            .map_err(|_| Error("native-service-ledger-poisoned"))?;
        let proof = crate::runtime_wire::verify_receipt(&ledger.manager, permit)?;
        drop(ledger);
        let work = self
            .ledger
            .lock()
            .map_err(|_| Error("native-service-ledger-poisoned"))?
            .consume(permit, bytes)?;
        self.sender
            .try_send(Work::Start {
                id,
                work,
                cancelled,
            })
            .map_err(|_| Error("native-service-backpressure"))?;
        Ok(crate::service_response::RequestIdentity {
            nonce: proof["nonce"]
                .as_str()
                .ok_or(Error("native-service-permit-invalid"))?
                .to_owned(),
            digest: crate::runtime_wire::digest(bytes),
        })
    }
}
impl Drop for Services {
    fn drop(&mut self) {
        let _ = self.sender.try_send(Work::Shutdown);
        let (replacement, _) = mpsc::sync_channel(1);
        drop(std::mem::replace(&mut self.sender, replacement));
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        self.controls.clear();
    }
}
