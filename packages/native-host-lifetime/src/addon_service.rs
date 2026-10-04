//! Private outside-peer methods. Not a generic executable or ChildProcess ABI.
use crate::addon::{arguments, invoke, queue, session, Operation};
use crate::addon_api::*;
use crate::service_starter::OwnedStarter;
use crate::{Error, Result};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex, OnceLock,
};
static STARTERS: OnceLock<Mutex<HashMap<usize, OwnedStarter>>> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(1);
static OPENED: AtomicBool = AtomicBool::new(false);
static TAG: TypeTag = TypeTag {
    lower: 0x434e485253544152,
    upper: 0x0001000000000001,
};
fn map() -> &'static Mutex<HashMap<usize, OwnedStarter>> {
    STARTERS.get_or_init(|| Mutex::new(HashMap::new()))
}
unsafe extern "C" fn finalize(_env: Env, data: *mut c_void, _hint: *mut c_void) {
    if let Ok(mut m) = map().lock() {
        m.remove(&(data as usize));
    }
}
pub(crate) unsafe fn wrap(env: Env, s: OwnedStarter) -> Result<Value> {
    let mut m = map()
        .lock()
        .map_err(|_| Error("native-service-map-poisoned"))?;
    if m.len() >= 16 {
        return Err(Error("native-service-starter-capacity"));
    }
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let obj = object(env)?;
    check(napi_type_tag_object(env, obj, &TAG))?;
    check(napi_wrap(
        env,
        obj,
        id as *mut c_void,
        Some(finalize),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    ))?;
    m.insert(id, s);
    Ok(obj)
}
unsafe fn owned(env: Env, value: Value) -> Result<OwnedStarter> {
    let mut tagged = false;
    check(napi_check_object_type_tag(env, value, &TAG, &mut tagged))?;
    if !tagged {
        return Err(Error("native-service-starter-required"));
    }
    let mut id = std::ptr::null_mut();
    check(napi_unwrap(env, value, &mut id))?;
    map()
        .lock()
        .map_err(|_| Error("native-service-map-poisoned"))?
        .get(&(id as usize))
        .cloned()
        .ok_or(Error("native-service-starter-required"))
}
unsafe extern "C" fn open(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        let nonce = bytes(env, a[0], 32)?;
        if nonce.len() != 32 || OPENED.swap(true, Ordering::AcqRel) {
            return Err(Error("native-service-peer-open-once"));
        }
        queue(env, Operation::OpenPeer(nonce))
    })
}
unsafe extern "C" fn start(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 3)?;
        queue(
            env,
            Operation::Start(
                session(env, a[0])?,
                bytes(env, a[1], 4096)?,
                bytes(env, a[2], crate::service_permit::MAX_REQUEST)?,
            ),
        )
    })
}
unsafe extern "C" fn read(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 2)?;
        let err = text(env, a[1], 6)?;
        if !["stdout", "stderr"].contains(&err.as_str()) {
            return Err(Error("native-service-stream-invalid"));
        }
        queue(
            env,
            Operation::StarterRead(owned(env, a[0])?, err == "stderr"),
        )
    })
}
unsafe extern "C" fn wait(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        queue(env, Operation::StarterStatus(owned(env, a[0])?))
    })
}
unsafe extern "C" fn finish(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        queue(env, Operation::StarterFinish(owned(env, a[0])?))
    })
}
unsafe extern "C" fn kill(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        queue(env, Operation::StarterKill(owned(env, a[0])?))
    })
}
unsafe extern "C" fn close(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        owned(env, a[0])?;
        let mut id = std::ptr::null_mut();
        check(napi_unwrap(env, a[0], &mut id))?;
        finalize(env, id, std::ptr::null_mut());
        Ok(undefined(env))
    })
}
pub(crate) unsafe fn register(env: Env, exports: Value) -> Result<()> {
    for (name, callback) in [
        (
            "openServicePeer",
            open as unsafe extern "C" fn(Env, Info) -> Value,
        ),
        ("prepareServiceStarter", start),
        ("readServiceStarter", read),
        ("waitServiceStarter", wait),
        ("finishServiceStarter", finish),
        ("killServiceStarter", kill),
        ("closeServiceStarter", close),
    ] {
        let mut f = std::ptr::null_mut();
        check(napi_create_function(
            env,
            std::ptr::null(),
            0,
            Some(callback),
            std::ptr::null_mut(),
            &mut f,
        ))?;
        set(env, exports, name, f)?;
    }
    Ok(())
}
