//! Closed private peer reply schema; a peer error string alone is not request-failure proof.
use crate::channel_wire::ChannelBootstrap;
use crate::{Error, Result};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RequestFailure {
    Failed,
    Cancelled,
}
impl RequestFailure {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Failed => "native-service-failed",
            Self::Cancelled => "native-service-cancelled",
        }
    }
}
pub(crate) enum PeerReply {
    Success { receipt: Vec<u8>, output: Value },
    Failure,
    Refused,
    CancelAck,
}
pub(crate) fn fields(value: &Value, keys: &[&str]) -> Result<()> {
    let object = value
        .as_object()
        .ok_or(Error("native-service-response-shape"))?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err(Error("native-service-response-shape"));
    }
    Ok(())
}
pub(crate) fn output(value: &Value) -> Result<()> {
    fields(value, &["stdout", "stderr"])?;
    for key in ["stdout", "stderr"] {
        if value[key].as_str().is_none_or(|s| s.len() > 65536) {
            return Err(Error("native-service-output-bound"));
        }
    }
    Ok(())
}
pub(crate) fn parse(boot: &ChannelBootstrap, value: &Value) -> Result<(u64, PeerReply)> {
    let body = if value.get("error").is_some() {
        "error"
    } else {
        "result"
    };
    fields(value, &["v", "id", "profile", "generation", body])?;
    if value["v"] != 1 || value["profile"] != boot.profile || value["generation"] != boot.generation
    {
        return Err(Error("native-service-response-scope"));
    }
    let id = value["id"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .ok_or(Error("native-service-response-id"))?;
    let reply = if body == "error" {
        match value[body].as_str() {
            Some("native-service-failed") => PeerReply::Failure,
            Some("native-service-refused") => PeerReply::Refused,
            _ => return Err(Error("native-service-response-error-code")),
        }
    } else if value[body].as_object().is_some_and(|o| o.is_empty()) {
        PeerReply::CancelAck
    } else {
        fields(&value[body], &["receipt", "output"])?;
        output(&value[body]["output"])?;
        let hex = value[body]["receipt"]
            .as_str()
            .filter(|s| (64..=8192).contains(&s.len()))
            .ok_or(Error("native-service-receipt-bound"))?;
        PeerReply::Success {
            receipt: crate::runtime_wire::unhex(hex)?,
            output: value[body]["output"].clone(),
        }
    };
    Ok((id, reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn boot() -> ChannelBootstrap {
        serde_json::from_value(serde_json::json!({"v":1,"profile":"a".repeat(64),"generation":"b","role":"broker","pipe":"",
        "secret":"c".repeat(64),"receiptSecret":"d".repeat(64),"controlPipe":"","supervisor":{"pid":1,"creationFiletime":"1"},"peer":{"pid":2,"creationFiletime":"2"},"application":{}})).unwrap()
    }
    fn error() -> Value {
        serde_json::json!({"v":1,"id":1,"profile":"a".repeat(64),"generation":"b","error":"native-service-failed"})
    }
    #[test]
    fn only_exact_scoped_correlated_static_error_shape_parses() {
        assert!(matches!(
            parse(&boot(), &error()).unwrap().1,
            PeerReply::Failure
        ));
        for (key, value) in [
            ("id", serde_json::json!(0)),
            ("id", serde_json::json!(4294967296u64)),
            ("profile", serde_json::json!("other")),
            ("generation", serde_json::json!("other")),
            ("error", serde_json::json!("private details")),
        ] {
            let mut e = error();
            e[key] = value;
            assert!(parse(&boot(), &e).is_err());
        }
        let mut e = error();
        e["result"] = serde_json::json!({});
        assert!(parse(&boot(), &e).is_err());
    }
    #[test]
    fn malformed_success_receipts_and_output_are_fatal_parse_errors() {
        let mut e = error();
        e.as_object_mut().unwrap().remove("error");
        e["result"] =
            serde_json::json!({"receipt":"z".repeat(64),"output":{"stdout":"","stderr":""}});
        assert!(parse(&boot(), &e).is_err());
        e["result"]["receipt"] = "a".repeat(64).into();
        e["result"]["output"]["stderr"] = "x".repeat(65537).into();
        assert!(parse(&boot(), &e).is_err());
        e["result"]["output"] = serde_json::json!({"stdout":"","stderr":"","extra":""});
        assert!(parse(&boot(), &e).is_err());
    }
}
