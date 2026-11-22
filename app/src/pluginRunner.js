import { invoke } from '@tauri-apps/api/core'

// Keeps the reader's headless plugin page (/plugins-run) open while plugin jobs are
// outstanding. CrossPoint runs queued plugin jobs only while some page hosting the
// plugin is open: the page claims each job, runs the plugin's action and posts the
// result back.
//
// Desktop and iOS open it in a native hidden webview (`open_plugin_runner`): an
// http:// frame inside the app's tauri:// page can be blocked as mixed content.
// Android's page is http://tauri.localhost, so a hidden iframe works there.

let users = 0
let current = null
let frame = null

async function open(url) {
  const native = await invoke('open_plugin_runner', { url }).catch(() => false)
  if (native) return
  frame = document.createElement('iframe')
  frame.src = url
  frame.title = 'CrossPoint plugin runner'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  // A frame with no visible pixels may be throttled; keep one.
  frame.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;border:0;opacity:0.01;pointer-events:none'
  document.body.appendChild(frame)
}

function close() {
  if (frame) {
    frame.remove()
    frame = null
  } else {
    invoke('close_plugin_runner').catch(() => {})
  }
}

export async function acquireRunner(url) {
  users += 1
  if (current === url) return
  if (current) close()
  current = url
  await open(url)
}

export function releaseRunner() {
  users = Math.max(0, users - 1)
  if (users || !current) return
  current = null
  close()
}
