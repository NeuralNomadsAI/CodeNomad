use super::*;
use std::fs;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread;

enum Resolution {
    Prepare(bool),
    Text(&'static str),
}

struct Fake {
    ready: Mutex<bool>,
    started: Sender<Control>,
    release: Mutex<Receiver<Resolution>>,
}

impl Driver for Fake {
    fn capabilities(&self) -> Hex {
        if *self.ready.lock() {
            Hex::Ready {
                plan: Plan {
                    id: "ready".into(),
                    missing: vec![],
                },
            }
        } else {
            Hex::NeedsPreparation {
                plan: Plan {
                    id: "missing".into(),
                    missing: vec![
                        Missing {
                            component: HexComponent::Engine,
                            download_bytes: 12,
                        },
                        Missing {
                            component: HexComponent::Model,
                            download_bytes: 20,
                        },
                        Missing {
                            component: HexComponent::Vad,
                            download_bytes: 2,
                        },
                    ],
                },
            }
        }
    }

    fn prepare(&self, _plan: Plan, control: Control) -> Result<(), SpeechError> {
        control.progress(Operation::Downloading {
            downloaded_bytes: 5,
        });
        self.started.send(control).unwrap();
        if let Resolution::Prepare(ready) = self
            .release
            .lock()
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
        {
            *self.ready.lock() = ready;
            if ready {
                return Ok(());
            }
        }
        Err(SpeechError::Failed)
    }

    fn stop(&self) {}
    fn request_stop(&self) {}

