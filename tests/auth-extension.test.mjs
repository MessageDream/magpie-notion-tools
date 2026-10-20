import test from "node:test"
import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"
import { createExtensionLogin } from "../auth-extension.mjs"

const EXTENSION = "abcdefghijklmnopabcdefghijklmnop"
const ORIGIN = `chrome-extension://${EXTENSION}`
const USER = "11111111-1111-4111-8111-111111111111"
const SPACE = "22222222-2222-4222-8222-222222222222"
const OTHER = "33333333-3333-4333-8333-333333333333"
const SESSION = "mock-notion-session"
const identity = () => ({ email: "test@example.invalid", activeUserId: USER, workspaces: [{ spaceId: SPACE, name: "Test" }, { spaceId: OTHER, name: "<script>not executable</script>" }] })

function request(url, { method = "POST", body, origin = ORIGIN, headers = {}, raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const requestHeaders = Object.fromEntries(Object.entries({ ...(origin ? { Origin: origin } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }), ...headers }).filter(([, value]) => value !== undefined))
    const req = httpRequest(url, { method, headers: requestHeaders }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }) })
    })
    req.on("error", reject)
    req.end(payload)
  })
}

async function fixture(t, options = {}, runtime = {}) {
  const calls = []
  const method = createExtensionLogin({ extensionId: EXTENSION, timeoutMs: 5000, loginInfo: async (input) => { calls.push(input); return identity() }, ...options }, runtime)
  const authorization = await method.authorize()
  const url = new URL(authorization.url)
  const nonce = url.hash.slice(1)
  const base = url.origin
  const call = (path, body = {}, options = {}) => request(base + path, { body: { nonce, ...body }, ...options })
  t.after(async () => { await call("/cancel").catch(() => {}); await authorization.callback() })
  return { method, authorization, nonce, base, call, calls }
}

test("connection page has no scripts or secrets and only binds to IPv4 loopback", async (t) => {
  const { authorization, nonce, base } = await fixture(t)
  assert.equal(new URL(base).hostname, "127.0.0.1")
  assert.match(nonce, /^[0-9a-f]{64}$/)
  assert.equal(authorization.method, "auto")
  const page = await request(base + "/connect", { method: "GET", origin: undefined })
  assert.equal(page.status, 200)
  for (const id of ["status", "connect", "workspaces", "confirm", "cancel"]) assert.equal(page.text.includes(`id="${id}"`), true)
  assert.equal(page.text.includes("<script"), false)
  assert.equal(page.text.includes(nonce), false)
  assert.equal(page.text.includes(SESSION), false)
  assert.equal(page.headers["cache-control"], "no-store")
  assert.equal(page.headers["referrer-policy"], "no-referrer")
  assert.equal(page.headers["x-frame-options"], "DENY")
  assert.match(page.text, /<button id="connect"[^>]* disabled>/)
  assert.match(page.text, /未检测到连接扩展/)
  assert.match(page.headers["content-security-policy"], /script-src 'none'/)
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/)
})

test("session validation and explicit workspace confirmation produce host-only credentials", async (t) => {
  const { authorization, call, calls } = await fixture(t)
  assert.deepEqual((await call("/probe")).json(), { ok: true })
  assert.equal(calls.length, 0)
  const session = await call("/session", { key: SESSION })
  assert.equal(session.status, 200)
  assert.deepEqual(session.json(), { email: identity().email, workspaces: identity().workspaces })
  assert.equal(session.text.includes(SESSION), false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].auth.key === SESSION, true)
  const selected = await call("/select", { spaceId: OTHER })
  assert.deepEqual(selected.json(), { ok: true })
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  assert.equal(result.key === SESSION, true)
  assert.deepEqual(result.metadata, { email: identity().email, spaceId: OTHER, activeUserId: USER })
  await assert.rejects(call("/select", { spaceId: OTHER }))
})

test("foreign origin, absent origin, wrong host and wrong nonce cannot submit a session", async (t) => {
  const { call, calls } = await fixture(t)
  for (const options of [{ origin: "https://notion.so" }, { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { origin: "null" }, { origin: "" }, { headers: { Host: "localhost:1234" } }]) {
    const response = await call("/session", { key: SESSION }, options)
    assert.equal(response.status, 403)
    assert.equal(response.headers["access-control-allow-origin"], undefined)
  }
  for (const nonce of ["bad", "a".repeat(64), 1, null]) assert.equal((await call("/session", { nonce, key: SESSION })).status, 403)
  assert.equal(calls.length, 0)
})

test("CORS preflight only allows the fixed extension, POST and content-type", async (t) => {
  const { base } = await fixture(t)
  const headers = { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }
  const allowed = await request(base + "/session", { method: "OPTIONS", headers })
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN)
  assert.equal(allowed.headers["access-control-allow-methods"], "POST")
  assert.equal(allowed.headers["access-control-allow-headers"], "Content-Type")
  assert.equal(allowed.headers["access-control-allow-credentials"], undefined)
  for (const badHeaders of [{ ...headers, "Access-Control-Request-Method": "PUT" }, { ...headers, "Access-Control-Request-Headers": "content-type,x-unexpected" }]) {
    assert.equal((await request(base + "/session", { method: "OPTIONS", headers: badHeaders })).status, 403)
  }
})

