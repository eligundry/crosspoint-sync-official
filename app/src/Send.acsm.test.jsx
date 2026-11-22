// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.hoisted(() => { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
vi.mock('./api.js', () => ({ isApp: true }))
vi.mock('./tabbar.js', () => ({ useSheet() {} }))
vi.mock('./catalogs.js', () => ({ downloads: async () => [], sendFile: vi.fn(), sendDownload: vi.fn(), removeDownload: vi.fn() }))
vi.mock('./device.js', async original => ({ ...await original(), connect: async () => ({ base: 'http://reader', status: { version: '2.0.0' } }), folders: async () => ['Library'], listFiles: async () => [] }))
vi.mock('./ui.jsx', async original => ({ ...await original(), notify: vi.fn() }))
vi.mock('./protectedContent.js', async original => ({ ...await original(), fulfillAcsm: vi.fn() }))
const store = vi.hoisted(() => ({ entries: [] }))
vi.mock('./importQueue.js', () => ({
  listImports: async () => store.entries.map(e => ({ ...e })),
  readImport: async entry => new File(['<fulfillmentToken/>'], entry.name),
  removeImport: async id => { store.entries = store.entries.filter(e => e.id !== id) },
  addImport: vi.fn(),
}))
import Send from './Send.jsx'
import { sendFile } from './catalogs.js'
import { fulfillAcsm, NEEDS_PLUGIN } from './protectedContent.js'
import { notify } from './ui.jsx'

beforeEach(() => {
  localStorage.setItem('crosspoint-device', JSON.stringify({ folder: '/Library' }))
  store.entries = [{ id: 'loan', name: 'Loan.acsm', size: 2 }]
  sendFile.mockReset()
  fulfillAcsm.mockReset()
  notify.mockReset()
})
afterEach(() => { cleanup(); localStorage.clear() })

it('asks the reader to fetch an uploaded .acsm and reports the fetched title', async () => {
  sendFile.mockResolvedValue('Loan.acsm')
  fulfillAcsm.mockImplementation(async ({ onPhase }) => { onPhase('fetching'); return { title: 'Gettysburg Address' } })
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await waitFor(() => expect(store.entries).toEqual([]))
  expect(notify).toHaveBeenCalledWith({ title: 'Sent to your reader', detail: 'Gettysburg Address in /Library' })
  expect(fulfillAcsm).toHaveBeenCalledWith(expect.objectContaining({ base: 'http://reader', version: '2.0.0', path: '/Library/Loan.acsm' }))
})

it('keeps the queued .acsm when the fetch fails and fetches the reader copy on retry', async () => {
  sendFile.mockResolvedValueOnce('Loan.acsm').mockRejectedValueOnce('Already on your reader')
  fulfillAcsm.mockRejectedValueOnce(new Error('Protected Content isn\'t signed in.')).mockResolvedValueOnce({ title: 'Book' })
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await screen.findByText(/couldn't fetch the book: Protected Content isn't signed in/)
  expect(store.entries).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Send 1 book' }))
  await waitFor(() => expect(store.entries).toEqual([]))
  expect(fulfillAcsm).toHaveBeenCalledTimes(2)
  expect(fulfillAcsm).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/Library/Loan.acsm' }))
})

it('saves the .acsm with guidance when the reader cannot fetch it', async () => {
  sendFile.mockResolvedValue('Loan.acsm')
  fulfillAcsm.mockResolvedValue({ skipped: NEEDS_PLUGIN })
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await waitFor(() => expect(store.entries).toEqual([]))
  expect(notify).toHaveBeenCalledWith({ title: 'Saved Loan.acsm to your reader', detail: NEEDS_PLUGIN })
})

it('sends other books without the plugin', async () => {
  store.entries = [{ id: 'book', name: 'Book.epub', size: 2 }]
  sendFile.mockResolvedValue('Book.epub')
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await waitFor(() => expect(store.entries).toEqual([]))
  expect(fulfillAcsm).not.toHaveBeenCalled()
})
