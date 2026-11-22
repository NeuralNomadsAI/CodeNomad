use crate::{backend::Backend, history::Result};

pub fn run() {
    assert!(
        std::env::var("CODENOMAD_PROFILE")
            .unwrap()
            .starts_with("trial-")
    );
    crate::platform::block_on(qualify()).expect("owned workspace contracts");
}
async fn qualify() -> Result<()> {
    let folder = std::env::var("RUNE_TEST_FOLDER")?;
    let backend = Backend::connect(
        &std::env::var("RUNE_BACKEND")?,
        &std::env::var("RUNE_PASSWORD")?,
    )
    .await?;
    let identity = backend.server_id().await?;
    assert!(!identity.is_empty());
    assert!(backend.projects().await?.is_empty());
    let first_claim = codenomad_client::http::client_id()?;
    let second_claim = codenomad_client::http::client_id()?;
    let first = backend.create_project(&folder, &first_claim).await?;
    let second = backend.create_project(&folder, &second_claim).await?;
    assert_ne!(first.id, second.id);
    assert_eq!(first.path, second.path);
    let opened = backend.projects().await?;
    assert_eq!(opened.len(), 2);
    assert!(opened.iter().any(|p| p.id == first.id) && opened.iter().any(|p| p.id == second.id));
    assert!(
        backend
            .release_project_creation(&second.id, &first_claim)
            .await
            .is_err()
    );
    backend
        .release_project_creation(&first.id, &first_claim)
        .await?;
    backend
        .release_project_creation(&first.id, &first_claim)
        .await?;
    backend.cancel_project_creation(&first_claim).await?;
    assert_eq!(
        backend.projects().await?.len(),
        2,
        "released claim cannot cancel another owner"
    );
    backend.cancel_project_creation(&second_claim).await?;
    backend.cancel_project_creation(&second_claim).await?;
    let retained = backend.projects().await?;
    assert_eq!(retained.len(), 1);
    assert_eq!(retained[0].id, first.id);
    backend.release_project(&first.id).await?;
    backend.release_project(&first.id).await?;
    assert!(backend.projects().await?.is_empty());
    assert_eq!(backend.server_id().await?, identity);
    assert!(std::path::Path::new(&folder).is_dir());
    println!(
        "{}",
        serde_json::json!({
            "type": "workspace-claims", "distinctOccurrences": 2,
            "foreignClaimRejected": true, "releasedClaimProtected": true,
            "recordsRemaining": 0, "folderRetained": true, "serverIdentityStable": true,
        })
    );
    Ok(())
}
