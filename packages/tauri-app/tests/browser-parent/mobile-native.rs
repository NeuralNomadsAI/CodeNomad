use super::*;
use std::ffi::{c_char,c_void,CString};
extern "C" {
    fn cn_mobile_trial(view:*mut c_void,ua:*const c_char,zoom:f64,dpr:f64,width:f64,height:f64,mode:i32)->i32;
    fn cn_mobile_touch(view:*mut c_void,phase:i32,x:f64,y:f64)->i32;
}
pub(super) fn handle(app:&tauri::AppHandle,controller:&BrowserController,id:&str,method:&str,input:&Value,fence:native_request::RequestFence)->Result<Value,String> {
    fence.check()?;
    let prefix=if input["target"]=="other" {"browser-mobile-other-".into()} else {format!("browser-{id}-")};
    let view=if input["target"]=="primary" {app.get_webview(OWNER)} else {app.webviews().into_values().find(|view|view.label().starts_with(&prefix))}.ok_or("Mobile fixture view missing")?;
    if method=="fixture.mobile-init" {
        let url=input["url"].as_str().ok_or("Missing fixture URL")?;
        app.get_webview(OWNER).ok_or("Missing renderer")?.navigate(url.parse().map_err(|_|"Invalid fixture URL")?).map_err(|e|e.to_string())?;
        let registration=serde_json::from_value(json!({"sessionId":"mobile-other","registrationId":"mobile-other","url":url,"bounds":bounds(),"visible":false})).unwrap();
        controller.register(&app.get_window(OTHER).unwrap(),registration)?;
        update(app,controller,OTHER,"mobile-other",true)?;
        std::thread::sleep(Duration::from_millis(200));
        return Ok(Value::Null);
    }
    if method=="fixture.mobile-size" {
        let update=serde_json::from_value(json!({"registrationId":id,"visible":true,"bounds":{"x":10,"y":60,"width":input["width"],"height":input["height"]}})).map_err(|e|e.to_string())?;
        controller.update(app,OWNER,update)?;return Ok(Value::Null);
    }
    if method=="fixture.mobile-probe" {
        view.eval("report()").map_err(|e|e.to_string())?;
        let bytes=embedded_view::input::read(&view,embedded_view::input::Read::Checkpoint,std::time::Instant::now()+Duration::from_secs(5),move||fence.check())?;
        let value:Value=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        return serde_json::from_str(value["body"].as_str().and_then(|s|s.split_once("__CN_MOBILE__").map(|(_,v)|v)).ok_or("Mobile report missing")?.trim()).map_err(|e|e.to_string());
    }
    if method=="fixture.mobile-profile" {
        let action=serde_json::from_value(json!({"registrationId":id,"action":"emulate","preset":input["preset"]})).unwrap();
        return controller.action(app,OWNER,action);
    }
    let ua=CString::new(input["ua"].as_str().unwrap_or("")).map_err(|_|"Invalid trial UA")?;
    let zoom=input["zoom"].as_f64().unwrap_or(1.0);
    let dpr=input["dpr"].as_f64().unwrap_or(0.0);
    let mode=input["mode"].as_i64().unwrap_or(0) as i32;
    let width=input["cssWidth"].as_f64().unwrap_or(390.0);let height=input["cssHeight"].as_f64().unwrap_or(844.0);
    let phase=input["phase"].as_i64().unwrap_or(0) as i32;
    let (sender,receiver)=std::sync::mpsc::sync_channel(1);
    let touch=method=="fixture.mobile-touch";
    view.with_webview(move|native|{
        if let Err(error)=fence.check(){let _=sender.send(Err(error));return;}
        #[cfg(target_os="macos")] let ptr=native.inner();
        #[cfg(target_os="linux")] let ptr={use gtk::glib::object::ObjectType;native.inner().as_ptr().cast::<c_void>()};
        let result=unsafe {if touch {cn_mobile_touch(ptr,phase,40.0,140.0)} else {cn_mobile_trial(ptr,ua.as_ptr(),zoom,dpr,width,height,mode)}};
        let _=sender.send(Ok(result));
    }).map_err(|e|e.to_string())?;
    let result=receiver.recv_timeout(Duration::from_secs(5)).map_err(|_|"Native mobile trial timed out")??;
    if !touch && input["reload"]!=false {view.reload().map_err(|e|e.to_string())?;}
    std::thread::sleep(Duration::from_millis(150));
    Ok(json!({"native":result}))
}
