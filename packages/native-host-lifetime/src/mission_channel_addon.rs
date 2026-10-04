//! Tagged native Missions objects. Neither constructor nor caller-field admission
//! is exported. Current `openMissionsChannel` always rejects missing producers.
use crate::addon_api::*;
use crate::mission_channel::{self, Channel, CommitGuard, HumanLease, Registration};
use crate::{Error, Result};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex, OnceLock,
};

const MAX_HANDLES: usize = 256;
const TAGS: [TypeTag; 4] = [
    TypeTag {
        lower: 0x434e4d4348414e4e,
        upper: 0x0001000000000001,
    },
    TypeTag {
        lower: 0x434e4d5245474953,
        upper: 0x0001000000000001,
    },
    TypeTag {
        lower: 0x434e4d484c454153,
        upper: 0x0001000000000001,
    },
    TypeTag {
        lower: 0x434e4d4347554152,
        upper: 0x0001000000000001,
    },
];
#[derive(Clone)]
enum Handle {
    Channel(Channel),
    Registration(Registration),
    Lease(HumanLease),
    Guard(CommitGuard),
}
impl Handle {
    fn kind(&self) -> usize {
        match self {
            Self::Channel(_) => 0,
            Self::Registration(_) => 1,
            Self::Lease(_) => 2,
            Self::Guard(_) => 3,
        }
    }
    fn dispose(&self) -> Result<()> {
        match self {
            Self::Channel(c) => c.dispose(),
            // Inventory loans do not own the producer's registration. Removing
            // the wrapped Entry releases this loan; native producer revocation is
            // a separate guardian lifecycle, never proof of writer quiescence.
            Self::Registration(_) => Ok(()),
            Self::Lease(l) => l.dispose(),
            Self::Guard(g) => g.dispose(),
        }
    }
}
struct Entry {
    env: usize,
    handle: Handle,
}
static HANDLES: OnceLock<Mutex<HashMap<usize, Entry>>> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(1);
fn handles() -> &'static Mutex<HashMap<usize, Entry>> {
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) unsafe fn failure(env: Env, code: &'static str) -> Value {
    let mut out = std::ptr::null_mut();
    if let Ok(message) = string(env, code) {
        napi_create_error(env, message, message, &mut out);
    }
    out
}
unsafe fn invoke(env: Env, f: impl FnOnce() -> Result<Value>) -> Value {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .unwrap_or(Err(Error("native-missions-panic-fenced")))
    {
        Ok(value) => value,
        Err(Error(code)) => {
            let code = std::ffi::CString::new(code).unwrap();
            napi_throw_error(env, code.as_ptr(), code.as_ptr());
            undefined(env)
        }
    }
}
unsafe fn tagged_id(env: Env, value: Value) -> Result<(usize, usize)> {
    for (kind, tag) in TAGS.iter().enumerate() {
        let mut tagged = false;
        check(napi_check_object_type_tag(env, value, tag, &mut tagged))?;
        if tagged {
            let mut id = std::ptr::null_mut();
            check(napi_unwrap(env, value, &mut id))?;
            return Ok((id as usize, kind));
        }
    }
    Err(Error("native-missions-tagged-capability-required"))
}
unsafe fn handle(env: Env, value: Value, kind: usize) -> Result<Handle> {
    let (id, actual) = tagged_id(env, value)?;
    if actual != kind {
        return Err(Error("native-missions-capability-kind-mismatch"));
    }
    let map = handles()
        .lock()
        .map_err(|_| Error("native-missions-handles-poisoned"))?;
    let entry = map
        .get(&id)
        .filter(|e| e.env == env as usize && e.handle.kind() == kind)
        .ok_or(Error("native-missions-capability-released"))?;
    Ok(entry.handle.clone())
}
unsafe fn channel(env: Env, value: Value) -> Result<Channel> {
    match handle(env, value, 0)? {
        Handle::Channel(c) => Ok(c),
        _ => unreachable!(),
    }
}
unsafe fn registration(env: Env, value: Value) -> Result<Registration> {
    match handle(env, value, 1)? {
        Handle::Registration(r) => Ok(r),
        _ => unreachable!(),
    }
}
unsafe fn lease(env: Env, value: Value) -> Result<HumanLease> {
    match handle(env, value, 2)? {
        Handle::Lease(l) => Ok(l),
        _ => unreachable!(),
    }
}
unsafe fn guard(env: Env, value: Value) -> Result<CommitGuard> {
    match handle(env, value, 3)? {
        Handle::Guard(g) => Ok(g),
        _ => unreachable!(),
    }
}
unsafe extern "C" fn finalize(env: Env, data: *mut c_void, _hint: *mut c_void) {
    let removed = handles().lock().ok().and_then(|mut map| {
        if map
            .get(&(data as usize))
            .is_some_and(|e| e.env == env as usize)
        {
            map.remove(&(data as usize))
        } else {
            None
        }
    });
    if let Some(e) = removed {
        // Inventory registration handles are borrowed views. Garbage collection
        // must not unregister the producer's retained writer. Explicit release
        // likewise releases only the loan; native registration revocation differs.
        if !matches!(e.handle, Handle::Registration(_)) {
            let _ = e.handle.dispose();
        }
    }
}
unsafe fn wrap(env: Env, h: Handle) -> Result<Value> {
    let kind = h.kind();
    let rollback = h.clone();
    let result = (|| {
        let id = NEXT
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .map_err(|_| Error("native-missions-handles-capacity"))?;
        {
            let mut map = handles()
                .lock()
                .map_err(|_| Error("native-missions-handles-poisoned"))?;
            if map.len() >= MAX_HANDLES {
                return Err(Error("native-missions-handles-capacity"));
            }
            map.insert(
                id,
                Entry {
                    env: env as usize,
                    handle: h,
                },
            );
        }
        let result = (|| {
            let object = object(env)?;
            check(napi_type_tag_object(env, object, &TAGS[kind]))?;
            check(napi_wrap(
                env,
                object,
                id as *mut c_void,
                Some(finalize),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ))?;
            Ok(object)
        })();
        if result.is_err() {
            finalize(env, id as *mut c_void, std::ptr::null_mut());
        }
        result
    })();
    if result.is_err() && !matches!(rollback, Handle::Registration(_)) {
        let _ = rollback.dispose();
    }
    result
}
pub(crate) unsafe fn wrap_channel(env: Env, c: Channel) -> Result<Value> {
    wrap(env, Handle::Channel(c))
}

