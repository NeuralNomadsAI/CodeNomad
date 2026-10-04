//! Production S/channel factory. The fixture variant has native, narrower facts.
use crate::bound_channel::BoundChannel;
#[cfg(feature = "fixtures")]
use crate::handle::identity;
#[cfg(feature = "fixtures")]
use crate::handle::in_job;
use crate::handle::require_outside;
#[cfg(feature = "fixtures")]
use crate::runtime_core::PendingRuntime;
use crate::runtime_core::RuntimeCore;
use crate::supervisor_config::SupervisorConfig;
#[cfg(feature = "fixtures")]
use crate::Identity;
use crate::{Error, OwnerBootstrap, Process, Result, RuntimeMember, RuntimeSession};
use std::sync::Arc;
use std::time::Duration;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

pub(crate) enum Authority {
    Independent(RuntimeSession),
    #[cfg(feature = "fixtures")]
    Nested {
        runtime: RuntimeCore,
        own: Identity,
    },
}
impl Authority {
    pub(crate) fn independent(&self) -> bool {
        matches!(self, Self::Independent(_))
    }
    pub(crate) fn core(&self) -> &RuntimeCore {
        match self {
            Self::Independent(s) => &s.core,
            #[cfg(feature = "fixtures")]
            Self::Nested { runtime, .. } => runtime,
        }
    }
    pub(crate) fn revalidate(&self) -> Result<()> {
        match self {
            Self::Independent(s) => s.revalidate(),
            #[cfg(feature = "fixtures")]
            Self::Nested { runtime, own } => {
                if identity(unsafe { GetCurrentProcess() })? != *own
                    || !in_job(unsafe { GetCurrentProcess() }, std::ptr::null_mut())?
                {
                    return Err(Error("native-fixture-outer-owner-changed"));
                }
                runtime.revalidate()
            }
        }
    }
    pub(crate) fn manager(&self) -> &Process {
        self.core().manager()
    }
    pub(crate) fn observe(&self, pid: u32) -> Result<RuntimeMember> {
        self.revalidate()?;
        self.core().observe(pid)
    }
    pub(crate) fn close(&self) {
        self.core().close();
    }
    pub(crate) fn require_external(&self, process: &Process) -> Result<()> {
        process.revalidate()?;
        match self {
            Self::Independent(_) => {
                require_outside(unsafe { GetCurrentProcess() })?;
                require_outside(process.handle.raw())?;
            }
            #[cfg(feature = "fixtures")]
            Self::Nested { .. } => {
                self.revalidate()?;
                if self.core().contains(process)? {
                    return Err(Error("native-service-inside-runtime-job"));
                }
            }
        }
        Ok(())
    }
    pub(crate) fn require_external_member(&self, member: &RuntimeMember) -> Result<()> {
        member.revalidate()?;
        if self.independent() {
            require_outside(member.raw())?;
        } else {
            #[cfg(feature = "fixtures")]
            if self.core().contains_member(member)? {
                return Err(Error("native-service-inside-runtime-job"));
            }
        }
        Ok(())
    }
}
pub struct SupervisedRuntime {
    pub(crate) authority: Arc<Authority>,
    pub(crate) manager_channel: BoundChannel,
    #[cfg(feature = "fixtures")]
    pub(crate) config: SupervisorConfig,
    pub(crate) services: Option<crate::service_channel::Services>,
}
impl SupervisedRuntime {
    pub fn start(bootstrap: OwnerBootstrap, config: SupervisorConfig) -> Result<Self> {
        config.validate()?;
        let session = RuntimeSession::start(
            bootstrap,
            &config.manager.command()?,
            Duration::from_secs(5),
        )?;
        let mut channel = BoundChannel::new(
            session.manager(),
            "manager",
            &config.profile,
            &config.generation,
            config.application.clone(),
        )?;
        let authority = Arc::new(Authority::Independent(session));
        let services = config
            .broker
            .as_ref()
            .map(|c| {
                crate::service_channel::Services::start(c, authority.clone(), &mut channel.boot)
            })
            .transpose()?;
        authority
            .core()
            .publish_channel(&channel.bootstrap_bytes()?)?;
        Ok(Self {
            authority,
            manager_channel: channel,
            #[cfg(feature = "fixtures")]
            config,
            services,
        })
    }
    pub fn serve(self) -> Result<()> {
        crate::supervisor_dispatch::serve(self)
    }
    #[cfg(feature = "fixtures")]
    pub(crate) fn nested_fixture(config: SupervisorConfig) -> Result<Self> {
        config.validate()?;
        let own = identity(unsafe { GetCurrentProcess() })?;
        if !in_job(unsafe { GetCurrentProcess() }, std::ptr::null_mut())? {
            return Err(Error("native-fixture-outer-job-required"));
        }
        let mut core = PendingRuntime::prepare(&config.manager.command()?)?.resume()?;
        core.authenticate(Duration::from_secs(5))?;
        let mut channel = BoundChannel::new(
            core.manager(),
            "manager",
            &config.profile,
            &config.generation,
            config.application.clone(),
        )?;
        let authority = Arc::new(Authority::Nested { runtime: core, own });
        let services = config
            .broker
            .as_ref()
            .map(|c| {
                crate::service_channel::Services::start(c, authority.clone(), &mut channel.boot)
            })
            .transpose()?;
        authority
            .core()
            .publish_channel(&channel.bootstrap_bytes()?)?;
        Ok(Self {
            authority,
            manager_channel: channel,
            config,
            services,
        })
    }
}
impl Drop for SupervisedRuntime {
    fn drop(&mut self) {
        self.authority.close();
    }
}

pub fn launch_supervisor(
    command: &crate::Command,
    config: &SupervisorConfig,
) -> Result<crate::AuthenticatedManager> {
    config.validate()?;
    if !command.args.is_empty() {
        return Err(Error("native-supervisor-argv-refused"));
    }
    let data = serde_json::to_vec(config).map_err(|_| Error("native-supervisor-config-invalid"))?;
    if data.len() > 4000 {
        return Err(Error("native-supervisor-config-bound"));
    }
    let mut owner = crate::launch_independent(command)?.authenticate(Duration::from_secs(5))?;
    let mut frame = (data.len() as u32).to_le_bytes().to_vec();
    frame.extend(data);
    if let Err(e) = owner.child.write_bootstrap(&frame) {
        owner.child.process().terminate_owned()?;
        return Err(e);
    }
    Ok(owner)
}
