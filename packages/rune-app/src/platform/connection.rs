use crate::history::{self, Result};
use codenomad_client::backend::Backend;
pub async fn configured_backend(bootstrap: bool) -> Result<Backend> {
    let base = crate::platform::setting("RUNE_BACKEND").ok_or("missing backend")?;
    let password = crate::platform::setting("RUNE_PASSWORD").unwrap_or_default();
    let token = bootstrap
        .then(|| crate::platform::setting("RUNE_BOOTSTRAP_TOKEN"))
        .flatten();
    let mut backend = Backend::connect_with_bootstrap(&base, &password, token.as_deref()).await?;
    backend.workspace = crate::platform::setting("RUNE_WORKSPACE").ok_or("missing workspace")?;
    backend.session = crate::platform::setting("RUNE_SESSION").ok_or("missing session")?;
    if !history::valid_id(&backend.workspace) || !history::valid_id(&backend.session) {
        return Err("invalid scope".into());
    }
    backend.fresh_mode = crate::platform::setting("RUNE_EMPTY_SESSION").as_deref() == Some("1");
    Ok(backend)
}
