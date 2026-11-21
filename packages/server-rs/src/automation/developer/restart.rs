use super::*;

const RESTART: &str = "developer.restartScope";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    #[serde(flatten)]
    target: Target,
    restart_id: String,
}

impl Receipt {
    fn read(value: &Value) -> Option<Self> {
        let receipt: Self = serde_json::from_value(value.clone()).ok()?;
        let id = uuid::Uuid::parse_str(&receipt.restart_id).ok()?;
        let valid = |text: &str| (1..=128).contains(&text.len());
        let Target { native_identity, run_id, window } = &receipt.target;
        if id.get_version_num() != 4
            || id.get_variant() != uuid::Variant::RFC4122
            || id.to_string() != receipt.restart_id
            || !valid(native_identity)
            || !valid(run_id)
            || !valid(&window.window_id)
            || !window.window_instance.as_deref().is_none_or(valid)
            || value.as_object()?.len() != if window.window_instance.is_some() { 5 } else { 4 }
        {
            return None;
        }
        Some(receipt)
    }

    fn successor(&self, status: &Value) -> Option<Target> {
        let target: Target = serde_json::from_value(status.clone()).ok()?;
        (status["restartId"].as_str() == Some(&self.restart_id)
            && target.native_identity == self.target.native_identity
            && !target.run_id.is_empty()
            && target.run_id != self.target.run_id
            && target.window.window_id == self.target.window.window_id
            && (target.window.window_instance.is_none()
                || target.window.window_instance != self.target.window.window_instance))
            .then_some(target)
    }
}

pub(in crate::automation) async fn dispatch(pins: &Pins, session: &str, body: &Value) -> Response {
    let Some(expected) = Receipt::read(&body["command"]) else {
        return refuse(Status::BAD_REQUEST, "Invalid developer restart target");
    };
    let Some(token) = body["pin"].as_str() else {
        return coded(Status::NOT_FOUND, "inspect-required", "Run codenomad.inspect before restarting this window");
    };
    let target = expected.target;
    let run = &target.run_id;
    let Some(pin) = pins.get(session, &body["pin"]).filter(|pin| pin.target == target) else {
        return stale_inspection();
    };
    if !pins.is_current(session, token) {
        return stale_inspection();
    }
    let Some(access) = pins.access(run, false) else {
        return stale_inspection();
    };
    if !target.still_available().await {
        return unavailable(true, None);
    }
    match target.context(session).await {
        Ok(current) if pin.document.as_deref() == current["document"].as_str() => {}
        Ok(_) => return Failure::Document(STALE_DOCUMENT.into()).response(true),
        Err(error) => return error.response(true),
    }
    let Some(restart) = pins.restart(session, token, run, access) else {
        return stale_inspection();
    };
    match native_parent::request(RESTART, body["command"].clone(), NATIVE).await {
        Ok(done) => {
            restart.finish(true);
            result(done)
        }
        Err(error)
            if error == format!("Native request timed out: {RESTART}") || error == "Native parent is shutting down" =>
        {
            // Admission can close the reply channel. Drop retires old pins; only the successor can confirm.
            coded(Status::BAD_GATEWAY, "restart-outcome-unknown", "Native restart outcome is unknown")
        }
        Err(error) => {
            restart.finish(false);
            refuse(Status::CONFLICT, &error)
        }
    }
}

pub(in crate::automation) struct Reconnect {
    target: Target,
    restart_id: String,
    logs: Value,
}

impl Reconnect {
    pub(in crate::automation) async fn read(body: &Value) -> Result<Self, Response> {
        let Some(expected) = Receipt::read(&body["command"]) else {
            return Err(refuse(Status::BAD_REQUEST, "Invalid developer reconnect target"));
        };
        let not_found = || refuse(Status::NOT_FOUND, "No matching CodeNomad relaunch");
        let native = native_parent::request("developer.reconnect", body["command"].clone(), PROBE)
            .await
            .map_err(|_| not_found())?;
        let status = &native["status"];
        let target = expected.successor(status).ok_or_else(not_found)?;
        let ready = status["state"] == "ready"
            && (expected.target.window.window_instance.is_none() || target.window.window_instance.is_some());
        let reconnect = Self { target, restart_id: expected.restart_id, logs: native["logs"].clone() };
        if status["state"] == "missing" {
            return Err(reconnect.reply("missing", None));
        }
        if body["purpose"] == "confirm" || !ready {
            return Err(reconnect.pending());
        }
        Ok(reconnect)
    }

    fn reply(&self, state: &str, inspection: Option<Value>) -> Response {
        let mut body = json!({ "developerTarget": self.target, "restartId": self.restart_id, "windowState": state });
        if let Some(inspection) = inspection {
            body["result"] = inspection;
        }
        Json(body).into_response()
    }

    pub(in crate::automation) fn pending(&self) -> Response {
        self.reply("pending", None)
    }

    pub(in crate::automation) async fn inspect(self, pins: &Pins, session: &str, body: &Value) -> Response {
        let target = &self.target;
        let Some(ticket) = pins.begin_reconnect(session, body["order"].as_str(), &self.restart_id) else {
            return self.reply("superseded", None);
        };
        let Some(access) = pins.access(&target.run_id, false) else {
            return self.pending();
        };
        if !pins.is_selected(session, ticket) {
            return self.reply("superseded", None);
        }
        let Ok(mut done) = target.execute(session, None, json!({ "action": "inspect" }), PROBE).await else {
            return self.pending();
        };
        let Ok(document) = inspection_document(target, &mut done, None) else {
            return self.pending();
        };
        if !target.still_available().await {
            return self.pending();
        }
        let Some(pin) = pins.publish(session, ticket, access, Pin { target: target.clone(), document }) else {
            return if pins.is_selected(session, ticket) { self.pending() } else { self.reply("superseded", None) };
        };
        done["pin"] = json!(pin);
        diagnostics::extend(&mut done, &self.logs);
        self.reply("inspected", Some(done))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_needs_a_new_run_and_incarnation_on_the_same_scope_and_window() {
        let restart_id = "7c3e5066-017d-4ce1-a371-187ac459c4b2";
        let expected = json!({"runId":"old","nativeIdentity":"tauri:scope","windowId":"same",
            "windowInstance":"old-instance","restartId":restart_id});
        let receipt = Receipt::read(&expected).unwrap();
        let successor = json!({"runId":"new","nativeIdentity":"tauri:scope","windowId":"same",
            "windowInstance":"new-instance","restartId":restart_id});
        assert!(receipt.successor(&successor).is_some());
        for (key, value) in [
            ("nativeIdentity", "tauri:other"),
            ("restartId", "other"),
            ("runId", "old"),
            ("windowId", "different"),
            ("windowInstance", "old-instance"),
        ] {
            let mut mismatch = successor.clone();
            mismatch[key] = json!(value);
            assert!(receipt.successor(&mismatch).is_none(), "{key}");
        }
        let mut malformed = expected;
        malformed["windowInstance"] = Value::Null;
        assert!(Receipt::read(&malformed).is_none());
    }
}
