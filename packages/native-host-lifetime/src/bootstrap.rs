use crate::handle::{identity, require_outside, Handle};
use crate::pipe;
use crate::{Error, Identity, Result};
use std::os::windows::io::AsRawHandle;
use std::time::Duration;
use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub(crate) const FRAME_BYTES: usize = 64;

// Private transport validation, not an independent-launch proof constructor.
pub(crate) fn read_frame(
    input: windows_sys::Win32::Foundation::HANDLE,
    timeout: Duration,
) -> Result<(Identity, Handle, Vec<u8>)> {
    let own = identity(unsafe { GetCurrentProcess() })?;
    let frame = pipe::read_exact(input, FRAME_BYTES, timeout)?;
    let mut peer_pid = 0;
    if unsafe { GetNamedPipeServerProcessId(input, &mut peer_pid) } == 0
        || peer_pid == 0
        || peer_pid == own.pid
    {
        return Err(Error("native-bootstrap-parent-unknown"));
    }
    let parent =
        unsafe { Handle::take(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, peer_pid))? };
    let parent_birth = identity(parent.raw())?;
    if &frame[..8] != b"CNHLv001"
        || u32::from_le_bytes(frame[40..44].try_into().unwrap()) != own.pid
        || u64::from_le_bytes(frame[44..52].try_into().unwrap()) != own.creation_filetime
        || u32::from_le_bytes(frame[52..56].try_into().unwrap()) != parent_birth.pid
        || u64::from_le_bytes(frame[56..64].try_into().unwrap()) != parent_birth.creation_filetime
    {
        return Err(Error("native-bootstrap-identity-mismatch"));
    }
    Ok((own, parent, frame))
}

/// Native owner-process proof. Existing UI code cannot make one from JSON/flags
/// or merely by observing a separately launched Node manager. The native owner
/// must itself consume its inherited parent-pipe challenge before creating a Job.
pub struct OwnerBootstrap {
    own: Identity,
    _parent: Handle,
}
impl OwnerBootstrap {
    pub fn accept_stdio(timeout: Duration) -> Result<Self> {
        let input = std::io::stdin().as_raw_handle();
        let output = std::io::stdout().as_raw_handle();
        require_outside(unsafe { GetCurrentProcess() })?;
        let (own, parent, frame) = read_frame(input, timeout)?;
        require_outside(unsafe { GetCurrentProcess() })?;
        if identity(unsafe { GetCurrentProcess() })? != own {
            return Err(Error("native-owner-identity-changed"));
        }
        pipe::write_bootstrap(output, &frame)?;
        Ok(Self {
            own,
            _parent: parent,
        })
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        // Original UI parent may have exited; it is NOT this owner's lifetime.
        if identity(unsafe { GetCurrentProcess() })? != self.own {
            return Err(Error("native-owner-identity-changed"));
        }
        require_outside(unsafe { GetCurrentProcess() })
    }
}