test("invalid content types, JSON and oversized bodies never reach the account validator", async (t) => {
  const { base, call, calls, nonce } = await fixture(t)
  assert.equal((await call("/session", { key: SESSION }, { headers: { "Content-Type": "text/plain" } })).status, 415)
  for (const raw of ["{bad", "[]", "null"]) assert.equal((await request(base + "/session", { raw })).status, 400)
  assert.equal((await call("/session", { key: "x".repeat(17 * 1024) })).status, 413)
  assert.equal((await request(base + "/session", { raw: JSON.stringify({ nonce, key: "x".repeat(17 * 1024) }), headers: { "Content-Length": undefined, "Transfer-Encoding": "chunked" } })).status, 413)
  for (const key of ["", "bad value", "bad;value", null]) assert.equal((await call("/session", { key })).status, 400)
  assert.equal(calls.length, 0)
})

test("selection before validation and unknown workspaces are rejected without overwriting the login", async (t) => {
  const { call, authorization } = await fixture(t)
  assert.equal((await call("/select", { spaceId: SPACE })).status, 409)
  await call("/session", { key: SESSION })
  assert.equal((await call("/select", { spaceId: USER })).status, 400)
  await call("/cancel")
  const result = await authorization.callback()
  assert.equal(result.type, "failed")
  assert.equal(Object.hasOwn(result, "key"), false)
})

test("concurrent validation is rejected and a verified session can be retried", async (t) => {
  let release, started
  const begin = new Promise((resolve) => { started = resolve })
  const { call } = await fixture(t, { loginInfo: async () => { started(); await new Promise((resolve) => { release = resolve }); return identity() } })
  const first = call("/session", { key: SESSION })
  await begin
  assert.equal((await call("/session", { key: SESSION })).status, 409)
  release()
  assert.equal((await first).status, 200)
  assert.equal((await call("/session", { key: SESSION })).status, 200)
})

test("verified retries return identity without revalidation and cannot replace the session", async (t) => {
  const { call, calls, authorization } = await fixture(t)
  const first = await call("/session", { key: SESSION })
  assert.equal(first.status, 200)
  const repeated = await call("/session", { key: SESSION })
  assert.equal(repeated.status, 200)
  assert.deepEqual(repeated.json(), first.json())
  assert.equal(repeated.text.includes(SESSION), false)
  assert.equal((await call("/session", { key: "different-mock-session" })).status, 409)
  assert.equal(calls.length, 1)
  assert.equal((await call("/select", { spaceId: SPACE })).status, 200)
  const result = await authorization.callback()
  assert.equal(result.type, "success")
  assert.equal(result.key === SESSION, true)
})

test("cancel aborts an in-flight validation, closes the server and returns no credentials", async (t) => {
  let signal, started
  const begin = new Promise((resolve) => { started = resolve })
  const { call, authorization } = await fixture(t, { loginInfo: ({ signal: inputSignal }) => { signal = inputSignal; started(); return new Promise(() => {}) } })
  const pending = call("/session", { key: SESSION }).catch(() => undefined)
  await begin
  assert.equal((await call("/cancel")).status, 200)
  const result = await authorization.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /已取消/)
  assert.equal(Object.hasOwn(result, "key"), false)
  assert.equal(signal.aborted, true)
  await pending
  await assert.rejects(call("/cancel"))
})

test("timeout closes the listener and leaves existing credentials untouched", async (t) => {
  const { call, authorization } = await fixture(t, { timeoutMs: 40 })
  const result = await authorization.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /已超时/)
  assert.equal(Object.hasOwn(result, "key"), false)
  await assert.rejects(call("/session", { key: SESSION }))
})

test("upstream errors are sanitized and a later session can be verified", async (t) => {
  let attempt = 0
  const { call } = await fixture(t, { loginInfo: async () => { if (!attempt++) throw Object.assign(new Error(SESSION), { status: 401 }); return identity() } })
  const failed = await call("/session", { key: SESSION })
  assert.equal(failed.status, 401)
  assert.equal(failed.text.includes(SESSION), false)
  assert.equal((await call("/select", { spaceId: SPACE })).status, 409)
  assert.equal((await call("/session", { key: SESSION })).status, 200)
})

test("one stalled validation times out, aborts its request and permits retry", async (t) => {
  let attempt = 0, firstSignal
  const { call } = await fixture(t, {
    loginInfo: ({ signal }) => {
      if (!attempt++) { firstSignal = signal; return new Promise(() => {}) }
      return identity()
    },
  }, { verificationTimeoutMs: 30 })
  const failed = await call("/session", { key: SESSION })
  assert.equal(failed.status, 504)
  assert.match(failed.json().error, /验证已超时/)
  assert.equal(firstSignal.aborted, true)
  assert.equal(failed.text.includes(SESSION), false)
  assert.equal((await call("/select", { spaceId: SPACE })).status, 409)
  assert.equal((await call("/session", { key: SESSION })).status, 200)
  assert.equal((await call("/select", { spaceId: SPACE })).status, 200)
})

test("ambiguous account errors have a fixed distinct code and never expose upstream text", async (t) => {
  let attempt = 0
  const { call } = await fixture(t, { loginInfo: async () => {
    if (!attempt++) throw Object.assign(new Error(SESSION), { status: 409, code: "login_account_ambiguous" })
    return identity()
  } })
  const response = await call("/session", { key: SESSION })
  assert.equal(response.status, 409)
  assert.equal(response.json().code, "login_account_ambiguous")
  assert.match(response.json().error, /无法唯一确认/)
  assert.equal(response.text.includes(SESSION), false)
  assert.equal((await call("/session", { key: SESSION })).status, 200)
})

test("a fixed valid extension ID is mandatory", () => {
  for (const extensionId of [undefined, "", "*", "chrome-extension://" + EXTENSION, "z".repeat(32)]) {
    assert.throws(() => createExtensionLogin({ loginInfo: async () => identity(), extensionId }))
  }
})
