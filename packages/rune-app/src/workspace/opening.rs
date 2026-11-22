use crate::{backend::Backend, catalog::Project, history::Result, platform};

pub struct Opening {
    pub backend: Backend,
    pub project: Project,
    request: String,
    adopted: bool,
}
impl Opening {
    pub async fn create(backend: Backend, path: &str) -> Result<Self> {
        let request = codenomad_client::http::client_id()?;
        let project = match backend.create_project(path, &request).await {
            Ok(project) => project,
            Err(error) => {
                let _ = backend.cancel_project_creation(&request).await;
                return Err(error);
            }
        };
        Ok(Self {
            backend,
            project,
            request,
            adopted: false,
        })
    }
    pub fn adopt(mut self) {
        self.adopted = true;
        let (backend, request, id) = (
            self.backend.clone(),
            self.request.clone(),
            self.project.id.clone(),
        );
        platform::spawn(async move {
            let _ = backend.release_project_creation(&id, &request).await;
        });
    }
}
impl Drop for Opening {
    fn drop(&mut self) {
        if self.adopted {
            return;
        }
        let (backend, request, id) = (
            self.backend.clone(),
            self.request.clone(),
            self.project.id.clone(),
        );
        platform::spawn(async move {
            let _ = backend.cancel_project_creation(&request).await;
            let _ = backend.release_project(&id).await;
        });
    }
}
