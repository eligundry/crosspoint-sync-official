import { http } from './api.js'

// Runs the reader's plugin host while plugin jobs are outstanding. CrossPoint runs
// queued SD-plugin jobs only while a page hosting the plugin is open: the page claims
// each job, runs the plugin's action and posts the result back.
//
// Rather than opening the reader's http:// /plugins-run page (blocked as mixed
// content in some webviews), the app runs the same thing itself: the firmware's own
// /js/plugin-host.js and SD plugins, in a sandboxed frame with an opaque origin and no
// access to the app or Tauri. The frame's `fetch` and plugin <script> loads go over
// postMessage to this page, which sends them to the reader through the app's Rust
// HTTP client like every other reader request. Plugins only speak to their reader
// (relative URLs); anything else is refused.

const READER = 'http://reader.invalid'

// The frame: a stand-in for the firmware's RunnerPage.html.
export const RUNNER_HTML = `<!doctype html><meta charset="utf-8"><title>CrossPoint plugin runner</title>
<div id="plugin-container" hidden></div>
<script>
(() => {
  const READER = ${JSON.stringify(READER)}
  const pending = new Map()
  let next = 0
  addEventListener('message', (e) => {
    if (e.source !== parent) return
    const call = pending.get(e.data?.id)
    if (!call) return
    pending.delete(e.data.id)
    call(e.data)
  })
  const ask = (message, transfer) =>
    new Promise((resolve) => {
      const id = ++next
      pending.set(id, resolve)
      parent.postMessage({ ...message, id }, '*', transfer)
    })
  const resolve = (input) => {
    const url = new URL(input, READER + '/')
    if (url.origin !== READER) throw new TypeError('Plugins can only reach their reader: ' + input)
    return url
  }
  window.fetch = async (input, init) => {
    const request = new Request(input instanceof Request ? input : resolve(String(input)).href, init)
    const url = resolve(request.url)
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer()
    const reply = await ask(
      { path: url.pathname + url.search, method: request.method, headers: [...request.headers], body },
      body ? [body] : [],
    )
    if (reply.error) throw new TypeError(reply.error)
    const empty = [101, 204, 205, 304].includes(reply.status)
    return new Response(empty ? null : reply.body, { status: reply.status, statusText: reply.statusText, headers: reply.headers })
  }
  // plugin-host.js loads each plugin with <script src="/plugin?...">. Fetch the
  // source through the bridge and run it as an inline script on the same element,
  // so document.currentScript and the load/error events behave as on the reader.
  const src = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src')
  Object.defineProperty(HTMLScriptElement.prototype, 'src', {
    configurable: true,
    get() { return src.get.call(this) },
    set(value) {
      fetch(value)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(value + ' ' + r.status))))
        .then(async (code) => {
          while (!this.isConnected) await new Promise((r) => setTimeout(r))
          this.text = code
          this.dispatchEvent(new Event('load'))
        })
        .catch((e) => {
          console.warn(e)
          this.dispatchEvent(new Event('error'))
        })
    },
  })
  const start = async () => {
    try {
      const script = document.createElement('script')
      const loaded = new Promise((ok, fail) => { script.onload = ok; script.onerror = fail })
      script.src = '/js/plugin-host.js'
      document.head.appendChild(script)
      await loaded
      if (await loadPlugins(null)) return
    } catch {}
    // The host or the plugin list failed to load: retry, as RunnerPage.html does.
    setTimeout(() => location.reload(), 10000)
  }
  start()
})()
</script>`

// Only same-reader paths: "/x", not "//host/x".
export const readerPath = (path) => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')

let users = 0
let current = null
let frame = null
let relay = null

function open(base) {
  frame = document.createElement('iframe')
  const target = frame
  relay = async (event) => {
    if (event.source !== target.contentWindow) return
    const { id, path, method, headers, body } = event.data ?? {}
    const reply = (message, transfer = []) => target.contentWindow?.postMessage({ ...message, id }, '*', transfer)
    if (!readerPath(path)) return reply({ error: 'Plugins can only reach their reader.' })
    try {
      const res = await http(`${base}${path}`, { method, headers, body: body ?? undefined })
      const data = await res.arrayBuffer()
      reply({ status: res.status, statusText: res.statusText, headers: [...res.headers], body: data }, [data])
    } catch (e) {
      reply({ error: `Couldn't reach your reader: ${e?.message ?? e}` })
    }
  }
  window.addEventListener('message', relay)
  frame.sandbox = 'allow-scripts'
  frame.srcdoc = RUNNER_HTML
  frame.title = 'CrossPoint plugin runner'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  // A frame with no visible pixels may be throttled; keep one.
  frame.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;border:0;opacity:0.01;pointer-events:none'
  document.body.appendChild(frame)
}

function close() {
  window.removeEventListener('message', relay)
  frame?.remove()
  frame = null
  relay = null
}

/** Keeps a plugin host for the reader at `base` running until the matching release. */
export function acquireRunner(base) {
  users += 1
  if (current === base) return
  if (current) close()
  current = base
  open(base)
}

export function releaseRunner() {
  users = Math.max(0, users - 1)
  if (users || !current) return
  current = null
  close()
}
