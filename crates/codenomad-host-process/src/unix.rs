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
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(true)
        } else {
            Err(error)
        }
    }
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: the child was created as this group leader before exec, and
        // this handle never attaches to any pre-existing process group.
        if unsafe { libc::kill(-self.leader, libc::SIGKILL) } == 0 {
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