    fn dictate(
        &self,
        control: Control,
        _selected: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<String, SpeechError> {
        control.progress(Operation::Recording);
        self.started.send(control).unwrap();
        if let Resolution::Text(value) = self
            .release
            .lock()
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
        {
            return Ok(value.into());
        }
        Err(SpeechError::Failed)
    }
}

fn fixture() -> (
    tempfile::TempDir,
    DeviceSpeech,
    Receiver<Control>,
    Sender<Resolution>,
) {
    fixture_with_hex_ready(false)
}

fn fixture_with_hex_ready(
    ready: bool,
) -> (
    tempfile::TempDir,
    DeviceSpeech,
    Receiver<Control>,
    Sender<Resolution>,
) {
    let directory = tempfile::tempdir().unwrap();
    let (started, listen) = channel();
    let (release, wait) = channel();
    let driver = Arc::new(Fake {
        ready: Mutex::new(ready),
        started,
        release: Mutex::new(wait),
    });
    let device = DeviceSpeech::new(directory.path().join("choice.json"), Some(driver));
    (directory, device, listen, release)
}

#[test]
fn unsupported_saved_engine_requires_explicit_reselection() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("choice.json");
    let device = DeviceSpeech::new(path.clone(), None);
    let saved =
        json!({"version": 1, "engine": "unsupported", "revision": Uuid::new_v4().to_string()})
            .to_string();
    fs::write(&path, &saved).unwrap();
    let read = device.request("local", Request::Read {}).unwrap();
    assert_eq!(
        read,
        json!({"engine": null, "hex": {"state": "unavailable"}})
    );
    assert_eq!(device.preferred_engine().unwrap(), None);
    assert_eq!(
        device.request(
            "local",
            Request::Start {
                locale: "en".into(),
                engine: None,
                microphone_lease_id: None,
            },
        ),
        Err(SpeechError::Unavailable)
    );
    assert_eq!(fs::read_to_string(path).unwrap(), saved);
    device
        .request(
            "local",
            Request::Select {
                engine: Engine::Api,
            },
        )
        .unwrap();
    assert_eq!(device.preferred_engine().unwrap(), Some(Engine::Api));
}

fn operation(device: &DeviceSpeech, owner: &str, input: Request) -> String {
    device.request(owner, input).unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}

fn status(id: &str) -> Request {
    Request::Status { id: id.into() }
}

fn claim(device: &DeviceSpeech, owner: &str, id: &str, purpose: MicrophonePurpose) -> Value {
    device
        .request(
            owner,
            Request::ClaimMicrophone {
                id: id.into(),
                purpose,
            },
        )
        .unwrap()
}

fn release_microphone(device: &DeviceSpeech, owner: &str, id: &str) {
    assert_eq!(
        device.request(owner, Request::ReleaseMicrophone { id: id.into() }),
        Ok(Value::Null)
    );
}

fn settle(control: &Control) -> Operation {
    let (lock, wake) = &*control.0;
    let mut slot = lock.lock();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !slot.state.terminal() {
        assert!(!wake.wait_until(&mut slot, deadline).timed_out());
    }
    slot.state.clone()
}

#[cfg(target_os = "linux")]
#[test]
fn hex_microphone_claim_is_single_use_and_ends_with_its_operation() {
    let (_folder, device, _, _) = fixture();
    let start = |owner: &str| {
        let mut slots = device.slots.lock();
        let value = DeviceSpeech::begin(&mut slots.operations, owner, Kind::Dictation, |control| {
            control.wait_for_audio(|| false);
            Ok(Operation::Cancelled)
        })
        .unwrap();
        (
            value["id"].as_str().unwrap().to_owned(),
            slots.operations[Kind::Dictation as usize]
                .as_ref()
                .unwrap()
                .clone(),
        )
    };
    assert!(!device.claim_hex_microphone("owner"));
    let (_, control) = start("owner");
    assert!(!device.claim_hex_microphone("another-window"));
    assert!(device.claim_hex_microphone("owner"));
    assert!(!device.claim_hex_microphone("owner"));
    device.revoke(Some("owner"));
    assert!(!device.claim_hex_microphone("owner"));
    assert_eq!(settle(&control), Operation::Cancelled);
    let (id, control) = start("owner");
    device.request("owner", Request::Cancel { id }).unwrap();
    assert!(!device.claim_hex_microphone("owner"));
    assert_eq!(settle(&control), Operation::Cancelled);
}

#[test]
fn parses_shared_wire_vectors() {
    let vectors: Vec<Value> =
        serde_json::from_str(include_str!("../../../desktop-speech/request-vectors.json")).unwrap();
    for vector in vectors {
        let parsed = serde_json::from_value::<Request>(vector["request"].clone());
        assert_eq!(
            parsed.is_ok_and(|request| request.valid()),
            vector["valid"].as_bool().unwrap(),
            "{vector}"
        );
    }
}

#[test]
fn leased_start_binds_the_engine_and_claims_use_canonical_generated_ids() {
    let id = Uuid::new_v4().to_string();
    let valid =
        |value| serde_json::from_value::<Request>(value).is_ok_and(|request| request.valid());
    assert!(valid(
        json!({"action": "start", "locale": "en-US", "engine": "hex", "microphoneLeaseId": id})
    ));
    assert!(!valid(
        json!({"action": "start", "locale": "en-US", "microphoneLeaseId": id})
    ));
    assert!(!valid(
        json!({"action": "start", "locale": "en-US", "engine": "hex", "microphoneLeaseId": null})
    ));
    assert!(!valid(
        json!({"action": "claimMicrophone", "id": id.to_uppercase(), "purpose": "test"})
    ));
    assert!(valid(
        json!({"action": "claimMicrophone", "id": id, "purpose": "conversation"})
    ));
    assert!(valid(json!({"action": "releaseMicrophone", "id": id})));
}

#[test]
fn persists_the_shared_preference_and_rejects_stale_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("choice.json");
    let device = DeviceSpeech::new(path.clone(), None);
    assert_eq!(
        device.request("a", Request::Read {}),
        Ok(json!({
            "engine": "api", "hex": { "state": "unavailable" },
        }))
    );
    assert_eq!(
        device.request(
            "a",
            Request::Select {
                engine: Engine::Hex
            }
        ),
        Err(SpeechError::Unavailable)
    );
    device.store.select(Engine::Api, None).unwrap();
    let revision = device.store.read().unwrap().revision;
    let other = DeviceSpeech::new(path.clone(), None);
    assert_eq!(other.store.read().unwrap().revision, revision);
    other.store.select(Engine::Api, None).unwrap();
    assert_eq!(
        device.store.select(Engine::Hex, Some(&revision)),
        Err(SpeechError::PlanChanged)
    );
    assert_eq!(device.preferred_engine().unwrap(), Some(Engine::Api));
    fs::write(path, vec![b' '; 257]).unwrap();
    assert_eq!(
        device.request("a", Request::Read {}),
        Err(SpeechError::Failed)
    );
}

