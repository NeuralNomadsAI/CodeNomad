//! Compiled codenomad.runtime.v1 addon. Actual sessions are wrapped native objects.
use crate::addon_api::*;
use crate::native_client::Client;
use crate::{Error, Result};
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::atomic::AtomicBool;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex, OnceLock,
};

static SESSIONS: OnceLock<Mutex<HashMap<usize, Arc<Client>>>> = OnceLock::new();
static NEXT: AtomicUsize = AtomicUsize::new(1);
static OUTSTANDING: AtomicUsize = AtomicUsize::new(0);
static OPENED: AtomicBool = AtomicBool::new(false);
static SESSION_TAG: TypeTag = TypeTag {
    lower: 0x434e485253455353,
    upper: 0x0001000000000001,
};
fn sessions() -> &'static Mutex<HashMap<usize, Arc<Client>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) enum Operation {
    Open(Vec<u8>),
    OpenMissions(Arc<Client>, Vec<u8>),
    Manager(Arc<Client>, Vec<u8>, String, Vec<u8>),
    Member(Arc<Client>, u32, Vec<u8>, Vec<u8>),
    Read(Arc<Client>),
    Write(Arc<Client>, Vec<u8>),
    OpenPeer(Vec<u8>),
    Authorize(Arc<Client>, Vec<u8>, u64),
    #[cfg(feature = "fixtures")]
    FixtureAuthorize(Arc<Client>, Vec<u8>),
    Service(Arc<Client>, String, Vec<u8>),
    Start(Arc<Client>, Vec<u8>, Vec<u8>),
    StarterRead(crate::service_starter::OwnedStarter, bool),
    StarterStatus(crate::service_starter::OwnedStarter),
    StarterFinish(crate::service_starter::OwnedStarter),
    StarterKill(crate::service_starter::OwnedStarter),
}
pub(crate) enum Response {
    Open(Arc<Client>, Vec<u8>),
    Missions(crate::mission_channel::Channel),
    Json(serde_json::Value),
    Bytes(Vec<u8>),
    Void,
    Starter(crate::service_starter::OwnedStarter),
}
struct Work {
    deferred: Deferred,
    work: Async,
    operation: Operation,
    result: Option<Result<Response>>,
}
unsafe extern "C" fn execute(_env: Env, data: *mut c_void) {
    let work = &mut *(data as *mut Work);
    work.result = Some(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &work.operation {
            Operation::Open(nonce) => Client::open(nonce)
                .map(|(client, receipt)| Response::Open(Arc::new(client), receipt)),
            Operation::OpenMissions(client, challenge) => crate::mission_channel::open(client, challenge)
                .map(Response::Missions),
            Operation::Manager(client, nonce, digest, receipt) => client
                .verify(nonce, Some(digest), receipt, std::process::id())
                .map(Response::Json),
            Operation::Member(client, pid, nonce, receipt) => client
                .verify(nonce, None, receipt, *pid)
                .map(Response::Json),
            Operation::Read(client) => client.read().map(Response::Bytes),
            Operation::Write(client, data) => client.write(data).map(|_| Response::Void),
            Operation::OpenPeer(nonce) => {
                Client::open_role(nonce, "broker").map(|(c, r)| Response::Open(Arc::new(c), r))
            }
            Operation::Authorize(c, b, d) => c.authorize(b, *d).map(Response::Bytes),
            #[cfg(feature = "fixtures")]
            Operation::FixtureAuthorize(c, b) => {
                c.fixture_authorize_response(b).map(Response::Bytes)
            }
            Operation::Service(c, d, b) => c.verify_service(d, b).map(Response::Json),
            Operation::Start(c, g, b) => {
                crate::service_starter::Starter::prepare(c.clone(), g, b).map(Response::Starter)
            }
            Operation::StarterRead(s, err) => s
                .lock()
                .map_err(|_| Error("native-service-starter-poisoned"))?
                .read(*err)
                .map(Response::Json),
            Operation::StarterStatus(s) => s
                .lock()
                .map_err(|_| Error("native-service-starter-poisoned"))?
                .status()
                .map(Response::Json),
            Operation::StarterFinish(s) => s
                .lock()
                .map_err(|_| Error("native-service-starter-poisoned"))?
                .finish()
                .map(Response::Bytes),
            Operation::StarterKill(s) => s
                .lock()
                .map_err(|_| Error("native-service-starter-poisoned"))?
                .kill()
                .map(|_| Response::Void),
        }))
        .unwrap_or(Err(Error("native-sdk-panic-fenced"))),
    );
}
unsafe extern "C" fn finalize(_env: Env, data: *mut c_void, _hint: *mut c_void) {
    if let Ok(mut map) = sessions().lock() {
        if let Some(client) = map.remove(&(data as usize)) {
            client.release();
        }
    }
}
pub(crate) unsafe fn session(env: Env, value: Value) -> Result<Arc<Client>> {
    let mut tagged = false;
    check(napi_check_object_type_tag(
        env,
        value,
        &SESSION_TAG,
        &mut tagged,
    ))?;
    if !tagged {
        return Err(Error("native-sdk-session-required"));
    }
    let mut id = std::ptr::null_mut();
    check(napi_unwrap(env, value, &mut id))?;
    sessions()
        .lock()
        .map_err(|_| Error("native-sdk-session-poisoned"))?
        .get(&(id as usize))
        .cloned()
        .ok_or(Error("native-sdk-session-required"))
}
unsafe fn wrap(env: Env, client: Arc<Client>) -> Result<Value> {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if id == 0 {
        return Err(Error("native-sdk-session-capacity"));
    }
    let object = object(env)?;
    check(napi_type_tag_object(env, object, &SESSION_TAG))?;
    check(napi_wrap(
        env,
        object,
        id as *mut c_void,
        Some(finalize),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    ))?;
    sessions()
        .lock()
        .map_err(|_| Error("native-sdk-session-poisoned"))?
        .insert(id, client);
    Ok(object)
}
pub(crate) unsafe fn function(env: Env, callback: Callback) -> Result<Value> {
    let mut value = std::ptr::null_mut();
    check(napi_create_function(
        env,
        std::ptr::null(),
        0,
        callback,
        std::ptr::null_mut(),
        &mut value,
    ))?;
    Ok(value)
}
unsafe fn duplex(env: Env, session: Value) -> Result<Value> {
    // A supported Node Duplex over addon-owned overlapped I/O. No libuv/IPC FD
    // adoption, NODE_CHANNEL hacks, JS attestation or generic executor exists.
    let factory = string(
        env,
        r#"((session, read, write, release) => {
      const { Duplex } = process.getBuiltinModule('node:stream');
      let busy = false;
      return new Duplex({
        read() {
          if (busy || this.destroyed) return; busy = true;
          const pull = () => read(session).then(bytes => {
            if (this.destroyed) { busy = false; return; }
            if (!bytes.length) { pull(); return; }
            busy = false; this.push(bytes);
          }, () => { busy = false; this.destroy(new Error('native-channel-closed')); });
          pull();
        },
        write(bytes, encoding, done) { write(session, Buffer.from(bytes)).then(() => done(), () => done(new Error('native-channel-write-failed'))); },
        destroy(error, done) { release(session); done(error); }
      });
    })"#,
    )?;
    let mut make = std::ptr::null_mut();
    check(napi_run_script(env, factory, &mut make))?;
    let args = [
        session,
        function(env, Some(read))?,
        function(env, Some(write))?,
        function(env, Some(release))?,
    ];
    let mut out = std::ptr::null_mut();
    check(napi_call_function(
        env,
        undefined(env),
        make,
        args.len(),
        args.as_ptr(),
        &mut out,
    ))?;
    Ok(out)
}
unsafe fn project(env: Env, response: Response) -> Result<Value> {
    match response {
        Response::Bytes(bytes) => buffer(env, &bytes),
        Response::Json(value) => json(env, &value),
        Response::Void => Ok(undefined(env)),
        Response::Missions(channel) => crate::mission_channel_addon::wrap_channel(env, channel),
        Response::Starter(s) => crate::addon_service::wrap(env, s),
        Response::Open(client, receipt) => {
            let out = object(env)?;
            let session = wrap(env, client.clone())?;
            set(env, out, "nativeSession", session)?;
            set(env, out, "channel", duplex(env, session)?)?;
            if client.boot.role == "broker" {
                set(
                    env,
                    out,
                    "application",
                    json(env, &client.boot.application)?,
                )?;
                return Ok(out);
            }
            set(
                env,
                out,
                "key",
                buffer(env, &crate::runtime_wire::unhex(&client.boot.secret)?)?,
            )?;
            set(env, out, "launch", buffer(env, &client.launch)?)?;
            set(env, out, "attestation", buffer(env, &receipt)?)?;
            Ok(out)
        }
    }
}
unsafe extern "C" fn complete(env: Env, status: u32, data: *mut c_void) {
    let mut work = Box::from_raw(data as *mut Work);
    let value = if status == 0 {
        work.result
            .take()
            .unwrap_or(Err(Error("native-sdk-work-cancelled")))
            .and_then(|value| project(env, value))
    } else {
        Err(Error("native-sdk-work-cancelled"))
    };
    match value {
        Ok(value) => {
            napi_resolve_deferred(env, work.deferred, value);
        }
        Err(Error("native-service-start-failed")) => {
            napi_reject_deferred(env, work.deferred, service_failure(env));
        }
        Err(Error(code)) if code.starts_with("native-missions-") => {
            napi_reject_deferred(env, work.deferred, crate::mission_channel_addon::failure(env, code));
        }
        Err(_) => {
            napi_reject_deferred(env, work.deferred, error(env));
        }
    }
    napi_delete_async_work(env, work.work);
    OUTSTANDING.fetch_sub(1, Ordering::AcqRel);
}
pub(crate) unsafe fn queue(env: Env, operation: Operation) -> Result<Value> {
    if OUTSTANDING
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            if n < 32 {
                Some(n + 1)
            } else {
                None
            }
        })
        .is_err()
    {
        return Err(Error("native-sdk-backpressure"));
    }
    let mut work = Box::new(Work {
        deferred: std::ptr::null_mut(),
        work: std::ptr::null_mut(),
        operation,
        result: None,
    });
    let prepared = (|| -> Result<Value> {
        let mut promise = std::ptr::null_mut();
        check(napi_create_promise(env, &mut work.deferred, &mut promise))?;
        let name = string(env, "codenomad.native.runtime")?;
        check(napi_create_async_work(
            env,
            std::ptr::null_mut(),
            name,
            Some(execute),
            Some(complete),
            &mut *work as *mut _ as _,
            &mut work.work,
        ))?;
        check(napi_queue_async_work(env, work.work))?;
        Ok(promise)
    })();
    match prepared {
        Ok(promise) => {
            let _ = Box::into_raw(work);
            Ok(promise)
        }
        Err(error) => {
            if !work.work.is_null() {
                napi_delete_async_work(env, work.work);
            }
            OUTSTANDING.fetch_sub(1, Ordering::AcqRel);
            Err(error)
        }
    }
}
pub(crate) unsafe fn arguments(env: Env, info: Info, count: usize) -> Result<Vec<Value>> {
    let mut values = vec![std::ptr::null_mut(); count];
    let mut actual = count;
    check(napi_get_cb_info(
        env,
        info,
        &mut actual,
        values.as_mut_ptr(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    ))?;
    if actual != count {
        return Err(Error("native-sdk-arguments"));
    }
    Ok(values)
}
pub(crate) unsafe fn invoke(env: Env, work: impl FnOnce() -> Result<Value>) -> Value {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
        .unwrap_or(Err(Error("native-sdk-panic-fenced")))
    {
        Ok(value) => value,
        Err(_) => {
            napi_throw_error(
                env,
                std::ptr::null(),
                c"native-runtime-request-refused".as_ptr(),
            );
            undefined(env)
        }
    }
}
unsafe extern "C" fn open(env: Env, info: Info) -> Value {
    invoke(env, || {
        let args = arguments(env, info, 1)?;
        let nonce = bytes(env, args[0], 32)?;
        if nonce.len() != 32 || OPENED.swap(true, Ordering::AcqRel) {
            return Err(Error("native-sdk-open-once"));
        }
        queue(env, Operation::Open(nonce))
    })
}
unsafe extern "C" fn manager(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 4)?;
        queue(
            env,
            Operation::Manager(
                session(env, a[0])?,
                bytes(env, a[1], 32)?,
                text(env, a[2], 64)?,
                bytes(env, a[3], 4096)?,
            ),
        )
    })
}
unsafe extern "C" fn member(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 4)?;
        let mut pid = 0.0;
        check(napi_get_value_double(env, a[1], &mut pid))?;
        if !pid.is_finite() || pid.fract() != 0.0 || pid < 1.0 || pid > u32::MAX as f64 {
            return Err(Error("native-sdk-candidate-pid-invalid"));
        }
        queue(
            env,
            Operation::Member(
                session(env, a[0])?,
                pid as u32,
                bytes(env, a[2], 32)?,
                bytes(env, a[3], 4096)?,
            ),
        )
    })
}
unsafe extern "C" fn authorize(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 3)?;
        let c = session(env, a[0])?;
        let b = bytes(env, a[1], crate::service_permit::MAX_REQUEST)?;
        let mut deadline = 0.0;
        check(napi_get_value_double(env, a[2], &mut deadline))?;
        if !deadline.is_finite()
            || deadline.fract() != 0.0
            || deadline <= 0.0
            || deadline > 9007199254740991.0
        {
            return Err(Error("native-service-deadline-invalid"));
        }
        queue(env, Operation::Authorize(c, b, deadline as u64))
    })
}
unsafe extern "C" fn service(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 3)?;
        queue(
            env,
            Operation::Service(
                session(env, a[0])?,
                text(env, a[1], 64)?,
                bytes(env, a[2], 4096)?,
            ),
        )
    })
}
unsafe extern "C" fn read(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        queue(env, Operation::Read(session(env, a[0])?))
    })
}
unsafe extern "C" fn write(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 2)?;
        queue(
            env,
            Operation::Write(session(env, a[0])?, bytes(env, a[1], 262242)?),
        )
    })
}
unsafe extern "C" fn release(env: Env, info: Info) -> Value {
    invoke(env, || {
        let a = arguments(env, info, 1)?;
        let mut tagged = false;
        check(napi_check_object_type_tag(
            env,
            a[0],
            &SESSION_TAG,
            &mut tagged,
        ))?;
        if !tagged {
            return Err(Error("native-sdk-session-required"));
        }
        let mut id = std::ptr::null_mut();
        check(napi_unwrap(env, a[0], &mut id))?;
        finalize(env, id, std::ptr::null_mut());
        Ok(undefined(env))
    })
}
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: Env, exports: Value) -> Value {
    invoke(env, || {
        set(env, exports, "abi", string(env, "codenomad.runtime.v1")?)?;
        for (name, callback) in [
            (
                "openManager",
                open as unsafe extern "C" fn(Env, Info) -> Value,
            ),
            ("verifyManager", manager),
            ("verifyMember", member),
            ("authorizeService", authorize),
            ("verifyService", service),
            ("release", release),
        ] {
            set(env, exports, name, function(env, Some(callback))?)?;
        }
        crate::addon_service::register(env, exports)?;
        crate::mission_channel_addon::register(env, exports)?;
        #[cfg(feature = "fixtures")]
        crate::service_addon_fixture::register(env, exports)?;
        Ok(exports)
    })
}
