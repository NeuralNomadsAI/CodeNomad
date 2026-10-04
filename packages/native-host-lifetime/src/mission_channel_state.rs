//! All admission, revocation and irreversible effect linearization share one lock.
use super::*;
use std::time::Duration;

impl State {
    pub(super) fn next(&mut self) -> Result<u64> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or(Error("native-missions-capacity"))?;
        Ok(self.next)
    }
    pub(super) fn channel(&self, id: u64) -> Result<&ChannelEntry> {
        let c = self
            .channels
            .get(&id)
            .ok_or(Error("native-missions-channel-revoked"))?;
        c.evidence.revalidate()?;
        Ok(c)
    }
    fn registration(&self, id: u64) -> Result<&RegistrationEntry> {
        let r = self
            .registrations
            .get(&id)
            .ok_or(Error("native-missions-registration-revoked"))?;
        let c = self.channel(r.channel)?;
        r.evidence.revalidate()?;
        if r.evidence.binding != c.evidence.binding {
            return Err(Error("native-missions-registration-provenance-mismatch"));
        }
        Ok(r)
    }
    fn lease(&self, id: u64) -> Result<&LeaseEntry> {
        let l = self
            .leases
            .get(&id)
            .ok_or(Error("native-missions-human-lease-revoked"))?;
        let r = self.registration(l.registration)?;
        r.evidence.revalidate_human()?;
        if l.human_origin != r.evidence.binding.human_origin {
            return Err(Error("native-missions-human-origin-binding"));
        }
        if Instant::now() >= l.expires {
            return Err(Error("native-missions-human-lease-expired"));
        }
        Ok(l)
    }
    fn guard(&self, id: u64) -> Result<&GuardEntry> {
        let g = self
            .guards
            .get(&id)
            .ok_or(Error("native-missions-commit-guard-revoked"))?;
        if self.lease(g.lease)?.registration != g.registration {
            return Err(Error("native-missions-commit-guard-binding"));
        }
        Ok(g)
    }
    fn revoke_registration(&mut self, id: u64) {
        if let Some(r) = self.registrations.remove(&id) {
            // Losing/releasing a capability is NOT runtime writer disposal.
            self.inventory.mark_unknown(&r.evidence.binding);
        }
        self.leases.retain(|_, l| l.registration != id);
        self.guards.retain(|_, g| g.registration != id);
    }
    fn revoke_channel(&mut self, id: u64) {
        self.channels.remove(&id);
        let ids: Vec<_> = self
            .registrations
            .iter()
            .filter(|(_, r)| r.channel == id)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.revoke_registration(id);
        }
    }
    pub(super) fn reap(&mut self) {
        let channels: Vec<_> = self
            .channels
            .keys()
            .copied()
            .filter(|id| self.channel(*id).is_err())
            .collect();
        for id in channels {
            self.revoke_channel(id);
        }
        let registrations: Vec<_> = self
            .registrations
            .keys()
            .copied()
            .filter(|id| self.registration(*id).is_err())
            .collect();
        for id in registrations {
            self.revoke_registration(id);
        }
        let leases: Vec<_> = self
            .leases
            .keys()
            .copied()
            .filter(|id| self.lease(*id).is_err())
            .collect();
        for id in leases {
            self.leases.remove(&id);
            self.guards.retain(|_, g| g.lease != id);
        }
    }
}
impl Channel {
    pub(crate) fn assert(&self) -> Result<()> {
        self.guardian.lock()?.channel(self.id).map(|_| ())
    }
    /// Bounded live capability loans. This is NOT a complete runtime inventory
    /// and cannot prove quiescence or certify a missing/disposed writer.
    pub(crate) fn inventory(&self) -> Result<Vec<Registration>> {
        let mut s = self.guardian.lock()?;
        s.reap();
        s.channel(self.id)?;
        let mut ids: Vec<_> = s
            .registrations
            .iter()
            .filter(|(_, r)| r.channel == self.id)
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        Ok(ids
            .into_iter()
            .map(|id| Registration {
                guardian: self.guardian.clone(),
                id,
            })
            .collect())
    }
    pub(crate) fn assert_registration(&self, registration: &Registration) -> Result<()> {
        same(&self.guardian, &registration.guardian)?;
        let s = self.guardian.lock()?;
        s.channel(self.id)?;
        if s.registration(registration.id)?.channel != self.id {
            return Err(Error("native-missions-registration-channel-mismatch"));
        }
        Ok(())
    }
    pub(crate) fn acquire(
        &self,
        registration: &Registration,
        milliseconds: u64,
    ) -> Result<HumanLease> {
        same(&self.guardian, &registration.guardian)?;
        if milliseconds == 0 || milliseconds > MAX_LEASE_MS {
            return Err(Error("native-missions-human-lease-deadline-bound"));
        }
        let mut s = self.guardian.lock()?;
        s.reap();
        s.channel(self.id)?;
        if s.registration(registration.id)?.channel != self.id {
            return Err(Error("native-missions-registration-channel-mismatch"));
        }
        let binding = &s.registration(registration.id)?.evidence.binding;
        s.registration(registration.id)?
            .evidence
            .revalidate_human()?;
        let human_origin = binding.human_origin;
        if s.leases.values().any(|l| {
            s.registration(l.registration)
                .is_ok_and(|r| r.evidence.binding.same_write_domain(binding))
        }) {
            return Err(Error("native-missions-human-lease-held"));
        }
        if s.leases.len() >= CAPACITY {
            return Err(Error("native-missions-capacity"));
        }
        let id = s.next()?;
        s.leases.insert(
            id,
            LeaseEntry {
                registration: registration.id,
                human_origin,
                expires: Instant::now() + Duration::from_millis(milliseconds),
            },
        );
        Ok(HumanLease {
            guardian: self.guardian.clone(),
            id,
        })
    }
    pub(crate) fn begin(
        &self,
        registration: &Registration,
        lease: &HumanLease,
    ) -> Result<CommitGuard> {
        same(&self.guardian, &registration.guardian)?;
        same(&self.guardian, &lease.guardian)?;
        let mut s = self.guardian.lock()?;
        s.reap();
        s.channel(self.id)?;
        if s.registration(registration.id)?.channel != self.id
            || s.lease(lease.id)?.registration != registration.id
        {
            return Err(Error("native-missions-commit-guard-binding"));
        }
        if s.guards.values().any(|g| g.registration == registration.id) {
            return Err(Error("native-missions-commit-guard-held"));
        }
        if s.guards.len() >= CAPACITY {
            return Err(Error("native-missions-capacity"));
        }
        let id = s.next()?;
        s.guards.insert(
            id,
            GuardEntry {
                registration: registration.id,
                lease: lease.id,
            },
        );
        Ok(CommitGuard {
            guardian: self.guardian.clone(),
            id,
        })
    }
    pub(crate) fn dispose(&self) -> Result<()> {
        self.guardian.lock()?.revoke_channel(self.id);
        Ok(())
    }
    pub(crate) fn writer_inventory(&self) -> Result<serde_json::Value> {
        let s = self.guardian.lock()?;
        s.channel(self.id)?;
        Ok(s.inventory.projection())
    }
    pub(crate) fn assert_quiescence(&self) -> Result<()> {
        let s = self.guardian.lock()?;
        let binding = &s.channel(self.id)?.evidence.binding;
        s.inventory.assert_quiescence(binding)
    }
}
impl Registration {
    pub(crate) fn dispose(&self) -> Result<()> {
        self.guardian.lock()?.revoke_registration(self.id);
        Ok(())
    }
}
impl HumanLease {
    pub(crate) fn assert(&self) -> Result<()> {
        self.guardian.lock()?.lease(self.id).map(|_| ())
    }
    pub(crate) fn dispose(&self) -> Result<()> {
        let mut s = self.guardian.lock()?;
        s.leases.remove(&self.id);
        s.guards.retain(|_, g| g.lease != self.id);
        Ok(())
    }
}
impl CommitGuard {
    /// Diagnostic only. JS must NOT put `await storage.set` after this check and
    /// claim atomic publication. Irreversible effects require the native method.
    pub(crate) fn assert(&self) -> Result<()> {
        self.guardian.lock()?.guard(self.id).map(|_| ())
    }
    pub(crate) fn dispose(&self) -> Result<()> {
        self.guardian.lock()?.guards.remove(&self.id);
        Ok(())
    }
    pub(crate) fn commit(&self) -> Result<()> {
        let mut s = self.guardian.lock()?;
        s.guard(self.id)?;
        s.guards.remove(&self.id); // One-shot even on unavailable publication.
        Err(Error(
            "native-missions-storage-transaction-producer-unavailable",
        ))
    }
    /// Tests exercise the linearization primitive with a synchronous fake effect.
    /// Production has no callable generic effect executor or JS callback path.
    #[cfg(test)]
    pub(super) fn test_native_effect<T>(&self, effect: impl FnOnce() -> Result<T>) -> Result<T> {
        let mut s = self.guardian.lock()?;
        s.guard(self.id)?;
        s.guards.remove(&self.id); // consume BEFORE invoking, including failure/panic
        effect() // lock retained; revocation cannot return before this effect ends
    }
}