#[test]
fn cancellation_retains_previous_choice_until_verified_retry() {
    let (_directory, device, started, release) = fixture();
    let prepare = |plan: &str| Request::Prepare {
        plan_id: plan.into(),
    };
    assert_eq!(
        device.request("prefs", prepare("older")),
        Err(SpeechError::PlanChanged)
    );
    let id = operation(&device, "prefs", prepare("missing"));
    let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(
        device.request("other", status(&id)),
        Err(SpeechError::NotOwned)
    );
    assert_eq!(
        device.request("prefs", status(&id)),
        Ok(json!({
            "state": "downloading", "downloadedBytes": 5,
        }))
    );
    assert_eq!(
        device.request("other", Request::Cancel { id: id.clone() }),
        Err(SpeechError::NotOwned)
    );
    device
        .request("prefs", Request::Cancel { id: id.clone() })
        .unwrap();
    assert!(control.cancelled());
    assert_eq!(
        device.request("prefs", status(&id)),
        Ok(json!({ "state": "stopping" }))
    );
    assert_eq!(
        device.request("prefs", prepare("missing")),
        Err(SpeechError::Busy)
    );
    release.send(Resolution::Prepare(false)).unwrap();
    assert_eq!(settle(&control), Operation::Cancelled);
    assert_eq!(device.preferred_engine().unwrap(), Some(Engine::Api));

    let next = operation(&device, "prefs", prepare("missing"));
    let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
    release.send(Resolution::Prepare(true)).unwrap();
    assert_eq!(settle(&control), Operation::Prepared);
    assert_eq!(
        device.request("prefs", Request::Cancel { id: next.clone() }),
        Ok(json!({ "state": "prepared" }))
    );
    assert_eq!(
        device.request("prefs", status(&next)),
        Err(SpeechError::NotOwned)
    );
    assert_eq!(device.preferred_engine().unwrap(), Some(Engine::Hex));
    let next = operation(&device, "prefs", prepare("ready"));
    let control = device.slots.lock().operations[Kind::Prepare as usize]
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(settle(&control), Operation::Prepared);
    assert_eq!(
        device.request("prefs", status(&next)),
        Ok(json!({ "state": "prepared" }))
    );
    assert!(
        started.try_recv().is_err(),
        "zero missing components never invoke preparation"
    );
}

#[test]
fn dictation_finish_and_cancellation_are_owner_fenced() {
    let (_directory, device, started, release) = fixture_with_hex_ready(true);
    let start = || Request::Start {
        engine: None,
        locale: "en-US".into(),
        microphone_lease_id: None,
    };
    device
        .request(
            "prefs",
            Request::Select {
                engine: Engine::Hex,
            },
        )
        .unwrap();
    let id = operation(&device, "owner", start());
    let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(device.request("other", start()), Err(SpeechError::Busy));
    let finish = || Request::Finish {
        id: id.clone(),
        wav: "UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAA==".into(),
    };
    assert_eq!(
        device.request("other", finish()),
        Err(SpeechError::NotOwned)
    );
    device.request("owner", finish()).unwrap();
    assert!(control.wait_for_audio(|| false).is_some());
    assert_eq!(device.request("owner", finish()), Err(SpeechError::Busy));
    device.request("owner", Request::Cancel { id }).unwrap();
    assert!(control.cancelled());
    release.send(Resolution::Text("late result")).unwrap();
    assert_eq!(settle(&control), Operation::Cancelled);

    let new_id = operation(&device, "owner", start());
    let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
    device.revoke(Some("owner"));
    assert!(control.cancelled());
    thread::yield_now();
    assert_eq!(
        device.request("owner", status(&new_id)),
        Err(SpeechError::NotOwned)
    );
    release.send(Resolution::Text("late after reload")).unwrap();
    assert_eq!(settle(&control), Operation::Cancelled);
}

#[test]
fn unused_remote_microphone_reservation_expires_and_navigation_releases_it() {
    let (_folder, device, _, _) = fixture();
    let id = "c2d420ea-2677-4dbd-a521-92435a6ba004";
    let remote_claim = || {
        device.request_remote(
            "remote",
            Request::ClaimMicrophone {
                id: id.into(),
                purpose: MicrophonePurpose::Dictation,
            },
        )
    };
    assert_eq!(remote_claim().unwrap(), json!({ "busy": null }));
    assert_eq!(
        claim(&device, "local", id, MicrophonePurpose::Test),
        json!({ "busy": "dictation" })
    );
    #[cfg(not(target_os = "linux"))]
    {
        assert!(!device.authorize_remote_renderer_microphone("local"));
        assert!(device
            .slots
            .lock()
            .microphone
            .as_ref()
            .unwrap()
            .expires_at
            .is_some());
    }
    device.slots.lock().microphone.as_mut().unwrap().expires_at = Some(Instant::now());
    #[cfg(not(target_os = "linux"))]
    assert!(!device.authorize_remote_renderer_microphone("remote"));
    assert_eq!(remote_claim().unwrap(), json!({ "busy": null }));
    #[cfg(not(target_os = "linux"))]
    {
        assert!(device.authorize_remote_renderer_microphone("remote"));
        assert!(device
            .slots
            .lock()
            .microphone
            .as_ref()
            .unwrap()
            .expires_at
            .is_none());
    }
    device.revoke(Some("remote"));
    assert_eq!(
        claim(&device, "local", id, MicrophonePurpose::Test),
        json!({ "busy": null })
    );
}

