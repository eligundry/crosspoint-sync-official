// Hidden host for the reader's headless plugin page (/plugins-run). CrossPoint runs
// queued SD-plugin jobs only while a page hosting the plugin is open; the Protected
// Content plugin fetches .acsm books this way (see src/protectedContent.js).
//
// The page is http:// on the LAN and the app's own page is tauri:// on Apple
// platforms, where an iframe can be blocked as mixed content, so it gets its own
// webview: a hidden window on desktop, an off-screen 1×1 WKWebView on iOS. The
// runner window has no capabilities, so the reader's page can't call the app.
// Android returns false and the page uses a hidden iframe instead.

const LABEL: &str = "plugin-runner";

fn runner_url(url: &str) -> Result<tauri::Url, String> {
  let url: tauri::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
  if url.scheme() != "http" || url.path() != "/plugins-run" {
    return Err("only a reader's /plugins-run page can be opened".into());
  }
  Ok(url)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn open_plugin_runner(app: tauri::AppHandle, url: String) -> Result<bool, String> {
  use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
  let url = runner_url(&url)?;
  if let Some(window) = app.get_webview_window(LABEL) {
    window.navigate(url).map_err(|e| e.to_string())?;
    return Ok(true);
  }
  WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
    .title("CrossPoint plugin runner")
    .inner_size(320.0, 240.0)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;
  Ok(true)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn close_plugin_runner(app: tauri::AppHandle) -> Result<(), String> {
  use tauri::Manager;
  if let Some(window) = app.get_webview_window(LABEL) {
    window.destroy().map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg(target_os = "ios")]
mod ios {
  use objc2::{class, msg_send, rc::Allocated, rc::Retained, runtime::AnyObject};
  use objc2_core_foundation::{CGPoint, CGRect, CGSize};
  use objc2_foundation::{NSString, NSURLRequest, NSURL};
  use std::sync::Mutex;

  // The runner WKWebView, retained; 0 when closed. Only touched on the main thread.
  static RUNNER: Mutex<usize> = Mutex::new(0);

  unsafe fn close_now() {
    let ptr = std::mem::take(&mut *RUNNER.lock().unwrap());
    if let Some(runner) = Retained::from_raw(ptr as *mut AnyObject) {
      let _: () = msg_send![&*runner, stopLoading];
      let _: () = msg_send![&*runner, removeFromSuperview];
    }
  }

  pub fn open(window: &tauri::WebviewWindow, url: String) -> tauri::Result<()> {
    window.with_webview(move |webview| unsafe {
      close_now();
      let Some(nsurl) = NSURL::URLWithString(&NSString::from_str(&url)) else { return };
      let main = &*(webview.inner() as *const AnyObject);
      let config: Retained<AnyObject> = msg_send![class!(WKWebViewConfiguration), new];
      let alloc: Allocated<AnyObject> = msg_send![class!(WKWebView), alloc];
      // One visible pixel: WebKit may suspend timers in a view that draws nothing.
      let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(1.0, 1.0));
      let runner: Retained<AnyObject> = msg_send![alloc, initWithFrame: frame, configuration: &*config];
      let _: () = msg_send![&*runner, setAlpha: 0.01f64];
      let _: () = msg_send![&*runner, setUserInteractionEnabled: false];
      let request = NSURLRequest::requestWithURL(&nsurl);
      let _: *mut AnyObject = msg_send![&*runner, loadRequest: &*request];
      let superview: *mut AnyObject = msg_send![main, superview];
      let host: *const AnyObject = if superview.is_null() { main } else { superview };
      let _: () = msg_send![host, addSubview: &*runner];
      *RUNNER.lock().unwrap() = Retained::into_raw(runner) as usize;
    })
  }

  pub fn close(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|_| unsafe { close_now() })
  }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn open_plugin_runner(app: tauri::AppHandle, url: String) -> Result<bool, String> {
  use tauri::Manager;
  let url = runner_url(&url)?;
  let window = app.get_webview_window("main").ok_or("no main window")?;
  ios::open(&window, url.to_string()).map_err(|e| e.to_string())?;
  Ok(true)
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub async fn close_plugin_runner(app: tauri::AppHandle) -> Result<(), String> {
  use tauri::Manager;
  if let Some(window) = app.get_webview_window("main") {
    ios::close(&window).map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn open_plugin_runner(url: String) -> Result<bool, String> {
  runner_url(&url)?;
  Ok(false)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn close_plugin_runner() -> Result<(), String> {
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::runner_url;

  #[test]
  fn opens_only_a_reader_runner_page() {
    assert!(runner_url("http://192.168.1.40/plugins-run").is_ok());
    assert!(runner_url("http://crosspoint.local/plugins-run").is_ok());
    assert!(runner_url("https://example.com/plugins-run").is_err());
    assert!(runner_url("http://192.168.1.40/").is_err());
    assert!(runner_url("file:///plugins-run").is_err());
  }
}
