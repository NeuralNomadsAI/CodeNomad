//! Raw Node-API ABI resolved from the running Node executable; no downloaded SDK.
#![allow(non_camel_case_types)]
use crate::{Error, Result};
use std::ffi::{c_char, c_void};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
pub(crate) type Env = *mut c_void;
pub(crate) type Value = *mut c_void;
pub(crate) type Info = *mut c_void;
pub(crate) type Deferred = *mut c_void;
pub(crate) type Async = *mut c_void;
#[repr(C)]
pub(crate) struct TypeTag {
    pub(crate) lower: u64,
    pub(crate) upper: u64,
}
pub(crate) type Callback = Option<unsafe extern "C" fn(Env, Info) -> Value>;
pub(crate) type Finalize = Option<unsafe extern "C" fn(Env, *mut c_void, *mut c_void)>;
macro_rules! api {
    ($name:ident($($arg:ident:$ty:ty),*) )=>{
        pub(crate) unsafe fn $name($($arg:$ty),*)->u32 {
            let raw=GetProcAddress(GetModuleHandleW(std::ptr::null()),concat!(stringify!($name),"\0").as_ptr());
            match raw { Some(f)=>{
                let call:unsafe extern "C" fn($($ty),*)->u32=std::mem::transmute(f);call($($arg),*)
            },None=>1 }
        }
    }
}
api!(napi_get_cb_info(env:Env,info:Info,count:*mut usize,args:*mut Value,this:*mut Value,data:*mut *mut c_void));
api!(napi_create_object(env:Env,out:*mut Value));
api!(napi_create_function(env:Env,name:*const c_char,len:usize,callback:Callback,data:*mut c_void,out:*mut Value));
api!(napi_set_named_property(env:Env,object:Value,name:*const c_char,value:Value));
api!(napi_create_string_utf8(env:Env,text:*const c_char,len:usize,out:*mut Value));
api!(napi_get_value_string_utf8(env:Env,value:Value,text:*mut c_char,len:usize,count:*mut usize));
api!(napi_get_value_double(env:Env,value:Value,out:*mut f64));
api!(napi_get_buffer_info(env:Env,value:Value,data:*mut *mut c_void,size:*mut usize));
api!(napi_is_buffer(env:Env,value:Value,out:*mut bool));
api!(napi_create_buffer_copy(env:Env,size:usize,data:*const c_void,copied:*mut *mut c_void,out:*mut Value));
api!(napi_get_undefined(env:Env,out:*mut Value));
api!(napi_create_promise(env:Env,deferred:*mut Deferred,out:*mut Value));
api!(napi_resolve_deferred(env:Env,deferred:Deferred,value:Value));
api!(napi_reject_deferred(env:Env,deferred:Deferred,value:Value));
api!(napi_create_error(env:Env,code:Value,message:Value,out:*mut Value));
api!(napi_throw_error(env:Env,code:*const c_char,message:*const c_char));
api!(napi_run_script(env:Env,script:Value,out:*mut Value));
api!(napi_call_function(env:Env,this:Value,function:Value,count:usize,args:*const Value,out:*mut Value));
api!(napi_wrap(env:Env,value:Value,data:*mut c_void,finalize:Finalize,hint:*mut c_void,reference:*mut *mut c_void));
api!(napi_unwrap(env:Env,value:Value,data:*mut *mut c_void));
api!(napi_type_tag_object(env:Env,value:Value,tag:*const TypeTag));
api!(napi_check_object_type_tag(env:Env,value:Value,tag:*const TypeTag,out:*mut bool));
api!(napi_create_async_work(env:Env,resource:Value,name:Value,execute:Option<unsafe extern "C" fn(Env,*mut c_void)>,complete:Option<unsafe extern "C" fn(Env,u32,*mut c_void)>,data:*mut c_void,out:*mut Async));
api!(napi_queue_async_work(env:Env,work:Async));
api!(napi_delete_async_work(env:Env,work:Async));
pub(crate) fn check(status: u32) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(Error("native-sdk-node-api"))
    }
}
pub(crate) unsafe fn string(env: Env, text: &str) -> Result<Value> {
    let mut out = std::ptr::null_mut();
    check(napi_create_string_utf8(
        env,
        text.as_ptr() as _,
        text.len(),
        &mut out,
    ))?;
    Ok(out)
}
pub(crate) unsafe fn object(env: Env) -> Result<Value> {
    let mut out = std::ptr::null_mut();
    check(napi_create_object(env, &mut out))?;
    Ok(out)
}
pub(crate) unsafe fn undefined(env: Env) -> Value {
    let mut out = std::ptr::null_mut();
    napi_get_undefined(env, &mut out);
    out
}
pub(crate) unsafe fn set(env: Env, obj: Value, key: &str, value: Value) -> Result<()> {
    let name = std::ffi::CString::new(key).map_err(|_| Error("native-sdk-property"))?;
    check(napi_set_named_property(env, obj, name.as_ptr(), value))
}
pub(crate) unsafe fn buffer(env: Env, bytes: &[u8]) -> Result<Value> {
    let mut out = std::ptr::null_mut();
    check(napi_create_buffer_copy(
        env,
        bytes.len(),
        bytes.as_ptr() as _,
        std::ptr::null_mut(),
        &mut out,
    ))?;
    Ok(out)
}
pub(crate) unsafe fn bytes(env: Env, value: Value, max: usize) -> Result<Vec<u8>> {
    let mut is = false;
    check(napi_is_buffer(env, value, &mut is))?;
    if !is {
        return Err(Error("native-sdk-buffer-required"));
    }
    let (mut data, mut size) = (std::ptr::null_mut(), 0);
    check(napi_get_buffer_info(env, value, &mut data, &mut size))?;
    if size > max {
        return Err(Error("native-sdk-buffer-bound"));
    }
    if size == 0 {
        return Ok(vec![]);
    }
    Ok(std::slice::from_raw_parts(data as *const u8, size).to_vec())
}
pub(crate) unsafe fn text(env: Env, value: Value, max: usize) -> Result<String> {
    let mut size = 0;
    check(napi_get_value_string_utf8(
        env,
        value,
        std::ptr::null_mut(),
        0,
        &mut size,
    ))?;
    if size > max {
        return Err(Error("native-sdk-text-bound"));
    }
    let mut bytes = vec![0u8; size + 1];
    check(napi_get_value_string_utf8(
        env,
        value,
        bytes.as_mut_ptr() as _,
        bytes.len(),
        &mut size,
    ))?;
    bytes.truncate(size);
    String::from_utf8(bytes).map_err(|_| Error("native-sdk-text-invalid"))
}
pub(crate) unsafe fn error(env: Env) -> Value {
    static_error(env, "native-runtime-request-refused")
}
pub(crate) unsafe fn service_failure(env: Env) -> Value {
    static_error(env, "native-service-start-failed")
}
unsafe fn static_error(env: Env, code: &'static str) -> Value {
    let mut out = std::ptr::null_mut();
    if let Ok(message) = string(env, code) {
        napi_create_error(env, std::ptr::null_mut(), message, &mut out);
    }
    out
}
pub(crate) unsafe fn json(env: Env, value: &serde_json::Value) -> Result<Value> {
    let text = serde_json::to_string(value).map_err(|_| Error("native-sdk-json"))?;
    // Parse on the main thread. This is projection, never native proof/approval.
    let script = string(
        env,
        &format!("JSON.parse({})", serde_json::to_string(&text).unwrap()),
    )?;
    let mut out = std::ptr::null_mut();
    check(napi_run_script(env, script, &mut out))?;
    Ok(out)
}
