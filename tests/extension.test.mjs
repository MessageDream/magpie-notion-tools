import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { EXTENSION_ID, EXTENSION_KEY } from '../extension-config.mjs'
import { createExtensionLogin } from '../auth-extension.mjs'

const originalChrome = globalThis.chrome
globalThis.chrome = { runtime: { onMessage: { addListener() {} } } }
const { handleMessage, validateSender } = await import('../extension/worker.mjs')
if (originalChrome === undefined) delete globalThis.chrome
else globalThis.chrome = originalChrome
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

const nonce = 'a'.repeat(64)
const spaceId = '11111111-1111-4111-8111-111111111111'
const activeUserId = '22222222-2222-4222-8222-222222222222'
const fakeSession = 'synthetic-test-session-not-a-real-credential'
const identity = { email: 'test@example.invalid', activeUserId, workspaces: [{ spaceId, name: '<b>Workspace</b>' }] }
const sender = (url = `http://127.0.0.1:12345/connect#${nonce}`) => ({ id: EXTENSION_ID, frameId: 0, tab: { id: 7 }, url, origin: new URL(url).origin })
function fakeApi(cookie = { domain: '.notion.com', value: fakeSession }) {
  const reads = []
  return { runtime: { id: EXTENSION_ID }, cookies: { get: async args => { reads.push(args); return cookie } }, reads }
}

test('packaged extension identity is fixed and permissions cover only Notion and loopback', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)))
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
    .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('')
  assert.equal(id, EXTENSION_ID)
  assert.equal(manifest.key, EXTENSION_KEY)
  assert.deepEqual(manifest.permissions, ['cookies'])
  assert.deepEqual(manifest.host_permissions, ['https://app.notion.com/*', 'https://www.notion.so/*', 'https://notion.so/*', 'http://127.0.0.1/*'])
  assert.deepEqual(manifest.content_scripts[0].matches, ['http://127.0.0.1/connect'])
  assert.equal(manifest.content_scripts[0].all_frames, false)
  assert.equal(manifest.externally_connectable, undefined)
  assert.equal(manifest.web_accessible_resources, undefined)
  assert.equal(manifest.action.default_popup, 'popup.html')
  assert.ok(readFileSync(new URL('../extension/' + manifest.action.default_popup, import.meta.url)).length > 0)
  for (const path of Object.values(manifest.icons)) assert.ok(readFileSync(new URL('../extension/' + path, import.meta.url)).length > 0)
})

test('foreign senders and malformed connection pages cannot trigger cookie access', async () => {
  const api = fakeApi()
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('must not request') }
  for (const candidate of [
    { ...sender(), id: 'b'.repeat(32) }, { ...sender(), frameId: 1 }, { ...sender(), origin: 'null' },
    sender(`https://127.0.0.1:12345/connect#${nonce}`), sender(`http://localhost:12345/connect#${nonce}`),
    sender(`http://127.0.0.1:12345/connect-fake#${nonce}`), sender(`http://127.0.0.1:12345/connect?target=evil#${nonce}`),
    sender(`http://127.0.0.1:12345/connect#${'b'.repeat(64)}`),
  ]) assert.ok((await handleMessage({ op: 'session', nonce }, candidate, api)).error)
  assert.equal(api.reads.length, 0)
  assert.equal(requests, 0)
  assert.throws(() => validateSender({ op: 'select', nonce, spaceId: 'invalid' }, sender(), EXTENSION_ID))
})

test('failed unauthenticated probe stops before reading any Notion cookie', async () => {
  const api = fakeApi()
  globalThis.fetch = async () => Response.json({ error: 'rejected' }, { status: 403 })
  assert.ok((await handleMessage({ op: 'session', nonce }, sender(), api)).error)
  assert.equal(api.reads.length, 0)
})

test('known ambiguous-account errors stay specific without reflecting server text', async () => {
  globalThis.fetch = async url => Response.json(url.endsWith('/probe') ? { ok: true } : { code: 'login_account_ambiguous', error: fakeSession }, { status: url.endsWith('/probe') ? 200 : 409 })
  const result = await handleMessage({ op: 'session', nonce }, sender(), fakeApi())
  assert.match(result.error, /多个账号/)
  assert.equal(result.error.includes(fakeSession), false)
})

