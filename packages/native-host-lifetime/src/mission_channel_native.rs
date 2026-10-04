//! Retained, query-only native resources. Process/file identity is necessary but
//! never sufficient for writer, family, signer or human-origin authority.
use super::{Binding, FileIdentity};
use crate::{Error, Result, RuntimeMember};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use windows_sys::Win32::Storage::FileSystem::{
    FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
};

/// Intentionally no constructor. Only a genuine internal runtime registration
/// producer may transfer these retained resources into the guardian. Opening a
/// process by caller PID, opening caller paths or accepting an HMAC cannot do so.
pub(super) struct Retained {
    client: Arc<crate::native_client::Client>,
    writer: RuntimeMember,
    backend: RuntimeMember,
    storage: File,
    artifact: File,
}
fn file_identity(file: &File) -> Result<FileIdentity> {
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            &mut info as *mut _ as _,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(Error("native-missions-retained-file-identity-unavailable"));
    }
    Ok(FileIdentity {
        volume: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    })
}
impl Retained {
    pub(super) fn revalidate(&self, binding: &Binding) -> Result<()> {
        self.client.revalidate()?;
        self.writer.revalidate()?;
        self.backend.revalidate()?;
        if self.writer.exited()?
            || self.backend.exited()?
            || self.writer.identity() != binding.writer
            || self.backend.identity() != binding.backend
            || self.client.boot.peer != binding.manager.into()
            || self.client.boot.supervisor != binding.supervisor.into()
            || self.client.boot.generation != binding.generation
            || crate::runtime_wire::unhex(&self.client.boot.profile)? != binding.profile
            || file_identity(&self.storage)? != binding.daemon_storage
            || file_identity(&self.artifact)? != binding.artifact
        {
            return Err(Error("native-missions-retained-provenance-changed"));
        }
        // The exact retained artifact, not current bytes at a caller pathname.
        // The eventual producer must transfer an independently owned file handle;
        // guardian serialization owns its file position and bounds hash work.
        let mut artifact = &self.artifact;
        let size = artifact
            .metadata()
            .map_err(|_| Error("native-missions-artifact-unavailable"))?
            .len();
        if size == 0 || size > 8 * 1024 * 1024 {
            return Err(Error("native-missions-artifact-bound"));
        }
        artifact
            .seek(SeekFrom::Start(0))
            .map_err(|_| Error("native-missions-artifact-unavailable"))?;
        let mut hash = Sha256::new();
        let mut remaining = size;
        let mut bytes = [0; 16 * 1024];
        while remaining > 0 {
            let wanted = usize::min(remaining as usize, bytes.len());
            artifact
                .read_exact(&mut bytes[..wanted])
                .map_err(|_| Error("native-missions-artifact-unavailable"))?;
            hash.update(&bytes[..wanted]);
            remaining -= wanted as u64;
        }
        if hash.finalize().as_slice() != binding.artifact_digest
            || artifact
                .metadata()
                .map_err(|_| Error("native-missions-artifact-unavailable"))?
                .len()
                != size
            || file_identity(&self.artifact)? != binding.artifact
        {
            return Err(Error("native-missions-artifact-changed"));
        }
        // These concrete native facts do not certify internal registration,
        // registered-writer quiescence, family ownership or originating human.
        // No process-only qualification is available, even after all checks pass.
        Err(Error("native-missions-writer-producer-unavailable"))
    }
}