unsafe extern "C" fn open(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 2)?;
        let native_session = crate::addon::session(env, a[0])?;
        let challenge = bytes(env, a[1], 32)?;
        if challenge.len() != 32 {
            return Err(Error("native-missions-challenge-bound"));
        }
        crate::addon::queue(
            env,
            crate::addon::Operation::OpenMissions(native_session, challenge),
        )
    })
}
unsafe extern "C" fn assert_channel(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        channel(env, a[0])?.assert()?;
        Ok(undefined(env))
    })
}
unsafe extern "C" fn assert_registration(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 2)?;
        channel(env, a[0])?.assert_registration(&registration(env, a[1])?)?;
        Ok(undefined(env))
    })
}
unsafe extern "C" fn inventory(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        let c = channel(env, a[0])?;
        let registrations = c.inventory()?;
        let count = registrations.len();
        // Numeric indexes on a native-created array, not JSON authority. Repeated
        // views do not revoke registrations when their JS wrappers are collected.
        let out = json(env, &serde_json::json!([]))?;
        for (index, r) in registrations.into_iter().enumerate() {
            set(
                env,
                out,
                &index.to_string(),
                wrap(env, Handle::Registration(r))?,
            )?;
        }
        set(env, out, "length", json(env, &serde_json::json!(count))?)?;
        c.assert()?;
        Ok(out)
    })
}
unsafe extern "C" fn acquire(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 3)?;
        let mut ms = 0.0;
        check(napi_get_value_double(env, a[2], &mut ms))?;
        if !ms.is_finite() || ms.fract() != 0.0 || ms < 1.0 || ms > 30_000.0 {
            return Err(Error("native-missions-human-lease-deadline-bound"));
        }
        let l = channel(env, a[0])?.acquire(&registration(env, a[1])?, ms as u64)?;
        wrap(env, Handle::Lease(l))
    })
}
unsafe extern "C" fn writer_inventory(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        json(env, &channel(env, a[0])?.writer_inventory()?)
    })
}
unsafe extern "C" fn assert_quiescence(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        channel(env, a[0])?.assert_quiescence()?;
        Ok(undefined(env))
    })
}
unsafe extern "C" fn assert_lease(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        lease(env, a[0])?.assert()?;
        Ok(undefined(env))
    })
}
unsafe extern "C" fn begin(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 3)?;
        let g = channel(env, a[0])?.begin(&registration(env, a[1])?, &lease(env, a[2])?)?;
        wrap(env, Handle::Guard(g))
    })
}
unsafe extern "C" fn assert_guard(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        guard(env, a[0])?.assert()?;
        Ok(undefined(env))
    })
}
unsafe extern "C" fn commit(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        guard(env, a[0])?.commit()?;
        Ok(undefined(env))
    })
}
unsafe extern "C" fn release(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = crate::addon::arguments(env, info, 1)?;
        let (id, kind) = tagged_id(env, a[0])?;
        let entry = {
            let mut map = handles()
                .lock()
                .map_err(|_| Error("native-missions-handles-poisoned"))?;
            if map
                .get(&id)
                .is_some_and(|e| e.env != env as usize || e.handle.kind() != kind)
            {
                return Err(Error("native-missions-capability-owner-mismatch"));
            }
            map.remove(&id)
        };
        if let Some(entry) = entry {
            entry.handle.dispose()?;
        }
        Ok(undefined(env))
    })
}
pub(crate) unsafe fn register(env: Env, exports: Value) -> Result<()> {
    set(
        env,
        exports,
        "missionsProtocol",
        string(env, mission_channel::PROTOCOL)?,
    )?;
    for (name, callback) in [
        (
            "openMissionsChannel",
            open as unsafe extern "C" fn(Env, Info) -> Value,
        ),
        ("missionsAssertChannel", assert_channel),
        ("missionsInventory", inventory),
        ("missionsReadWriterInventory", writer_inventory),
        ("missionsAssertQuiescence", assert_quiescence),
        ("missionsAssertRegistration", assert_registration),
        ("missionsAcquireHumanLease", acquire),
        ("missionsAssertHumanLease", assert_lease),
        ("missionsBeginCommit", begin),
        ("missionsAssertCommitGuard", assert_guard),
        ("missionsCommit", commit),
        ("missionsRelease", release),
    ] {
        set(
            env,
            exports,
            name,
            crate::addon::function(env, Some(callback))?,
        )?;
    }
    Ok(())
}