test('worker sends only the named Notion cookie to its initiating loopback host', async () => {
  const api = fakeApi()
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json(url.endsWith('/probe') ? { ok: true } : { ...identity, key: fakeSession })
  }
  const result = await handleMessage({ op: 'session', nonce, url: 'https://example.invalid' }, sender(), api)
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result).includes(fakeSession), false)
  assert.deepEqual(api.reads, [{ url: 'https://app.notion.com', name: 'token_v2' }])
  assert.deepEqual(calls.map(c => c.url), ['http://127.0.0.1:12345/probe', 'http://127.0.0.1:12345/session'])
  for (const { options } of calls) {
    assert.equal(options.mode, 'cors')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.headers.Origin, undefined)
  }
  assert.equal(JSON.stringify(calls[0]).includes(fakeSession), false)
})

test('unknown or expired cookies never reach the session endpoint', async () => {
  for (const cookie of [{ domain: '.notion.com.evil.invalid', value: fakeSession }, { domain: '.notion.com', value: fakeSession, expirationDate: 1 }, undefined]) {
    const api = fakeApi(null)
    api.cookies.get = async args => { api.reads.push(args); return cookie }
    const urls = []
    globalThis.fetch = async url => { urls.push(url); return Response.json({ ok: true }) }
    assert.ok((await handleMessage({ op: 'session', nonce }, sender(), api)).error)
    assert.deepEqual(urls, ['http://127.0.0.1:12345/probe'])
    assert.equal(api.reads.length, 3)
  }
})

test('Chrome domain cookies with a leading dot work on the exact supported Notion hosts', async () => {
  for (const domain of ['.app.notion.com', 'app.notion.com', '.www.notion.so', 'www.notion.so', '.notion.com', '.notion.so']) {
    const urls = []
    globalThis.fetch = async url => { urls.push(url); return Response.json(url.endsWith('/probe') ? { ok: true } : identity) }
    const result = await handleMessage({ op: 'session', nonce }, sender(), fakeApi({ domain, value: fakeSession }))
    assert.equal(result.ok, true, domain)
    assert.equal(urls.at(-1).endsWith('/session'), true)
  }
  globalThis.fetch = async () => Response.json({ ok: true })
  for (const domain of ['.app.notion.com.evil.invalid', '..app.notion.com', '.other.notion.com']) {
    assert.ok((await handleMessage({ op: 'session', nonce }, sender(), fakeApi({ domain, value: fakeSession }))).error)
  }
})

test('synthetic worker and HTTP bridge complete only after explicit workspace selection', async t => {
  const authorization = await createExtensionLogin({ extensionId: EXTENSION_ID, timeoutMs: 5000, loginInfo: async ({ auth }) => {
    assert.equal(auth.key, fakeSession)
    return identity
  } }).authorize()
  const url = new URL(authorization.url)
  const flowNonce = url.hash.slice(1)
  // A synthetic transport models the Origin a real Chrome extension must supply.
  // This does not replace the separate real-browser Origin verification.
  globalThis.fetch = (target, options) => originalFetch(target, { ...options, headers: { ...options.headers, Origin: `chrome-extension://${EXTENSION_ID}` } })
  const api = fakeApi()
  const from = sender(authorization.url)
  t.after(async () => { await handleMessage({ op: 'cancel', nonce: flowNonce }, from, api); await authorization.callback() })
  let completed = false
  const result = authorization.callback().then(value => { completed = true; return value })
  const connected = await handleMessage({ op: 'session', nonce: flowNonce }, from, api)
  assert.equal(connected.ok, true)
  assert.equal(completed, false)
  assert.equal((await handleMessage({ op: 'select', nonce: flowNonce, spaceId }, from, api)).ok, true)
  const saved = await result
  assert.equal(saved.type, 'success')
  assert.equal(saved.key, fakeSession)
  assert.equal(saved.metadata.spaceId, spaceId)
  assert.equal(saved.metadata.email, identity.email)
})