#[test]
fn renderer_releases_and_revocations_are_owner_fenced() {
    use MicrophonePurpose::*;
    let (_directory, device, _, _) = fixture();
    let id = Uuid::new_v4().to_string();
    let wrong = Uuid::new_v4().to_string();
    for purpose in [Dictation, Test, Conversation] {
        assert_eq!(
            claim(&device, "owner", &id, purpose),
            json!({ "busy": null })
        );
        release_microphone(&device, "other", &id);
        release_microphone(&device, "owner", &wrong);
        device.revoke(Some("other"));
        assert_eq!(
            claim(&device, "other", &wrong, Test),
            json!({ "busy": purpose })
        );
        device.revoke(Some("owner"));
        assert_eq!(
            claim(&device, "other", &wrong, Test),
            json!({ "busy": null })
        );
        release_microphone(&device, "other", &wrong);
    }
}

#[test]
fn hex_requires_the_exact_dictation_lease_when_supplied_or_held() {
    use MicrophonePurpose::*;
    let (_directory, device, started, release) = fixture_with_hex_ready(true);
    device.store.select(Engine::Hex, None).unwrap();
    let id = Uuid::new_v4().to_string();
    let wrong = Uuid::new_v4().to_string();
    let start = |token: Option<&str>| Request::Start {
        engine: Some(Engine::Hex),
        locale: "en-US".into(),
        microphone_lease_id: token.map(str::to_owned),
    };
    assert_eq!(
        device.request("owner", start(Some(&id))),
        Err(SpeechError::NotOwned)
    );

    assert_eq!(claim(&device, "owner", &id, Test), json!({ "busy": null }));
    assert_eq!(
        device.request("owner", start(Some(&id))),
        Err(SpeechError::Busy)
    );
    release_microphone(&device, "owner", &id);
    assert_eq!(
        claim(&device, "owner", &id, Dictation),
        json!({ "busy": null })
    );
    assert_eq!(
        device.request("owner", start(Some(&wrong))),
        Err(SpeechError::Busy)
    );
    assert_eq!(
        device.request("other", start(Some(&id))),
        Err(SpeechError::Busy)
    );
    assert_eq!(device.request("owner", start(None)), Err(SpeechError::Busy));
    assert!(started.try_recv().is_err());

    let op = operation(&device, "owner", start(Some(&id)));
    let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
    release_microphone(&device, "owner", &id);
    assert_eq!(
        claim(&device, "other", &wrong, Conversation),
        json!({ "busy": "dictation" })
    );
    device.request("owner", Request::Cancel { id: op }).unwrap();
    assert!(control.cancelled());
    assert_eq!(
        claim(&device, "other", &wrong, Conversation),
        json!({ "busy": "dictation" })
    );
    release.send(Resolution::Text("discarded")).unwrap();
    assert_eq!(settle(&control), Operation::Cancelled);
    assert_eq!(
        claim(&device, "other", &wrong, Conversation),
        json!({ "busy": null })
    );
    release_microphone(&device, "other", &wrong);

    operation(&device, "owner", start(None));
    let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
    release.send(Resolution::Text("legacy")).unwrap();
    assert_eq!(
        settle(&control),
        Operation::Transcribed {
            text: "legacy".into()
        }
    );
}

