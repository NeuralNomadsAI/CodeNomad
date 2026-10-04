//! Compiled fixture-only permit handoff. Product authorize()/verifyManager() stay closed.
use super::Client;
use crate::{Error, Result};
impl Client {
    pub(crate) fn fixture_authorize_response(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        self.revalidate()?;
        if self.boot.role != "manager"
            || self.boot.application["fixtureMode"] != "service-response"
            || !crate::handle::in_job(self.source.raw(), std::ptr::null_mut())?
            || !crate::handle::in_job(self.manager.raw(), std::ptr::null_mut())?
        {
            return Err(Error("native-fixture-nested-response-required"));
        }
        let envelope: crate::service_permit::Envelope =
            serde_json::from_slice(bytes).map_err(|_| Error("native-fixture-request-invalid"))?;
        // Same real control permit, CNG signature, retained native SDK pending
        // and budget as production. This export is absent without fixtures.
        self.issue_permit(bytes, envelope.deadline)
    }
}
