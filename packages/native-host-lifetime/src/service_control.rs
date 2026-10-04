//! Authenticated bounded native auxiliary channel; fixed permit/observation operations.
use crate::bound_channel::BoundChannel;
use crate::channel_wire::ChannelBootstrap;
use crate::named_channel::NamedChannel;
use crate::runtime_wire;
use crate::service_permit::{hex, Ledger};
use crate::{Error, Process, Result};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
pub(crate) type SharedLedger = Arc<Mutex<Ledger>>;
pub(crate) struct ControlServer {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl ControlServer {
    pub(crate) fn start(
        peer: &Process,
        boot: &ChannelBootstrap,
        ledger: SharedLedger,
    ) -> Result<(Self, String)> {
        let mut channel = BoundChannel::new(
            peer,
            &format!("{}.control", boot.role),
            &boot.profile,
            &boot.generation,
            json!({}),
        )?;
        let name = channel.pipe.name.clone();
        channel.boot = boot.clone();
        channel.boot.pipe = name.clone();
        channel.boot.role = format!("{}.control", boot.role);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            let run = (|| -> Result<()> {
                channel.authenticate()?;
                let mut sequence = 0u64;
                while !stopped.load(Ordering::Acquire) {
                    channel.revalidate()?;
                    let request = if let Some(v) = channel.pipe.read(Duration::from_millis(20))? {
                        v
                    } else {
                        continue;
                    };
                    let id = request["id"]
                        .as_u64()
                        .ok_or(Error("native-control-sequence"))?;
                    if id != sequence + 1 || id > u32::MAX as u64 {
                        return Err(Error("native-control-sequence"));
                    }
                    sequence = id;
                    let mut l = ledger
                        .lock()
                        .map_err(|_| Error("native-service-ledger-poisoned"))?;
                    let result = (|| -> Result<Value> {
                        match (boot_role(&channel.boot), request["method"].as_str()) {
                            ("manager", Some("missionsHello")) => crate::mission_channel_wire::hello(&request),
                            ("manager", Some("permit")) => Ok(
                                json!({"bytes":hex(&l.issue(&decode(&request["bytes"])?,request["deadline"].as_u64().ok_or(Error("native-control-deadline"))?)?)}),
                            ),
                            ("manager", Some("verify")) => l.verify_response(
                                request["digest"]
                                    .as_str()
                                    .ok_or(Error("native-service-digest"))?,
                                &decode(&request["bytes"])?,
                            ),
                            ("broker", Some("prepare")) => {
                                Ok(json!({"bytes":hex(&l.prepare(&decode(&request["bytes"])?)?)}))
                            }
                            ("broker", Some("resumed")) => {
                                l.resumed(&decode(&request["bytes"])?)?;
                                Ok(json!({}))
                            }
                            ("broker", Some("complete")) => {
                                Ok(json!({"bytes":hex(&l.complete(&decode(&request["bytes"])?)?)}))
                            }
                            _ => Err(Error("native-control-operation-refused")),
                        }
                    })();
                    drop(l);
                    let response = match result {
                        Ok(v) => json!({"id":id,"result":v}),
                        Err(_) => json!({"id":id,"error":"native-service-refused"}),
                    };
                    channel.pipe.write(&response, Duration::from_secs(2))?;
                }
                Ok(())
            })();
            if run.is_err() && !stopped.load(Ordering::Acquire) {
                if let Ok(mut l) = ledger.lock() {
                    l.fence();
                }
            }
        });
        Ok((
            Self {
                stop,
                thread: Some(thread),
            },
            name,
        ))
    }
}
fn boot_role(boot: &ChannelBootstrap) -> &str {
    boot.role.strip_suffix(".control").unwrap_or("")
}
pub(crate) fn decode(value: &Value) -> Result<Vec<u8>> {
    let s = value
        .as_str()
        .filter(|s| s.len() <= 240000)
        .ok_or(Error("native-control-frame-bound"))?;
    runtime_wire::unhex(s)
}
impl Drop for ControlServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
pub(crate) struct ControlClient {
    pipe: NamedChannel,
    next: u64,
}
impl ControlClient {
    pub(crate) fn open(boot: &ChannelBootstrap) -> Result<Self> {
        let mut b = boot.clone();
        b.pipe = b.control_pipe.clone();
        b.role = format!("{}.control", b.role);
        let mut pipe = NamedChannel::open(&b.pipe)?;
        if pipe.server_pid()? != b.supervisor.pid {
            return Err(Error("native-control-source"));
        }
        let challenge = crate::channel_wire::random_hex()?;
        pipe.write(
            &json!({"v":1,"profile":b.profile,"generation":b.generation,"role":b.role,"peer":b.peer,
            "challenge":challenge,"proof":crate::channel_wire::mac(&b,&challenge,"client")}),
            Duration::from_secs(2),
        )?;
        let end = Instant::now() + Duration::from_secs(5);
        let reply = loop {
            if Instant::now() >= end {
                return Err(Error("native-control-auth-expired"));
            }
            if let Some(v) = pipe.read(Duration::from_millis(20))? {
                break v;
            }
        };
        if reply["challenge"] != challenge
            || !reply["proof"].as_str().is_some_and(|s| {
                crate::channel_wire::equal(s, &crate::channel_wire::mac(&b, &challenge, "server"))
            })
        {
            return Err(Error("native-control-auth-refused"));
        }
        Ok(Self { pipe, next: 0 })
    }
    pub(crate) fn call(&mut self, mut value: Value) -> Result<Value> {
        self.next = self
            .next
            .checked_add(1)
            .filter(|n| *n <= u32::MAX as u64)
            .ok_or(Error("native-control-sequence"))?;
        value["id"] = self.next.into();
        self.pipe.write(&value, Duration::from_secs(2))?;
        let end = Instant::now() + Duration::from_secs(5);
        let reply = loop {
            if Instant::now() >= end {
                return Err(Error("native-control-expired"));
            }
            if let Some(v) = self.pipe.read(Duration::from_millis(20))? {
                break v;
            }
        };
        if reply["id"] != self.next || reply.get("error").is_some() {
            return Err(Error("native-control-refused"));
        }
        Ok(reply["result"].clone())
    }
}
