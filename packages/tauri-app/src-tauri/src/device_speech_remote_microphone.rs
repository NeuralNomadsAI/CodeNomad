use crate::{
    device_speech::DeviceSpeech,
    remote_dictation::{with_api_microphone_document, ApiMicrophonePurpose},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use gtk::{glib, prelude::*};
use parking_lot::Mutex;
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::{ipc::InvokeResolver, Manager, Webview};
use url::Url;
use uuid::Uuid;
use webkit2gtk::WebViewExt;

#[path = "device_speech_pcm.rs"]
mod pcm;

const DENIED: &str = "permissionDenied";
const UNAVAILABLE: &str = "unavailable";
const CONSENT: Duration = Duration::from_secs(30);
const EXPIRE: Duration = Duration::from_secs(150);

#[derive(Default)]
pub(crate) struct RemoteMicrophone(Mutex<Option<Arc<Capture>>>);

enum Phase {
    Consent,
    Opening,
    Recording,
    Finishing(InvokeResolver),
    LimitReached(String),
    Retiring,
    Closed,
}

pub(crate) struct Capture {
    owner: String,
    id: Uuid,
    purpose: ApiMicrophonePurpose,
    lease_bound: bool,
    phase: Mutex<Phase>,
}

impl RemoteMicrophone {
    pub(crate) fn busy(&self) -> Option<ApiMicrophonePurpose> {
        self.0
            .lock()
            .as_ref()
            .filter(|capture| !matches!(*capture.phase.lock(), Phase::Closed))
            .map(|capture| capture.purpose)
    }

    pub(crate) fn reserve(
        &self,
        owner: &str,
        id: Uuid,
        purpose: ApiMicrophonePurpose,
        lease_bound: bool,
    ) -> Option<Arc<Capture>> {
        let mut slot = self.0.lock();
        if slot
            .as_ref()
            .is_some_and(|capture| !matches!(*capture.phase.lock(), Phase::Closed))
        {
            return None;
        }
        let capture = Arc::new(Capture {
            owner: owner.into(),
            id,
            purpose,
            lease_bound,
            phase: Mutex::new(Phase::Consent),
        });
        *slot = Some(capture.clone());
        Some(capture)
    }

    pub(crate) fn get(&self, owner: &str, id: Uuid) -> Option<Arc<Capture>> {
        self.0
            .lock()
            .as_ref()
            .filter(|capture| capture.owner == owner && capture.id == id)
            .cloned()
    }

    pub(crate) fn revoke(&self, owner: Option<&str>, id: Option<Uuid>) -> bool {
        let capture = self
            .0
            .lock()
            .as_ref()
            .filter(|capture| {
                owner.is_none_or(|owner| capture.owner == owner)
                    && id.is_none_or(|id| capture.id == id)
            })
            .cloned();
        if let Some(capture) = capture {
            capture.revoke();
            true
        } else {
            false
        }
    }
}

impl Capture {
    pub(crate) fn admission(&self) -> (&str, Uuid, ApiMicrophonePurpose, bool) {
        (&self.owner, self.id, self.purpose, self.lease_bound)
    }

    pub(crate) fn purpose(&self) -> ApiMicrophonePurpose {
        self.purpose
    }

    fn pending(&self) -> bool {
        matches!(*self.phase.lock(), Phase::Consent)
    }

    pub(crate) fn accept(&self) -> bool {
        let mut phase = self.phase.lock();
        if !matches!(*phase, Phase::Consent) {
            return false;
        }
        *phase = Phase::Opening;
        true
    }

    pub(crate) fn status(&self) -> Result<&'static str, &'static str> {
        match *self.phase.lock() {
            Phase::Recording => Ok("recording"),
            Phase::LimitReached(_) => Ok("limitReached"),
            _ => Err(UNAVAILABLE),
        }
    }

    pub(crate) fn finish(&self, resolver: &InvokeResolver) -> Result<(), &'static str> {
        let mut phase = self.phase.lock();
        match &mut *phase {
            Phase::Recording => *phase = Phase::Finishing(resolver.clone()),
            Phase::LimitReached(_) => {
                let Phase::LimitReached(wav) = std::mem::replace(&mut *phase, Phase::Closed) else {
                    unreachable!()
                };
                resolver.clone().resolve(wav);
            }
            _ => return Err(UNAVAILABLE),
        }
        Ok(())
    }

    fn revoke(&self) {
        let mut phase = self.phase.lock();
        let next = match *phase {
            Phase::Opening | Phase::Recording | Phase::Finishing(_) | Phase::Retiring => {
                Phase::Retiring
            }
            _ => Phase::Closed,
        };
        if let Phase::Finishing(reply) = std::mem::replace(&mut *phase, next) {
            reply.reject(DENIED);
        }
    }

    fn open(self: Arc<Self>, reply: InvokeResolver) {
        tauri::async_runtime::spawn_blocking(move || {
            let pending = std::cell::Cell::new(Some(reply));
            let wav = pcm::record(
                || match *self.phase.lock() {
                    Phase::Opening | Phase::Recording => pcm::Control::Record,
                    Phase::Finishing(_) => pcm::Control::Finish,
                    _ => pcm::Control::Cancel,
                },
                || {
                    let mut phase = self.phase.lock();
                    if matches!(*phase, Phase::Opening) {
                        *phase = Phase::Recording;
                        pending.take().unwrap().resolve(());
                    }
                },
            );
            let mut phase = self.phase.lock();
            match (std::mem::replace(&mut *phase, Phase::Closed), wav) {
                (Phase::Recording, Ok(wav)) => *phase = Phase::LimitReached(STANDARD.encode(wav)),
                (Phase::Finishing(reply), Ok(wav)) => reply.resolve(STANDARD.encode(wav)),
                (Phase::Finishing(reply), Err(())) => reply.reject(UNAVAILABLE),
                (Phase::Opening | Phase::Retiring, _) => {
                    if let Some(reply) = pending.take() {
                        reply.reject(UNAVAILABLE);
                    }
                }
                _ => {}
            }
        });
    }
}

