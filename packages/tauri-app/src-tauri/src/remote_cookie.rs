use serde::Deserialize;
use tauri::webview::cookie::{time::OffsetDateTime, Cookie, SameSite};
use tauri::Url;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteSessionCookie {
    origin: String,
    name: String,
    value: String,
    path: String,
    secure: bool,
    http_only: bool,
    same_site: String,
    expires: Option<i64>,
}

impl RemoteSessionCookie {
    pub(crate) fn validate(&self, base: &Url) -> Result<Cookie<'static>, String> {
        let safe_name = |b: u8| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b);
        let safe_value = |b: u8| matches!(b, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e);
        let same_site = match self.same_site.as_str() {
            "lax" => SameSite::Lax,
            "strict" => SameSite::Strict,
            "none" => SameSite::None,
            _ => return Err("Invalid remote session cookie".into()),
        };
        if self.origin != base.origin().ascii_serialization()
            || !matches!(base.scheme(), "http" | "https")
            || self.name.is_empty() || self.name.len() > 256 || !self.name.bytes().all(safe_name)
            || self.value.len() > 4096 || !self.value.bytes().all(safe_value)
            || !self.path.starts_with('/') || self.path.len() > 2048
            || !self.path.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b';')
            || (self.secure && base.scheme() != "https")
            || (same_site == SameSite::None && !self.secure)
            || (self.name.starts_with("__Secure-") && !self.secure)
            || (self.name.starts_with("__Host-") && (!self.secure || self.path != "/"))
            || self.expires.is_some_and(|v| !(0..=253402300799).contains(&v))
        {
            return Err("Invalid remote session cookie".into());
        }
        let host = base.host_str().ok_or("Invalid remote session cookie")?;
        let mut cookie = Cookie::build((self.name.clone(), self.value.clone()))
            .domain(host.to_string()).path(self.path.clone())
            .secure(self.secure).http_only(self.http_only).same_site(same_site).build();
        if let Some(expires) = self.expires {
            cookie.set_expires(OffsetDateTime::from_unix_timestamp(expires)
                .map_err(|_| "Invalid remote session cookie")?);
        }
        Ok(cookie)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remote_view_cookie_validation_and_native_attributes() {
        let base = Url::parse("https://box.example/").unwrap();
        let value = json!({"origin":"https://box.example", "name":"__Host-session", "value":"abc_123", "path":"/", "secure":true, "httpOnly":true, "sameSite":"lax", "expires":2000000000});
        let cookie = serde_json::from_value::<RemoteSessionCookie>(value.clone()).unwrap().validate(&base).unwrap();
        assert_eq!(cookie.domain(), Some("box.example"));
        assert_eq!(cookie.path(), Some("/"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.expires_datetime().unwrap().unix_timestamp(), 2000000000);
        for (key, invalid) in [
            ("origin", json!("https://evil.example")), ("origin", json!("https://box.example/")),
            ("name", json!("bad;name")), ("value", json!("x\r\nSet-Cookie: y")),
            ("value", json!("x;y")), ("path", json!("/;Domain=evil.example")),
            ("path", json!("relative")), ("path", json!("/other")), ("secure", json!(false)),
            ("sameSite", json!("invalid")), ("expires", json!(-1)), ("expires", json!(253402300800_i64)),
        ] {
            let mut bad = value.clone();
            bad[key] = invalid;
            assert!(serde_json::from_value::<RemoteSessionCookie>(bad).unwrap().validate(&base).is_err(), "{key}");
        }
        let mut session = value.clone();
        session["name"] = json!("codenomad_session");
        for path in ["/;Domain=evil.example", "/ space", "/é", "/\n"] {
            session["path"] = json!(path);
            assert!(serde_json::from_value::<RemoteSessionCookie>(session.clone()).unwrap().validate(&base).is_err());
        }
        session["path"] = json!("/project");
        assert!(serde_json::from_value::<RemoteSessionCookie>(session.clone()).unwrap().validate(&base).is_ok());
        session.as_object_mut().unwrap().remove("expires");
        assert!(serde_json::from_value::<RemoteSessionCookie>(session.clone()).unwrap().validate(&base).unwrap().expires().is_none());
        session["domain"] = json!("evil.example");
        assert!(serde_json::from_value::<RemoteSessionCookie>(session).is_err());
        assert!(serde_json::from_value::<RemoteSessionCookie>(value).unwrap().validate(&Url::parse("http://box.example").unwrap()).is_err());
    }
}
