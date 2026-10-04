use crate::handle::Handle;
use crate::{Error, Result};
use std::mem::size_of;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
};
use windows_sys::Win32::Security::*;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub(crate) struct Local(pub *mut std::ffi::c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
pub(crate) fn token_user() -> Result<Vec<usize>> {
    let mut raw = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(Error("native-principal-unknown"));
    }
    let token = unsafe { Handle::take(raw)? };
    let mut bytes = 0;
    unsafe {
        GetTokenInformation(token.raw(), TokenUser, null_mut(), 0, &mut bytes);
    }
    if bytes < size_of::<TOKEN_USER>() as u32 || bytes > 4096 {
        return Err(Error("native-principal-unknown"));
    }
    let mut user = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            user.as_mut_ptr() as _,
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(Error("native-principal-unknown"));
    }
    Ok(user)
}
pub(crate) fn private_descriptor() -> Result<Local> {
    let user = token_user()?;
    let sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(Error("native-principal-unknown"));
    }
    let _text = Local(text as _);
    let mut length = 0;
    while length < 184 && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    if length == 184 {
        return Err(Error("native-principal-unknown"));
    }
    let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| Error("native-principal-unknown"))?;
    // New kernel object only. Never alter an existing user's file/directory ACL.
    let sddl: Vec<u16> = format!("O:{sid}D:P(A;;GA;;;{sid})(A;;GA;;;SY)\0")
        .encode_utf16()
        .collect();
    let mut descriptor = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    } == 0
    {
        return Err(Error("native-private-descriptor-unavailable"));
    }
    Ok(Local(descriptor))
}

pub(crate) fn verify_private_kernel(handle: windows_sys::Win32::Foundation::HANDLE) -> Result<()> {
    verify_private_pipe(handle, false)
}
pub(crate) fn verify_private_pipe(
    handle: windows_sys::Win32::Foundation::HANDLE,
    inherited: bool,
) -> Result<()> {
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    let (mut owner, mut dacl, mut descriptor) = (null_mut(), null_mut(), null_mut());
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    } != 0
    {
        return Err(Error("native-channel-security-unknown"));
    }
    let _descriptor = Local(descriptor);
    let user = token_user()?;
    let sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
    let (mut control, mut revision) = (0, 0);
    if owner.is_null()
        || dacl.is_null()
        || unsafe { EqualSid(owner, sid) } == 0
        || unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || unsafe { (*dacl).AceCount } != 2
    {
        return Err(Error("native-channel-security-unproven"));
    }
    let mut system = [0usize; 16];
    let mut size = size_of_val(&system) as u32;
    if unsafe {
        CreateWellKnownSid(
            WinLocalSystemSid,
            null_mut(),
            system.as_mut_ptr() as _,
            &mut size,
        )
    } == 0
    {
        return Err(Error("native-channel-security-unknown"));
    }
    for i in 0..2 {
        let mut ace = null_mut();
        if unsafe { GetAce(dacl, i, &mut ace) } == 0 {
            return Err(Error("native-channel-security-unknown"));
        }
        let ace = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        let allowed = &ace.SidStart as *const u32 as _;
        if ace.Header.AceType != 0
            || ace.Header.AceFlags != 0
            || (unsafe { EqualSid(allowed, sid) } == 0
                && unsafe { EqualSid(allowed, system.as_mut_ptr() as _) } == 0)
        {
            return Err(Error("native-channel-security-unproven"));
        }
    }
    let mut flags = 0;
    if unsafe { windows_sys::Win32::Foundation::GetHandleInformation(handle, &mut flags) } == 0
        || (!inherited && flags & windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT != 0)
    {
        return Err(Error("native-channel-inherited-handle"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    #[test]
    fn actual_private_pipe_owner_and_allow_aces_are_current_principal_and_system_only() {
        let (read, _write) = crate::pipe::pair().unwrap();
        let (mut owner, mut dacl, mut descriptor) = (null_mut(), null_mut(), null_mut());
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    read.raw(),
                    SE_KERNEL_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    null_mut(),
                    &mut dacl,
                    null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let _descriptor = Local(descriptor);
        let user = token_user().unwrap();
        let user_sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
        assert_ne!(unsafe { EqualSid(owner, user_sid) }, 0);
        assert!(!dacl.is_null());
        assert_eq!(unsafe { (*dacl).AceCount }, 2);
        let mut system = [0usize; 16];
        let mut size = size_of_val(&system) as u32;
        assert_ne!(
            unsafe {
                CreateWellKnownSid(
                    WinLocalSystemSid,
                    null_mut(),
                    system.as_mut_ptr() as _,
                    &mut size,
                )
            },
            0
        );
        for index in 0..2 {
            let mut ace = null_mut();
            assert_ne!(unsafe { GetAce(dacl, index, &mut ace) }, 0);
            let ace = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
            assert_eq!(ace.Header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
            let sid = &ace.SidStart as *const u32 as _;
            assert!(
                unsafe { EqualSid(sid, user_sid) } != 0
                    || unsafe { EqualSid(sid, system.as_mut_ptr() as _) } != 0
            );
        }
    }
}
