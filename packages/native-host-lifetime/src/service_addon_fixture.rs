//! Separate fixture export; not one of the six production codenomad.runtime.v1 methods.
use crate::addon::{arguments, invoke, queue, session, Operation};
use crate::addon_api::*;
use crate::Result;
unsafe extern "C" fn authorize(env: Env, info: Info) -> Value {
    invoke(env, || {
        let args = arguments(env, info, 2)?;
        queue(
            env,
            Operation::FixtureAuthorize(
                session(env, args[0])?,
                bytes(env, args[1], crate::service_permit::MAX_REQUEST)?,
            ),
        )
    })
}
pub(crate) unsafe fn register(env: Env, exports: Value) -> Result<()> {
    let mut function = std::ptr::null_mut();
    check(napi_create_function(
        env,
        std::ptr::null(),
        0,
        Some(authorize),
        std::ptr::null_mut(),
        &mut function,
    ))?;
    set(env, exports, "fixtureAuthorizeNestedResponse", function)
}
