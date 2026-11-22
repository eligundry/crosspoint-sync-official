import { http } from './api.js'
import { acquireRunner, releaseRunner } from './pluginRunner.js'

// Turns an .acsm already uploaded to the reader into a book, through the reader's
// Protected Content SD plugin (Plugin Hub: `protected-content`, firmware 2.0.0+).
//
// The plugin is an Adobe ADEPT client that runs in a browser page served by the
// reader. It registers the job-queue action `fulfill {path}`: it reads the .acsm
// through /download, fetches the book with the account signed in from its own UI,
// writes the EPUB beside the .acsm, stores the book key, deletes the .acsm and
// returns {title, dest, bytes}. Nothing here removes DRM: the book stays encrypted
// on the card and loans still expire.
//
// Jobs run only while a page hosting the plugin is open, so the reader's headless
// /plugins-run page is kept open (pluginRunner.js) while the job is outstanding.
// See the firmware's docs/sd-plugins.md, "Surface 2: the plugin job queue".

export const PLUGIN = 'protected-content'
export const ACTION = 'fulfill'
export const RUNNER_PATH = '/plugins-run'
// The firmware rejects job args of 192+ bytes of JSON.
const ARGS_MAX_BYTES = 191
const POLL_MS = 2000
// The runner page needs a few claim cycles (2.5 s each) before a job starts.
const START_TIMEOUT_MS = 45_000
// Fulfillment streams the whole book from the provider onto the SD card.
const TIMEOUT_MS = 6 * 60_000
// After this the firmware lets another page reclaim a claimed job.
const LEASE_MS = 10 * 60_000

export const isAcsm = (name) => /\.acsm$/i.test(name)

// Firmware lists no plugins while Settings → Connectivity → Plugins is off, so an
// empty list can also mean an installed plugin that is disabled.
export const NEEDS_PLUGIN =
  "Saved the .acsm. To fetch the book, turn on Settings → Connectivity → Plugins on the reader, install Protected Content (Send → Plugins) and sign in to it once from the reader's web page."
export const NEEDS_PLUGINS_ENABLED =
  'Saved the .acsm. To fetch the book, turn on Settings → Connectivity → Plugins on the reader.'
export const NEEDS_FIRMWARE =
  'Saved the .acsm. Reader firmware 2.0.0 or later with the Protected Content plugin can fetch the book.'
const NOT_SIGNED_IN =
  "Protected Content isn't signed in. Open the reader's web page in a browser, sign in on the Protected Content card, then send the .acsm again."
const TIMED_OUT = 'Timed out waiting for the reader to fetch the book.'
const NOT_STARTED = "The reader didn't start fetching the book. Check that Protected Content loads on the reader's web page."

class HttpError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export function supportsPluginJobs(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return !!m && Number(m[1]) >= 2
}

async function readError(res) {
  const text = (await res.text().catch(() => '')).trim()
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error === 'string') return parsed.error
  } catch {
    // plain text
  }
  return text || `HTTP ${res.status}`
}

export async function listPlugins(base) {
  const res = await http(`${base}/api/plugins`, { signal: AbortSignal.timeout(8000) })
  if (res.status === 404) return [] // firmware without the plugin system
  if (!res.ok) throw new Error(`Couldn't list the reader's plugins: ${await readError(res)}`)
  const data = await res.json()
  return Array.isArray(data) ? data.filter((p) => typeof p?.name === 'string') : []
}

export const hasProtectedContent = (plugins) => plugins.some((p) => p.name.toLowerCase() === PLUGIN && p.hasPluginJs !== false)

