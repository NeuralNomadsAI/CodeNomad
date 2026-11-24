use std::{
    io,
    os::unix::process::CommandExt,
    process::{Child, Command},
};
pub(super) struct Family {
    leader: i32,
}
impl Family {
    pub fn prepare(command: &mut Command) {
        command.process_group(0);
    }
    pub fn adopt(child: &mut Child) -> io::Result<Self> {
        let leader = i32::try_from(child.id())
            .map_err(|_| io::Error::other("Invalid process group leader"))?;
        Ok(Self { leader })
    }
    pub fn empty(&self) -> io::Result<bool> {
        // SAFETY: kill with signal zero only queries our spawn's process group.
        let result = unsafe { libc::kill(-self.leader, 0) };
        if result == 0 {
            return Ok(false);
        }
        query_error(io::Error::last_os_error())
    }
    pub fn terminate(&self) -> io::Result<()> {
        self.signal(libc::SIGKILL)
    }
    pub fn signal_term(&self) -> io::Result<()> {
        self.signal(libc::SIGTERM)
    }
    fn signal(&self, sig: libc::c_int) -> io::Result<()> {
        // SAFETY: the child was created as this group leader before exec, and
        // this handle never attaches to any pre-existing process group.
        if unsafe { libc::kill(-self.leader, sig) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

fn query_error(error: io::Error) -> io::Result<bool> {
    match error.raw_os_error() {
        Some(libc::ESRCH) => Ok(true),
        // XNU may retain a group containing only unreaped zombies (killpg1).
        Some(libc::EPERM) => Ok(false),
        _ => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_group_proves_empty() {
        assert!(query_error(io::Error::from_raw_os_error(libc::ESRCH)).unwrap());
        assert!(!query_error(io::Error::from_raw_os_error(libc::EPERM)).unwrap());
        assert_eq!(
            query_error(io::Error::from_raw_os_error(libc::EINVAL))
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EINVAL)
        );
    }
}