#[test]
fn native_start_and_renderer_claim_are_mutually_exclusive() {
    let (_directory, device, started, release) = fixture_with_hex_ready(true);
    device.store.select(Engine::Hex, None).unwrap();
    let id = Uuid::new_v4().to_string();
    let barrier = std::sync::Barrier::new(2);
    let (native, renderer) = thread::scope(|scope| {
        let native = scope.spawn(|| {
            barrier.wait();
            device.request(
                "local",
                Request::Start {
                    engine: None,
                    locale: "en-US".into(),
                    microphone_lease_id: None,
                },
            )
        });
        barrier.wait();
        let renderer = claim(&device, "remote", &id, MicrophonePurpose::Conversation);
        (native.join().unwrap(), renderer)
    });
    if native.is_ok() {
        assert_eq!(renderer, json!({ "busy": "dictation" }));
        let control = started.recv_timeout(Duration::from_secs(3)).unwrap();
        release.send(Resolution::Text("native")).unwrap();
        assert_eq!(
            settle(&control),
            Operation::Transcribed {
                text: "native".into()
            }
        );
    } else {
        assert_eq!(native, Err(SpeechError::Busy));
        assert_eq!(renderer, json!({ "busy": null }));
        release_microphone(&device, "remote", &id);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn webkit_permit_consults_the_exact_lease_and_current_engine() {
    use MicrophonePurpose::*;
    let (_directory, device, _, _) = fixture();
    device.store.select(Engine::Hex, None).unwrap();
    let url = url::Url::parse("http://localhost:8100/").unwrap();
    let id = Uuid::new_v4().to_string();
    let wrong = Uuid::new_v4().to_string();
    let permit = |owner, id: &str, preferences| {
        let preflight = device.preflight(
            device.document_witness(owner),
            &Request::AuthorizeApiMicrophone { id: id.to_owned() },
        );
        device.authorize_api_microphone(owner, &url, id.to_owned(), preferences, preflight)
    };
    assert_eq!(permit("local", &id, false), Err(SpeechError::Unavailable));
    assert_eq!(permit("preferences", &id, true), Ok(Value::Null));
    assert_eq!(
        claim(&device, "local", &id, Dictation),
        json!({ "busy": null })
    );
    assert_eq!(permit("local", &id, false), Err(SpeechError::Unavailable));
    assert!(!device.claim_local_microphone("preferences", &url));
    release_microphone(&device, "local", &id);

    for purpose in [Test, Conversation] {
        assert_eq!(
            claim(&device, "local", &id, purpose),
            json!({ "busy": null })
        );
        assert_eq!(permit("local", &wrong, false), Err(SpeechError::Busy));
        assert_eq!(permit("other", &id, false), Err(SpeechError::Busy));
        assert_eq!(permit("local", &id, false), Ok(Value::Null));
        assert!(device.claim_local_microphone("local", &url));
        assert!(!device.claim_local_microphone("local", &url));
        assert_eq!(permit("local", &id, false), Ok(Value::Null));
        release_microphone(&device, "local", &id);
        assert!(!device.claim_local_microphone("local", &url));
    }
}

#[test]
fn revocation_can_retire_an_engine_selection_while_disk_work_is_pending() {
    let (_directory, device, _, _) = fixture();
    let owner = "preferences";
    let request = Request::Select {
        engine: Engine::Api,
    };
    let preflight = device.preflight(device.document_witness(owner), &request);
    let Ok(SpeechAdmission::Select(engine, caps, preflight)) =
        device.admit(owner, request, preflight, false)
    else {
        panic!("selection was not reserved");
    };
    let (staged, staging) = std::sync::mpsc::channel();
    let (resume, proceed) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        let worker = &device;
        let select = scope.spawn(move || {
            worker.finish_selection(owner, engine, caps, preflight, |admit| {
                staged.send(()).unwrap();
                proceed.recv_timeout(Duration::from_secs(5)).unwrap();
                admit()
            })
        });
        staging.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            device.slots.try_lock().is_some(),
            "publication holds the slots lock"
        );
        device.revoke(Some(owner));
        resume.send(()).unwrap();
        assert_eq!(select.join().unwrap(), Err(SpeechError::NotOwned));
    });
    assert!(!device.store.0.exists());
    assert!(!device.slots.lock().selecting);
}

#[test]
fn preflight_cannot_admit_a_replaced_document() {
    let (_directory, device, _, _) = fixture();
    let owner = "preferences";
    let request = Request::Select {
        engine: Engine::Api,
    };
    let preflight = device.preflight(device.document_witness(owner), &request);
    device.revoke(Some(owner));
    let _replacement = device.document_witness(owner);
    assert!(matches!(
        device.admit(owner, request, preflight, false),
        Err(SpeechError::NotOwned)
    ));
}
