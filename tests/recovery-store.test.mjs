import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { SubmissionStore } from "../submission-store.mjs"

const key = "a".repeat(64)
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "notion-ledger-test-"))
  const store = new SubmissionStore()
  try { await store.setStateDir(dir); await fn(store, dir) }
  finally { await store.close(); await rm(dir, { recursive: true, force: true }) }
}

test("durable reservations survive reload and do not expire", async () => fixture(async (store, dir) => {
  await store.reserve(key, { at: 0 })
  await store.close()
  await store.setStateDir(dir)
  assert.equal(store.submissions.get(key).state, "pending")
  await assert.rejects(store.reserve(key), { code: "generation_already_submitted" })
  if (process.platform !== "win32") {
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    assert.equal((await stat(join(dir, "ledger.json"))).mode & 0o777, 0o600)
  }
}))

test("a second process cannot overwrite a live owner's ledger", async () => fixture(async (store, dir) => {
  await store.reserve(key)
  const module = new URL("../submission-store.mjs", import.meta.url).href
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {SubmissionStore} from ${JSON.stringify(module)}; const s=new SubmissionStore(); try { await s.setStateDir(process.argv[1]); process.exitCode=2 } catch(e) { console.log(e.code); process.exitCode=e.code==='ledger_busy'?0:3 }`, dir], { encoding: "utf8", timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /ledger_busy/)
  const persisted = JSON.parse(await readFile(join(dir, "ledger.json"), "utf8"))
  assert.equal(Object.keys(persisted.data.submissions).length, 1)
}))

test("a dead process owner permits recovery without dropping reservations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notion-dead-owner-"))
  const store = new SubmissionStore()
  try {
    const module = new URL("../submission-store.mjs", import.meta.url).href
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {SubmissionStore} from ${JSON.stringify(module)};const s=new SubmissionStore();await s.setStateDir(process.argv[1]);await s.reserve('${key}');`, dir], { encoding: "utf8", timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
    await store.setStateDir(dir)
    assert.equal(store.submissions.get(key).state, "pending")
    await assert.rejects(store.reserve(key), { code: "generation_already_submitted" })
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }) }
})

test("valid JSON corruption fails closed instead of erasing a reservation", async () => fixture(async (store, dir) => {
  await store.reserve(key)
  await store.close()
  const path = join(dir, "ledger.json")
  const data = JSON.parse(await readFile(path, "utf8"))
  data.data.submissions = {}
  await writeFile(path, JSON.stringify(data))
  await assert.rejects(store.setStateDir(dir), { code: "ledger_corrupt" })
  assert.equal(JSON.parse(await readFile(path, "utf8")).checksum, data.checksum)
}))

test("uncertain ownership and an unwritable state path fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notion-state-fail-"))
  try {
    const blocked = join(dir, "blocked")
    await writeFile(blocked, "fixture")
    const first = new SubmissionStore()
    await assert.rejects(first.setStateDir(blocked))
    await mkdir(join(dir, "ownership-gate"))
    const second = new SubmissionStore()
    await assert.rejects(second.setStateDir(dir), { code: "ledger_busy" })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a missing initialized ledger is not treated as a new account", async () => fixture(async (store, dir) => {
  await store.reserve(key)
  await store.close()
  await rm(join(dir, "ledger.json"))
  await assert.rejects(store.setStateDir(dir), { code: "ledger_corrupt" })
}))
