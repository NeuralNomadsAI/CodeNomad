//! Owned local named pipe. All I/O is overlapped, cancellable and outside Job loans.
use crate::handle::Handle;
use crate::{Error, Result};
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::Pipes::*;
use windows_sys::Win32::System::Threading::*;
use windows_sys::Win32::System::IO::*;

pub(crate) struct NamedChannel {
    pub(crate) handle: Handle,
    pub(crate) name: String,
    buffer: Vec<u8>,
    partial_since: Option<Instant>,
}

struct Io {
    event: Handle,
    overlapped: Box<OVERLAPPED>,
    handle: HANDLE,
    pending: bool,
}
impl Io {
    fn new(handle: HANDLE) -> Result<Self> {
        let event = unsafe { Handle::take(CreateEventW(null(), 1, 0, null()))? };
        let mut overlapped: Box<OVERLAPPED> = Box::new(unsafe { zeroed() });
        overlapped.hEvent = event.raw();
        Ok(Self {
            event,
            overlapped,
            handle,
            pending: false,
        })
    }
    fn finish(&mut self, started: BOOL, timeout: Duration) -> Result<u32> {
        if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(Error("native-channel-io-failed"));
        }
        self.pending = true;
        let wait =
            unsafe { WaitForSingleObject(self.event.raw(), timeout.as_millis().min(30000) as u32) };
        if wait != 0 {
            unsafe {
                CancelIoEx(self.handle, &*self.overlapped);
            }
            let mut done = 0;
            // Drain cancelled OVERLAPPED before releasing any buffer/event storage.
            let completed =
                unsafe { GetOverlappedResult(self.handle, &*self.overlapped, &mut done, 1) };
            self.pending = false;
            if completed != 0 {
                return Ok(done);
            } // Completion won the cancellation race.
            return Err(Error(if wait == 258 {
                "native-channel-deadline"
            } else {
                "native-channel-wait-unknown"
            }));
        }
        let mut done = 0;
        let ok = unsafe { GetOverlappedResult(self.handle, &*self.overlapped, &mut done, 0) };
        self.pending = false;
        if ok == 0 {
            return Err(Error("native-channel-closed"));
        }
        Ok(done)
    }
}
impl Drop for Io {
    fn drop(&mut self) {
        if self.pending {
            unsafe {
                CancelIoEx(self.handle, &*self.overlapped);
                let mut done = 0;
                GetOverlappedResult(self.handle, &*self.overlapped, &mut done, 1);
            }
        }
    }
}
impl NamedChannel {
    pub(crate) fn new() -> Result<Self> {
        let name = format!(
            "\\\\.\\pipe\\codenomad-runtime-v1-{}",
            crate::channel_wire::random_hex()?
        );
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        let descriptor = crate::security::private_descriptor()?;
        let attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let raw = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                0,
                &attrs,
            )
        };
        let handle = unsafe { Handle::take(raw)? };
        crate::security::verify_private_kernel(handle.raw())?;
        Ok(Self {
            handle,
            name,
            buffer: vec![],
            partial_since: None,
        })
    }
    pub(crate) fn connect(&mut self, timeout: Duration) -> Result<()> {
        let mut io = Io::new(self.handle.raw())?;
        let ok = unsafe { ConnectNamedPipe(self.handle.raw(), &mut *io.overlapped) };
        if ok == 0 && unsafe { GetLastError() } == ERROR_PIPE_CONNECTED {
            return Ok(());
        }
        io.finish(ok, timeout)?;
        Ok(())
    }
    pub(crate) fn client_pid(&self) -> Result<u32> {
        let (mut client, mut server) = (0, 0);
        if unsafe { GetNamedPipeClientProcessId(self.handle.raw(), &mut client) } == 0
            || unsafe { GetNamedPipeServerProcessId(self.handle.raw(), &mut server) } == 0
            || server != std::process::id()
            || client == 0
        {
            return Err(Error("native-channel-peer-unknown"));
        }
        Ok(client)
    }
    pub(crate) fn disconnect(&mut self) {
        unsafe {
            DisconnectNamedPipe(self.handle.raw());
        }
        self.buffer.clear();
        self.partial_since = None;
    }
    fn take_frame(&mut self) -> Result<Option<serde_json::Value>> {
        if self.buffer.len() >= 4 {
            let size = u32::from_le_bytes(self.buffer[..4].try_into().unwrap()) as usize;
            if size == 0 || size > crate::channel_wire::MAX_FRAME {
                return Err(Error("native-channel-frame-bound"));
            }
            if self.buffer.len() >= 4 + size {
                let data = self.buffer[4..4 + size].to_vec();
                self.buffer.drain(..4 + size);
                self.partial_since = if self.buffer.is_empty() {
                    None
                } else {
                    Some(Instant::now())
                };
                return serde_json::from_slice(&data)
                    .map(Some)
                    .map_err(|_| Error("native-channel-json"));
            }
        }
        Ok(None)
    }
    pub(crate) fn read(&mut self, timeout: Duration) -> Result<Option<serde_json::Value>> {
        if self
            .partial_since
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(5))
        {
            return Err(Error("native-channel-partial-deadline"));
        }
        if let Some(frame) = self.take_frame()? {
            return Ok(Some(frame));
        }
        let mut data = vec![0u8; 32768];
        let mut io = Io::new(self.handle.raw())?;
        let started = unsafe {
            ReadFile(
                self.handle.raw(),
                data.as_mut_ptr(),
                data.len() as u32,
                null_mut(),
                &mut *io.overlapped,
            )
        };
        let size = match io.finish(started, timeout) {
            Err(Error("native-channel-deadline")) => return Ok(None),
            other => other?,
        } as usize;
        if size == 0 {
            return Err(Error("native-channel-closed"));
        }
        if self.buffer.len() + size > crate::channel_wire::MAX_FRAME + 32768 {
            return Err(Error("native-channel-frame-bound"));
        }
        self.buffer.extend(&data[..size]);
        if self.partial_since.is_none() {
            self.partial_since = Some(Instant::now());
        }
        self.take_frame()
    }
    pub(crate) fn write(&self, value: &serde_json::Value, timeout: Duration) -> Result<()> {
        let data = crate::channel_wire::encode(value)?;
        self.write_bytes(&data, timeout)
    }
    pub(crate) fn read_bytes(&self, timeout: Duration) -> Result<Vec<u8>> {
        let mut data = vec![0u8; 32768];
        let mut io = Io::new(self.handle.raw())?;
        let started = unsafe {
            ReadFile(
                self.handle.raw(),
                data.as_mut_ptr(),
                data.len() as u32,
                null_mut(),
                &mut *io.overlapped,
            )
        };
        let size = match io.finish(started, timeout) {
            Err(Error("native-channel-deadline")) => return Ok(vec![]),
            other => other?,
        } as usize;
        if size == 0 {
            return Err(Error("native-channel-closed"));
        }
        data.truncate(size);
        Ok(data)
    }
    pub(crate) fn write_bytes(&self, data: &[u8], timeout: Duration) -> Result<()> {
        if data.len() > crate::channel_wire::MAX_FRAME + 98 {
            return Err(Error("native-channel-frame-bound"));
        }
        let mut offset = 0;
        let end = Instant::now() + timeout;
        while offset < data.len() {
            let mut io = Io::new(self.handle.raw())?;
            let started = unsafe {
                WriteFile(
                    self.handle.raw(),
                    data[offset..].as_ptr(),
                    (data.len() - offset) as u32,
                    null_mut(),
                    &mut *io.overlapped,
                )
            };
            let count = io.finish(started, end.saturating_duration_since(Instant::now()))? as usize;
            if count == 0 {
                return Err(Error("native-channel-closed"));
            }
            offset += count;
        }
        Ok(())
    }
    pub(crate) fn open(name: &str) -> Result<Self> {
        if !name
            .strip_prefix("\\\\.\\pipe\\codenomad-runtime-v1-")
            .is_some_and(crate::channel_wire::is_hex)
        {
            return Err(Error("native-channel-locator-invalid"));
        }
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        let handle = unsafe {
            Handle::take(CreateFileW(
                wide.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            ))?
        };
        crate::security::verify_private_kernel(handle.raw())?;
        Ok(Self {
            handle,
            name: name.into(),
            buffer: vec![],
            partial_since: None,
        })
    }
    pub(crate) fn server_pid(&self) -> Result<u32> {
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(self.handle.raw(), &mut pid) } == 0 || pid == 0 {
            return Err(Error("native-channel-source-unknown"));
        }
        Ok(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Peer(std::process::Child);
    impl Drop for Peer {
        fn drop(&mut self) {
            if !matches!(self.0.try_wait(), Ok(Some(_))) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }
    #[test]
    fn private_pipe_native_owner_dacl_noninherit_and_actual_spoof_pid() {
        let mut server = NamedChannel::new().unwrap();
        crate::security::verify_private_kernel(server.handle.raw()).unwrap();
        let mut child=Peer(std::process::Command::new("C:/Program Files/nodejs/node.exe")
            .args(["-e","const s=require('net').connect(process.argv[1]);s.on('error',()=>process.exit(0));s.on('close',()=>process.exit(0));setTimeout(()=>process.exit(1),4000)",&server.name])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap());
        server.connect(Duration::from_secs(3)).unwrap();
        assert_eq!(server.client_pid().unwrap(), child.0.id());
        assert_ne!(server.client_pid().unwrap(), std::process::id());
        server.disconnect();
        assert!(child.0.wait().unwrap().success());
    }
}
