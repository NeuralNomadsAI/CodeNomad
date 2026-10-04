use crate::handle::Handle;
use crate::{Error, Result};
use std::mem::size_of;
use std::ptr::null_mut;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Pipes::{CreatePipe, GetNamedPipeInfo, PeekNamedPipe};

pub(crate) fn pair() -> Result<(Handle, Handle)> {
    let descriptor = crate::security::private_descriptor()?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (null_mut(), null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, &attributes, 65536) } == 0 {
        return Err(Error("native-private-pipe-failed"));
    }
    let read = unsafe { Handle::take(read)? };
    let write = unsafe { Handle::take(write)? };
    let (mut input_size, mut output_size) = (0, 0);
    if unsafe {
        GetNamedPipeInfo(
            read.raw(),
            null_mut(),
            &mut output_size,
            &mut input_size,
            null_mut(),
        )
    } == 0
        || input_size.max(output_size) < 8192
    {
        return Err(Error("native-pipe-capacity-unproven"));
    }
    Ok((read, write))
}
pub(crate) fn no_inherit(handle: &Handle) -> Result<()> {
    if unsafe { SetHandleInformation(handle.raw(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(Error("native-handle-inheritance-unknown"));
    }
    Ok(())
}
pub(crate) fn read_exact(handle: HANDLE, size: usize, timeout: Duration) -> Result<Vec<u8>> {
    if size > 65536 || timeout > Duration::from_secs(30) {
        return Err(Error("native-pipe-bound-exceeded"));
    }
    let deadline = Instant::now() + timeout;
    let mut result = vec![0; size];
    let mut offset = 0;
    while offset < size {
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                handle,
                null_mut(),
                0,
                null_mut(),
                &mut available,
                null_mut(),
            )
        } == 0
        {
            return Err(Error("native-private-pipe-closed"));
        }
        if Instant::now() >= deadline {
            return Err(Error("native-private-pipe-deadline"));
        }
        if available == 0 {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let count = available.min((size - offset) as u32);
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle,
                result[offset..].as_mut_ptr(),
                count,
                &mut read,
                null_mut(),
            )
        } == 0
            || read == 0
        {
            return Err(Error("native-private-pipe-closed"));
        }
        offset += read as usize;
    }
    Ok(result)
}
/// One small bootstrap write into a newly created, empty 64 KiB private pipe.
/// Not a general streaming transport: Node IPC/backpressure needs a later adapter.
pub(crate) fn write_bootstrap(handle: HANDLE, value: &[u8]) -> Result<()> {
    if value.len() > 4096 {
        return Err(Error("native-pipe-bound-exceeded"));
    }
    let mut written = 0;
    if unsafe {
        WriteFile(
            handle,
            value.as_ptr(),
            value.len() as u32,
            &mut written,
            null_mut(),
        )
    } == 0
        || written as usize != value.len()
    {
        return Err(Error("native-private-pipe-write-failed"));
    }
    Ok(())
}
