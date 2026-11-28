use super::{
    microphone_id, DeviceSpeech, Engine, Kind, MicrophonePurpose, Operation, Slots, SpeechError,
    SpeechPreflight,
};
use crate::{
    device_speech_ipc::remote_microphone::Capture, remote_dictation::ApiMicrophonePurpose,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use url::Url;
use uuid::Uuid;

impl DeviceSpeech {
    pub(crate) fn claim_hex_microphone(&self, owner: &str) -> bool {
        self.slots
            .try_lock()
            .is_some_and(|slots| Self::claim_hex_microphone_in(&slots, owner))
    }

    fn claim_hex_microphone_in(slots: &Slots, owner: &str) -> bool {
        let Some(control) = &slots.operations[Kind::Dictation as usize] else {
            return false;
        };
        let mut slot = control.0 .0.lock();
        let now = Instant::now();
        if slot.owner.as_deref() != Some(owner)
            || slot.cancelled
            || slot.finish
            || slot.microphone_claimed
            || now >= slot.expires
            || now >= slot.deadline
            || !matches!(slot.state, Operation::Starting | Operation::Recording)
        {
            return false;
        }
        slot.microphone_claimed = true;
        true
    }

    pub(crate) fn authorize_api_microphone(
        &self,
        owner: &str,
        url: &Url,
        id: String,
        preferences: bool,
        preflight: SpeechPreflight,
    ) -> Result<Value, SpeechError> {
        let slots = self.slots.lock();
        Self::check_preflight(&slots, owner, &preflight)?;
        if self.native_microphone_busy(&slots).is_some() {
            return Err(SpeechError::Busy);
        }
        let lease = slots.microphone.as_ref();
        if lease.is_some_and(|lease| lease.owner != owner || Some(lease.id) != microphone_id(&id)) {
            return Err(SpeechError::Busy);
        }
        if !preferences
            && !lease.is_some_and(|lease| lease.purpose != MicrophonePurpose::Dictation)
            && !preflight
                .choice
                .expect("microphone probes choice")
                .is_ok_and(|choice| choice.engine == Some(Engine::Api))
        {
            return Err(SpeechError::Unavailable);
        }
        self.api_microphone
            .authorize(owner, url, id, lease.map(|lease| lease.id));
        Ok(Value::Null)
    }

    pub(crate) fn revoke_api_microphone(
        &self,
        owner: &str,
        id: &str,
        preflight: SpeechPreflight,
    ) -> Result<Value, SpeechError> {
        let slots = self.slots.lock();
        if !Self::document_current(&slots, owner, &preflight) {
            return Err(SpeechError::NotOwned);
        }
        self.api_microphone.revoke(Some(owner), Some(id));
        Ok(Value::Null)
    }

    pub(crate) fn claim_local_microphone(&self, owner: &str, url: &Url) -> bool {
        let Some(slots) = self.slots.try_lock() else {
            return false;
        };
        if self.native_microphone_busy(&slots).is_some() {
            return Self::claim_hex_microphone_in(&slots, owner);
        }
        let lease = slots.microphone.as_ref();
        lease.is_none_or(|lease| lease.owner == owner)
            && self
                .api_microphone
                .claim(owner, url, lease.map(|lease| lease.id))
    }

    pub(crate) fn reserve_remote_microphone(
        &self,
        owner: &str,
        id: Uuid,
        purpose: ApiMicrophonePurpose,
    ) -> Option<Arc<Capture>> {
        let mut slots = self.slots.lock();
        slots.expire_microphone(Instant::now());
        if slots.active(Kind::Dictation)
            || slots
                .microphone
                .as_ref()
                .is_some_and(|lease| !lease.matches(owner, Some(id), purpose.microphone_purpose()))
        {
            return None;
        }
        let capture =
            self.remote_microphone
                .reserve(owner, id, purpose, slots.microphone.is_some())?;
        if let Some(lease) = slots
            .microphone
            .as_mut()
            .filter(|lease| lease.expires_at.is_some())
        {
            // Once the native dialog owns capture, use its bounded confirmation window.
            lease.expires_at = Some(Instant::now() + Duration::from_secs(30));
        }
        Some(capture)
    }

    pub(crate) fn accept_remote_microphone(&self, capture: &Capture) -> bool {
        let mut slots = self.slots.lock();
        // The native confirmation has its own deadline and occupies the microphone.
        let (owner, id, purpose, lease_bound) = capture.admission();
        let lease_matches = match &slots.microphone {
            Some(lease) => lease.matches(owner, Some(id), purpose.microphone_purpose()),
            None => !lease_bound,
        };
        if !lease_matches || !capture.accept() {
            return false;
        }
        if let Some(lease) = slots.microphone.as_mut() {
            lease.expires_at = None;
        }
        true
    }

    pub(crate) fn get_remote_microphone(&self, owner: &str, id: Uuid) -> Option<Arc<Capture>> {
        self.remote_microphone.get(owner, id)
    }

    pub(crate) fn revoke_remote_microphone(&self, owner: Option<&str>, id: Option<Uuid>) -> bool {
        let _slots = self.slots.lock();
        self.remote_microphone.revoke(owner, id)
    }
}

#[derive(Default)]
pub(crate) struct ApiMicrophone(Mutex<HashMap<String, Permit>>);

struct Permit {
    id: String,
    lease_id: Option<Uuid>,
    document: Url,
    expires: Instant,
}

fn document(mut url: Url) -> Url {
    url.set_fragment(None);
    url
}

impl ApiMicrophone {
    pub(crate) fn authorize(&self, owner: &str, url: &Url, id: String, lease_id: Option<Uuid>) {
        self.0.lock().insert(
            owner.into(),
            Permit {
                id,
                lease_id,
                document: document(url.clone()),
                expires: Instant::now() + Duration::from_secs(5),
            },
        );
    }

    pub(crate) fn claim(&self, owner: &str, url: &Url, lease_id: Option<Uuid>) -> bool {
        let mut permits = self.0.lock();
        if permits.get(owner).is_some_and(|permit| {
            Instant::now() < permit.expires
                && permit.document == document(url.clone())
                && permit.lease_id == lease_id
        }) {
            permits.remove(owner);
            true
        } else {
            false
        }
    }

    pub(crate) fn revoke(&self, owner: Option<&str>, id: Option<&str>) {
        self.0.lock().retain(|label, permit| {
            owner.is_some_and(|owner| owner != label) || id.is_some_and(|id| id != permit.id)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_microphone_is_owned_by_one_document_and_consumed_once() {
        let mic = ApiMicrophone::default();
        let url = Url::parse("http://127.0.0.1:8100/?preferences=speech").unwrap();
        let id = Uuid::new_v4();
        assert!(!mic.claim("preferences", &url, Some(id)));
        mic.authorize("preferences", &url, id.to_string(), Some(id));
        assert!(!mic.claim("local-other", &url, Some(id)));
        assert!(!mic.claim("preferences", &url.join("/preview").unwrap(), Some(id)));
        assert!(!mic.claim(
            "preferences",
            &url.join("https://other.example/").unwrap(),
            Some(id)
        ));
        assert!(!mic.claim("preferences", &url, None));
        assert!(!mic.claim("preferences", &url, Some(Uuid::new_v4())));
        assert!(mic.claim("preferences", &url, Some(id)));
        assert!(!mic.claim("preferences", &url, Some(id)));
    }

    #[test]
    fn api_microphone_is_revoked_on_cancel_navigation_or_expiry() {
        let mic = ApiMicrophone::default();
        let url = Url::parse("http://127.0.0.1:8100/").unwrap();
        let authorize = || mic.authorize("composer", &url, "current".into(), None);
        authorize();
        mic.revoke(Some("composer"), Some("retired"));
        assert!(mic.claim("composer", &url, None));
        authorize();
        mic.revoke(Some("composer"), Some("current"));
        assert!(!mic.claim("composer", &url, None));
        authorize();
        mic.revoke(Some("composer"), None);
        assert!(!mic.claim("composer", &url, None));
        authorize();
        mic.0.lock().get_mut("composer").unwrap().expires = Instant::now();
        assert!(!mic.claim("composer", &url, None));
    }
}
