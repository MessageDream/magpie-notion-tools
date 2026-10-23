import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, open, lstat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { ProviderError } from "./core.mjs"

const checksum = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const fail = (code, message) => new ProviderError(503, code, message, { retryable: false })
function stateDir() {
  return process.env.MAGPIE_NOTION_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "magpie-notion-tools")
}
async function regular(path, directory = false) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw fail("ledger_unsafe", "The recovery state path is not a private regular file or directory.")
}
async function syncDir(dir) {
  if (process.platform === "win32") return
  const file = await open(dir, "r")
  try { await file.sync() } finally { await file.close() }
}
async function atomic(dir, name, value) {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`)
  let file
  try {
    file = await open(temp, "wx", 0o600)
    await file.writeFile(JSON.stringify(value))
    await file.sync()
    await file.close(); file = undefined
    await rename(temp, join(dir, name))
    await syncDir(dir)
  } finally {
    await file?.close().catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
  }
}

export class SubmissionStore {
  constructor() {
    this.sessions = new Map()
    this.submissions = new Map()
    this.queue = Promise.resolve()
    this.owner = randomUUID()
  }
  enqueue(task) {
    const result = this.queue.then(task)
    this.queue = result.catch(() => {})
    return result
  }
  async gate(task) {
    const path = join(this.dir, "ownership-gate")
    try { await mkdir(path, { mode: 0o700 }) }
    catch { throw fail("ledger_busy", "Recovery state ownership is busy or uncertain. No generation was submitted.") }
    try { return await task() }
    finally { await rm(path, { recursive: true }); await syncDir(this.dir) }
  }
  async acquire() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await regular(this.dir, true)
    await chmod(this.dir, 0o700)
    await this.gate(async () => {
      const path = join(this.dir, "owner.json")
      let owner
      try { await regular(path); owner = JSON.parse(await readFile(path, "utf8")) }
      catch (error) { if (error.code !== "ENOENT") throw fail("ledger_ownership_unknown", "Recovery state ownership cannot be verified.") }
      if (owner) {
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.id !== "string") throw fail("ledger_ownership_unknown", "Recovery state ownership is invalid.")
        if (owner.id !== this.owner) {
          let alive = true
          try { process.kill(owner.pid, 0) } catch (error) { if (error.code === "ESRCH") alive = false }
          if (alive) throw fail("ledger_busy", "Another process owns this recovery state. No generation was submitted.")
        }
      }
      await atomic(this.dir, "owner.json", { pid: process.pid, id: this.owner })
      this.owned = true
    })
  }
  async close() {
    await this.queue
    if (this.owned) await this.gate(async () => {
      const owner = JSON.parse(await readFile(join(this.dir, "owner.json"), "utf8"))
      if (owner.id !== this.owner) throw fail("ledger_ownership_unknown", "Recovery state ownership changed.")
      await rm(join(this.dir, "owner.json"))
      this.owned = false
    })
    this.loaded = false
  }
  async setStateDir(dir) {
    await this.close()
    this.dir = dir
    this.poisoned = false
    this.sessions.clear(); this.submissions.clear()
    return this.load()
  }
  async load() {
    if (this.poisoned) throw fail("ledger_unavailable", "A recovery write failed. Restart and verify the ledger before continuing.")
    if (this.loading) return this.loading
    if (this.loaded) return
    this.loading = this.enqueue(async () => {
      this.dir ||= stateDir()
      await this.acquire()
      let saved
      try {
        const path = join(this.dir, "ledger.json")
        await regular(path)
        saved = JSON.parse(await readFile(path, "utf8"))
      } catch (error) {
        if (error.code === "ENOENT") {
          try { await lstat(join(this.dir, "initialized")) }
          catch (missing) { if (missing.code === "ENOENT") { this.loaded = true; return } }
          throw fail("ledger_corrupt", "An initialized recovery ledger is missing. Restore it before generating.")
        }
        throw fail("ledger_corrupt", "Recovery state cannot be read. Restore the ledger before generating.")
      }
      const data = saved?.data
      if (saved.version !== 1 || !data || saved.checksum !== checksum(data) || !data.sessions || !data.submissions || Array.isArray(data.sessions) || Array.isArray(data.submissions)) throw fail("ledger_corrupt", "Recovery state is corrupt. Restore the ledger before generating.")
      for (const [key, value] of Object.entries(data.submissions)) {
        if (!/^[a-f0-9]{64}$/.test(key) || !["pending", "failed", "completed"].includes(value?.state)) throw fail("ledger_corrupt", "Recovery state contains an invalid submission.")
      }
      this.submissions.clear(); this.sessions.clear()
      for (const [key, value] of Object.entries(data.submissions)) this.submissions.set(key, value)
      for (const [key, value] of Object.entries(data.sessions)) this.sessions.set(key, value)
      this.loaded = true
    }).finally(() => { this.loading = undefined })
    return this.loading
  }
  async reserve(key, initial = {}) {
    await this.load()
    return this.enqueue(async () => {
      if (this.submissions.has(key)) throw fail("generation_already_submitted", "This request already has a durable submission record.")
      const record = { state: "pending", at: Date.now(), ...initial }
      const next = new Map(this.submissions).set(key, record)
      await this.persist(next)
      this.submissions.set(key, record)
      return { record: structuredClone(record), created: true }
    })
  }
  async updateSubmission(key, patch) {
    return this.enqueue(async () => {
      const previous = this.submissions.get(key)
      if (!previous) throw fail("ledger_corrupt", "The submission record is missing.")
      // A late reader cannot erase an already accepted turn.
      if (previous.state === "completed") return structuredClone(previous)
      const record = { ...previous, ...patch, at: Date.now() }
      await this.persist(new Map(this.submissions).set(key, record))
      this.submissions.set(key, record)
      return structuredClone(record)
    })
  }
  async complete(key, record, sessionKey, session) {
    return this.enqueue(async () => {
      const previous = this.submissions.get(key)
      if (!previous) throw fail("ledger_corrupt", "The submission record is missing.")
      if (previous.state === "completed") return structuredClone(previous)
      const sessions = new Map(this.sessions)
      while (!sessions.has(sessionKey) && sessions.size >= 256) sessions.delete(sessions.keys().next().value)
      sessions.set(sessionKey, session)
      await this.persist(new Map(this.submissions).set(key, record), sessions)
      this.submissions.set(key, structuredClone(record))
      this.sessions.clear()
      for (const [id, value] of sessions) this.sessions.set(id, value)
      return structuredClone(record)
    })
  }
  async removeSession(key) {
    return this.enqueue(async () => {
      const next = new Map(this.sessions)
      next.delete(key)
      await this.persist(this.submissions, next)
      this.sessions.delete(key)
    })
  }
  async persist(submissions = this.submissions, sessions = this.sessions) {
    if (this.poisoned) throw fail("ledger_unavailable", "A recovery write failed. Restart before continuing.")
    if (!this.owned) throw fail("ledger_ownership_unknown", "Recovery state has no verified owner.")
    const data = { submissions: Object.fromEntries(submissions), sessions: Object.fromEntries(sessions) }
    if (Buffer.byteLength(JSON.stringify(data)) > 64 * 1024 * 1024) throw fail("ledger_full", "The recovery ledger reached its storage limit. No further generation is permitted.")
    try {
      await atomic(this.dir, "ledger.json", { version: 1, checksum: checksum(data), data })
      await atomic(this.dir, "initialized", { version: 1 })
    } catch (error) { this.poisoned = true; throw error }
  }
}
export const submissionStore = new SubmissionStore()
export const _internal = { stateDir }