export async function submitJob(base, args) {
  const res = await http(`${base}/api/plugin-jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plugin: PLUGIN, action: ACTION, args }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new HttpError(`The reader refused the fetch job: ${await readError(res)}`, res.status)
  const { id } = await res.json()
  if (typeof id !== 'number' || id <= 0) throw new Error('The reader accepted the fetch job without an id.')
  return id
}

export async function jobStatus(base, id) {
  const res = await http(`${base}/api/plugin-jobs/status?id=${id}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new HttpError(`Job status failed: ${await readError(res)}`, res.status)
  const data = await res.json()
  const state = ['pending', 'running', 'done', 'error', 'unknown'].includes(data?.state) ? data.state : 'unknown'
  return { state, result: data?.result && typeof data.result === 'object' ? data.result : null }
}

// Transport errors and 5xx are worth retrying: the reader can't answer while it
// streams the book to SD. 403 means plugins were switched off.
const transient = (e) => !(e instanceof HttpError) || e.status >= 500

const utf8Bytes = (text) => new TextEncoder().encode(text).length
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pluginError(result) {
  const raw = typeof result?.error === 'string' ? result.error : 'Protected Content reported an error.'
  return /not activated|sign in/i.test(raw) ? NOT_SIGNED_IN : raw
}

// A claimed job is executing the plugin action (fetching, storing the key, deleting
// the .acsm); closing its runner would interrupt that. Keep the runner open while
// the reader reports the job running, up to the claim lease.
function releaseWhenIdle(base, id, { sleep, now }) {
  const until = now() + LEASE_MS
  ;(async () => {
    try {
      while (now() < until) {
        await sleep(POLL_MS)
        try {
          if ((await jobStatus(base, id)).state !== 'running') return
        } catch (e) {
          if (!transient(e)) return
        }
      }
    } finally {
      releaseRunner()
    }
  })()
}

/**
 * Asks the reader to fetch the book for the .acsm at `path` (an absolute SD path).
 * Resolves {title?, dest?} when the book is on the reader, or {skipped: guidance}
 * when this reader can't do it (old firmware, no plugin, plugins off). Throws when
 * the fetch fails.
 */
export async function fulfillAcsm({ base, version, path, onPhase = () => {}, onLog = () => {}, sleep = wait, now = Date.now }) {
  if (!supportsPluginJobs(version)) return { skipped: NEEDS_FIRMWARE }
  const args = { path }
  if (utf8Bytes(JSON.stringify(args)) > ARGS_MAX_BYTES) {
    throw new Error('The reader path is too long for Protected Content. Use a shorter folder or file name.')
  }
  if (!hasProtectedContent(await listPlugins(base))) return { skipped: NEEDS_PLUGIN }
  let id
  try {
    id = await submitJob(base, args)
  } catch (e) {
    if (e.status === 403) return { skipped: NEEDS_PLUGINS_ENABLED }
    throw e
  }
  onLog(`Queued ${PLUGIN}/${ACTION} job ${id} for ${path}`)
  onPhase('waiting')

  await acquireRunner(`${base}${RUNNER_PATH}`)
  let mayBeRunning = true
  try {
    let started = false
    const since = now()
    while (true) {
      await sleep(POLL_MS)
      let state, result
      try {
        ;({ state, result } = await jobStatus(base, id))
      } catch (e) {
        if (e.status === 403) throw new Error('Plugins were turned off on the reader.')
        if (!transient(e)) throw e
        if (now() - since > TIMEOUT_MS) throw new Error(TIMED_OUT)
        continue
      }
      const elapsed = now() - since
      if (state === 'pending') {
        if (elapsed > (started ? TIMEOUT_MS : START_TIMEOUT_MS)) throw new Error(started ? TIMED_OUT : NOT_STARTED)
      } else if (state === 'running') {
        if (!started) {
          started = true
          onLog(`Job ${id} started on the reader`)
          onPhase('fetching')
        }
        if (elapsed > TIMEOUT_MS) throw new Error(TIMED_OUT)
      } else if (state === 'done') {
        mayBeRunning = false
        const title = typeof result?.title === 'string' ? result.title : undefined
        const dest = typeof result?.dest === 'string' ? result.dest : undefined
        onLog(`Job ${id} done: ${dest ?? 'no destination reported'}`)
        return { title, dest }
      } else if (state === 'error') {
        mayBeRunning = false
        throw new Error(pluginError(result))
      } else {
        // The firmware recycles finished slots and a restart drops every job, so a
        // vanished job proves nothing either way.
        mayBeRunning = false
        throw new Error(
          started
            ? "The reader finished the fetch job without a result the app could read. Check the reader's library before sending the .acsm again."
            : 'The reader lost the fetch job before it ran.',
        )
      }
    }
  } finally {
    if (mayBeRunning) releaseWhenIdle(base, id, { sleep, now })
    else releaseRunner()
  }
}
