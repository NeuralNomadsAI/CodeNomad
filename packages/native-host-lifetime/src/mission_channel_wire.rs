//! Versioned private Missions handshake. This is availability, NOT writer proof.
use crate::mission_channel::PROTOCOL;
use crate::{Error, Result};
use serde_json::{json, Value};

pub(crate) fn hello(request: &Value) -> Result<Value> {
    let keys = request
        .as_object()
        .ok_or(Error("native-missions-protocol-invalid"))?;
    if keys.len() != 4
        || !keys
            .keys()
            .all(|k| ["id", "method", "protocol", "challenge"].contains(&k.as_str()))
        || request["method"] != "missionsHello"
        || request["protocol"] != PROTOCOL
    {
        return Err(Error("native-missions-protocol-incompatible"));
    }
    let challenge = request["challenge"]
        .as_str()
        .filter(|s| crate::channel_wire::is_hex(s))
        .ok_or(Error("native-missions-challenge-bound"))?;
    Ok(
        json!({"protocol":PROTOCOL, "challenge":challenge, "writerProducer":false,
        "familyProducer":false,"transactionProducer":false}),
    )
}
pub(crate) fn validate_hello(reply: &Value, challenge: &[u8]) -> Result<()> {
    if challenge.len() != 32
        || reply["protocol"] != PROTOCOL
        || reply["challenge"] != crate::service_permit::hex(challenge)
        || !reply["writerProducer"].is_boolean()
        || !reply["familyProducer"].is_boolean()
        || !reply["transactionProducer"].is_boolean()
    {
        return Err(Error("native-missions-protocol-incompatible"));
    }
    // The caller still requires local retained evidence; true flags are NOT grants.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handshake_reports_missing_producers_and_refuses_old_versions() {
        let challenge = [7; 32];
        let request = json!({"id":1,"method":"missionsHello","protocol":PROTOCOL,
            "challenge":crate::service_permit::hex(&challenge)});
        let reply = hello(&request).unwrap();
        validate_hello(&reply, &challenge).unwrap();
        assert_eq!(reply["writerProducer"], false);
        assert_eq!(reply["familyProducer"], false);
        assert_eq!(reply["transactionProducer"], false);
        let mut old = request.clone();
        old["protocol"] = "codenomad.runtime.v1".into();
        assert!(hello(&old).is_err());
        old = request.clone();
        old["registration"] = json!({"writer":"caller"});
        assert!(hello(&old).is_err());
        assert!(validate_hello(&reply, &[8; 32]).is_err());
        assert!(validate_hello(&json!({"protocol":"old"}), &challenge).is_err());
    }
}