fn consent_question(purpose: ApiMicrophonePurpose) -> &'static str {
    static MESSAGES: OnceLock<serde_json::Value> = OnceLock::new();
    let messages = MESSAGES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../ui/src/lib/i18n/messages/native-microphone-consent.json"
        ))
        .expect("valid native microphone translations")
    });
    let key = match purpose {
        ApiMicrophonePurpose::Dictation => "dictation",
        ApiMicrophonePurpose::InputTest => "inputTest",
    };
    for locale in glib::language_names() {
        let language = locale.split(['_', '-', '.']).next().unwrap_or_default();
        let language = if language == "zh" {
            "zh-Hans"
        } else {
            language
        };
        if let Some(question) = messages[language][key].as_str() {
            return question;
        }
    }
    messages["en"][key]
        .as_str()
        .expect("English microphone translation")
}

pub(crate) fn prompt(
    webview: &Webview,
    capture: Arc<Capture>,
    generation: u64,
    initial: Url,
    resolver: &InvokeResolver,
) -> Result<(), &'static str> {
    let app = webview.app_handle().clone();
    let reply = resolver.clone();
    let fallback = capture.clone();
    let result = webview.with_webview(move |platform| {
        let view = platform.inner();
        let current = || Url::parse(view.uri()?.as_str()).ok();
        let parent = view
            .toplevel()
            .and_then(|widget| widget.downcast::<gtk::Window>().ok());
        let destination = with_api_microphone_document(
            &app,
            &capture.owner,
            &initial,
            generation,
            capture.purpose,
            str::to_owned,
        );
        let (Some(parent), Some(destination)) = (parent, destination) else {
            capture.revoke();
            reply.reject(DENIED);
            return;
        };
        if !parent.is_active() || current().as_ref() != Some(&initial) || !capture.pending() {
            capture.revoke();
            reply.reject(DENIED);
            return;
        }
        let dialog = gtk::MessageDialog::new(
            Some(&parent),
            gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
            gtk::MessageType::Question,
            gtk::ButtonsType::YesNo,
            consent_question(capture.purpose),
        );
        dialog.set_title("CodeNomad");
        dialog.set_secondary_text(Some(&format!("\u{2066}{destination}\u{2069}")));
        dialog.set_default_response(gtk::ResponseType::No);
        if let Some(no) = dialog.widget_for_response(gtk::ResponseType::No) {
            no.grab_focus();
        }

        let view = view.downgrade();
        let response_capture = capture.clone();
        let deadline = std::time::Instant::now() + CONSENT;
        let response = std::rc::Rc::new(std::cell::Cell::new(Some(move |answer| {
            let accepted = answer == gtk::ResponseType::Yes
                && std::time::Instant::now() < deadline
                && view.upgrade().is_some_and(|view| {
                    let Some(url) = view.uri().and_then(|uri| Url::parse(uri.as_str()).ok()) else {
                        return false;
                    };
                    url == initial
                        && with_api_microphone_document(
                            &app,
                            &response_capture.owner,
                            &url,
                            generation,
                            response_capture.purpose,
                            |_| {
                                app.state::<DeviceSpeech>()
                                    .accept_remote_microphone(&response_capture)
                            },
                        ) == Some(true)
                });
            if accepted {
                let expiry = Arc::downgrade(&response_capture);
                glib::timeout_add_local_once(EXPIRE, move || {
                    if let Some(capture) = expiry.upgrade() {
                        capture.revoke();
                    }
                });
                response_capture.open(reply);
            } else {
                response_capture.revoke();
                reply.reject(DENIED);
            }
        })));
        let destroyed = response.clone();
        dialog.connect_destroy(move |_| {
            if let Some(settle) = destroyed.take() {
                settle(gtk::ResponseType::Cancel);
            }
        });
        dialog.connect_response(move |dialog, answer| {
            if let Some(settle) = response.take() {
                settle(answer);
                if answer != gtk::ResponseType::DeleteEvent {
                    dialog.close();
                }
            }
        });

        let watch = dialog.downgrade();
        glib::timeout_add_local(Duration::from_millis(100), move || {
            let Some(dialog) = watch.upgrade().filter(|dialog| dialog.is_visible()) else {
                return glib::ControlFlow::Break;
            };
            if capture.pending() && std::time::Instant::now() < deadline {
                return glib::ControlFlow::Continue;
            }
            dialog.response(gtk::ResponseType::Cancel);
            glib::ControlFlow::Break
        });
        dialog.show();
    });
    if result.is_err() {
        fallback.revoke();
        return Err(UNAVAILABLE);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_speech::{MicrophonePurpose, Request};
    use serde_json::json;

    #[test]
    fn consent_is_single_use_and_reacquisition_waits_for_release() {
        let mic = RemoteMicrophone::default();
        let id = Uuid::new_v4();
        let capture = mic
            .reserve("remote", id, ApiMicrophonePurpose::InputTest, false)
            .unwrap();
        assert!(capture.pending());
        assert!(mic.get("other", id).is_none());
        assert_eq!(
            mic.get("remote", id).unwrap().purpose(),
            ApiMicrophonePurpose::InputTest
        );
        assert_ne!(
            consent_question(ApiMicrophonePurpose::InputTest),
            consent_question(ApiMicrophonePurpose::Dictation)
        );
        mic.revoke(Some("other"), None);
        mic.revoke(Some("remote"), Some(Uuid::new_v4()));
        assert!(capture.accept());
        assert!(!capture.accept());
        assert!(mic
            .reserve(
                "remote",
                Uuid::new_v4(),
                ApiMicrophonePurpose::Dictation,
                false
            )
            .is_none());
        mic.revoke(Some("remote"), None);
        assert!(matches!(*capture.phase.lock(), Phase::Retiring));
        assert!(mic
            .reserve(
                "remote",
                Uuid::new_v4(),
                ApiMicrophonePurpose::Dictation,
                false
            )
            .is_none());
        *capture.phase.lock() = Phase::Closed;

        let next = mic
            .reserve(
                "remote",
                Uuid::new_v4(),
                ApiMicrophonePurpose::InputTest,
                false,
            )
            .unwrap();
        assert!(next.pending());
        assert!(!capture.accept());
        mic.revoke(Some("remote"), Some(id));
        assert!(next.pending());
        mic.revoke(None, None);
        assert!(!next.accept());
    }

    #[test]
    fn remote_native_consent_and_retirement_share_the_renderer_lock() {
        let tmp = tempfile::tempdir().unwrap();
        let speech = DeviceSpeech::new(tmp.path().join("choice.json"), None);
        let id = Uuid::new_v4();
        let second = Uuid::new_v4();
        let claim = |owner, id: Uuid, purpose| {
            speech.request(
                owner,
                Request::ClaimMicrophone {
                    id: id.to_string(),
                    purpose,
                },
            )
        };
        let release = |owner, id: Uuid| {
            speech
                .request(owner, Request::ReleaseMicrophone { id: id.to_string() })
                .unwrap()
        };
        let reserve = |owner, id, purpose| speech.reserve_remote_microphone(owner, id, purpose);
        use ApiMicrophonePurpose::{Dictation, InputTest};
        assert_eq!(
            claim("remote", id, MicrophonePurpose::Test),
            Ok(json!({ "busy": null }))
        );
        assert!(reserve("remote", id, Dictation).is_none());
        assert!(reserve("remote", second, InputTest).is_none());
        assert!(reserve("other", id, InputTest).is_none());
        let pending = reserve("remote", id, InputTest).unwrap();
        release("remote", id);
        assert!(!speech.accept_remote_microphone(&pending));
        assert_eq!(
            claim("local", second, MicrophonePurpose::Dictation),
            Ok(json!({ "busy": "test" }))
        );
        assert!(speech.revoke_remote_microphone(Some("remote"), Some(id)));
        assert!(!speech.accept_remote_microphone(&pending));

        assert_eq!(
            claim("remote", second, MicrophonePurpose::Dictation),
            Ok(json!({ "busy": null }))
        );
        let capture = reserve("remote", second, Dictation).unwrap();
        assert!(speech.accept_remote_microphone(&capture));
        speech.revoke(Some("remote")); // Navigation also revokes the generic lease.
        assert!(matches!(*capture.phase.lock(), Phase::Retiring));
        assert_eq!(
            claim("local", id, MicrophonePurpose::Dictation),
            Ok(json!({ "busy": "dictation" }))
        );
        assert!(reserve("other", id, InputTest).is_none());
        *capture.phase.lock() = Phase::Closed;

        let legacy = reserve("remote", id, InputTest).unwrap();
        assert!(speech.accept_remote_microphone(&legacy));
        assert!(!speech.accept_remote_microphone(&legacy));
        *legacy.phase.lock() = Phase::LimitReached("excerpt".into());
        assert_eq!(
            claim("local", second, MicrophonePurpose::Dictation),
            Ok(json!({ "busy": "test" }))
        );
        legacy.revoke();
        assert_eq!(
            claim("local", second, MicrophonePurpose::Dictation),
            Ok(json!({ "busy": null }))
        );
    }
}
