use crate::history::{self, Result};
use codenomad_client::backend::Backend;
pub fn configured_target(bootstrap: bool) -> Result<Backend> {
    let base = crate::platform::setting("RUNE_BACKEND").ok_or("missing backend")?;
    let mut backend = Backend::unauthenticated(&base)?;
    backend.workspace = crate::platform::setting("RUNE_WORKSPACE").ok_or("missing workspace")?;
    backend.session = crate::platform::setting("RUNE_SESSION").ok_or("missing session")?;
    if !history::valid_id(&backend.workspace) || !history::valid_id(&backend.session) {
        return Err("invalid scope".into());
    }
    backend.fresh_mode =
        bootstrap && crate::platform::setting("RUNE_EMPTY_SESSION").as_deref() == Some("1");
    Ok(backend)
}
