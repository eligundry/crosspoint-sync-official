import { beforeEach, expect, it, vi } from 'vitest'

const runner = vi.hoisted(() => ({ acquire: vi.fn(async () => {}), release: vi.fn() }))
vi.mock('./api.js', () => ({ http: vi.fn() }))
vi.mock('./pluginRunner.js', () => ({ acquireRunner: runner.acquire, releaseRunner: runner.release }))

import { http } from './api.js'
import { fulfillAcsm, NEEDS_FIRMWARE, NEEDS_PLUGIN, NEEDS_PLUGINS_ENABLED, supportsPluginJobs } from './protectedContent.js'

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const PLUGINS = [{ name: 'protected-content', title: 'Protected Content' }]

// A fake reader: routes by path; `statuses` are returned in order, the last repeating.
function reader({ plugins = PLUGINS, submit = () => json({ id: 7 }), statuses = [] } = {}) {
  const calls = []
  let n = 0
  http.mockImplementation(async (url, init = {}) => {
    const { pathname, search } = new URL(url)
    calls.push({ path: pathname + search, method: init.method ?? 'GET', body: init.body })
    if (pathname === '/api/plugins') return typeof plugins === 'function' ? plugins() : json(plugins)
    if (pathname === '/api/plugin-jobs') return submit(JSON.parse(init.body))
    if (pathname === '/api/plugin-jobs/status') {
      const next = statuses[Math.min(n++, statuses.length - 1)]
      if (next instanceof Error) throw next
      return next instanceof Response ? next : json(next)
    }
    return new Response('not found', { status: 404 })
  })
  return calls
}

// Each poll advances a fake clock by 2 s without waiting.
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

const run = (opts = {}) => fulfillAcsm({ base: 'http://reader', version: '2.0.0', path: '/Books/Loan.acsm', ...clock(), ...opts })

beforeEach(() => {
  http.mockReset()
  runner.acquire.mockClear()
  runner.release.mockClear()
})

it('needs firmware 2.0.0 or later', () => {
  expect(supportsPluginJobs('1.6.5')).toBe(false)
  expect(supportsPluginJobs(undefined)).toBe(false)
  expect(supportsPluginJobs('2.0.0')).toBe(true)
  expect(supportsPluginJobs('v2.1.3-dev')).toBe(true)
})

it('skips older firmware without asking the reader', async () => {
  reader()
  expect(await run({ version: '1.6.5' })).toEqual({ skipped: NEEDS_FIRMWARE })
  expect(http).not.toHaveBeenCalled()
})

it('queues the fulfill job, keeps the runner open while it runs and returns the book', async () => {
  const calls = reader({ statuses: [{ state: 'pending' }, { state: 'running' }, { state: 'running' }, { state: 'done', result: { title: 'Gettysburg', dest: '/Books/Gettysburg.epub' } }] })
  const phases = []
  const outcome = await run({ onPhase: (p) => phases.push(p) })
  expect(outcome).toEqual({ title: 'Gettysburg', dest: '/Books/Gettysburg.epub' })
  expect(phases).toEqual(['waiting', 'fetching'])
  const submit = calls.find((c) => c.method === 'POST')
  expect(JSON.parse(submit.body)).toEqual({ plugin: 'protected-content', action: 'fulfill', args: { path: '/Books/Loan.acsm' } })
  expect(runner.acquire).toHaveBeenCalledWith('http://reader/plugins-run')
  expect(runner.release).toHaveBeenCalledTimes(1)
})

it('explains a missing plugin and plugins turned off', async () => {
  reader({ plugins: [] })
  expect(await run()).toEqual({ skipped: NEEDS_PLUGIN })
  reader({ plugins: () => new Response('no', { status: 404 }) })
  expect(await run()).toEqual({ skipped: NEEDS_PLUGIN })
  reader({ submit: () => json({ error: 'plugin system disabled' }, 403) })
  expect(await run()).toEqual({ skipped: NEEDS_PLUGINS_ENABLED })
  expect(runner.acquire).not.toHaveBeenCalled()
})

it('translates the not-signed-in error and closes the runner', async () => {
  reader({ statuses: [{ state: 'running' }, { state: 'error', result: { error: 'device not activated; open the plugin UI once to sign in' } }] })
  await expect(run()).rejects.toThrow(/isn't signed in/)
  expect(runner.release).toHaveBeenCalledTimes(1)
})

it('retries status while the reader is busy writing the book', async () => {
  reader({ statuses: [{ state: 'running' }, new TypeError('network'), json({ error: 'busy' }, 503), { state: 'done', result: { title: 'Book' } }] })
  expect(await run()).toEqual({ title: 'Book', dest: undefined })
})

it('gives up when the reader never starts the job', async () => {
  reader({ statuses: [{ state: 'pending' }] })
  await expect(run()).rejects.toThrow(/didn't start fetching/)
  // Pending jobs are not running, so the runner closes once the reader says so.
  await vi.waitFor(() => expect(runner.release).toHaveBeenCalledTimes(1))
})

it('reports a job the reader lost', async () => {
  reader({ statuses: [{ state: 'unknown' }] })
  await expect(run()).rejects.toThrow(/lost the fetch job/)
})

it('refuses args the firmware would reject', async () => {
  reader()
  await expect(run({ path: `/${'a'.repeat(200)}.acsm` })).rejects.toThrow(/too long/)
})
