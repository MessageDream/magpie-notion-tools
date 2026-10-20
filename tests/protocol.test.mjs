import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import protocol, { _internal } from "../protocol.mjs"
import { createPlugin } from "../core.mjs"

const auth = { type: "api", key: "synthetic-protocol-test-only", metadata: { spaceId: "11111111-1111-4111-8111-111111111111", activeUserId: "22222222-2222-4222-8222-222222222222" } }
const threadId = "33333333-3333-4333-8333-333333333333"
const model = "synthetic-model"
const messages = [{ role: "user", content: "Synthetic request" }]
const catalog = () => Response.json({ models: [{ model, modelMessage: "Synthetic model", agentService: {} }] })
const input = (extra = {}) => ({ auth, chat: { model, messages, ...extra }, signal: new AbortController().signal })

function reset() {
  _internal.useFetch(undefined)
  _internal.catalogs.clear()
  _internal.resolved.clear()
  _internal.sessions.clear()
}
beforeEach(reset)
afterEach(reset)

function intercept(handler) {
  const calls = []
  _internal.useFetch(async (url, init) => {
    const endpoint = new URL(url).pathname.split("/").at(-1)
    calls.push(endpoint)
    return handler(endpoint, init, calls)
  })
  return calls
}

test("protocol open reports an unknown createAgentThread 402 after exactly one write", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    assert.equal(endpoint, "createAgentThread")
    return Response.json({ error: { message: "DO-NOT-LEAK secret quota exhausted" } }, { status: 402 })
  })
  await assert.rejects(() => protocol.open(input()), error => {
    assert.equal(error.status, 402)
    assert.equal(error.code, "payment_reason_unknown")
    assert.match(error.message, /createAgentThread.*HTTP 402/)
    assert.doesNotMatch(error.message, /DO-NOT-LEAK|exhausted/)
    return true
  })
  assert.deepEqual(calls, ["getAvailableModels", "createAgentThread"])
})

test("protocol open never retries thread creation after 429 even with Retry-After zero", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    assert.equal(endpoint, "createAgentThread")
    return Response.json({}, { status: 429, headers: { "Retry-After": "0" } })
  })
  await assert.rejects(() => protocol.open(input()), { status: 429, code: "rate_limited", retryAfter: "0" })
  assert.deepEqual(calls, ["getAvailableModels", "createAgentThread"])
})

test("read-only 429 requests have at most two retries", async () => {
  const calls = intercept(endpoint => {
    assert.equal(endpoint, "authValidate")
    return Response.json({}, { status: 429, headers: { "Retry-After": "0" } })
  })
  await assert.rejects(() => protocol.models({ auth }), { status: 429, code: "rate_limited" })
  assert.deepEqual(calls, ["authValidate", "authValidate", "authValidate"])
})

test("read-only retries stop on recovery or an unsupported retry delay", async () => {
  let attempts = 0
  const recovered = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    assert.equal(endpoint, "authValidate")
    attempts++
    return attempts < 3 ? Response.json({}, { status: 429, headers: { "Retry-After": "0" } }) : Response.json({})
  })
  assert.ok((await protocol.models({ auth }))[model])
  assert.deepEqual(recovered, ["authValidate", "authValidate", "authValidate", "getAvailableModels"])
  for (const retryAfter of [undefined, "invalid", "6"]) {
    const calls = intercept(endpoint => {
      assert.equal(endpoint, "authValidate")
      return Response.json({}, { status: 429, headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter } })
    })
    await assert.rejects(() => protocol.models({ auth }), { status: 429, code: "rate_limited" })
    assert.deepEqual(calls, ["authValidate"])
  }
})

test("sendEventToAgentThread failures do not retry writes or create a replacement thread", async () => {
  const completedPage = () => Response.json({
    type: "agent_service_transcript_page", has_more_backward: false,
    session: { sequence: 2, status: "idle" },
    patches: [
      { op: "put", entity: { id: "assistant", kind: "assistant_message", sequence: 1, content: [{ type: "text", text: "Reply" }] } },
      { op: "put", entity: { id: "completed", kind: "turn_completed", sequence: 2, source: "committed", stop_reason: "end_turn" } },
    ],
  })
  for (const status of [402, 429]) {
    reset()
    const calls = intercept(endpoint => {
      if (endpoint === "getAvailableModels") return catalog()
      if (endpoint === "createAgentThread") return Response.json({ threadId })
      if (endpoint === "getThreadTranscript") return completedPage()
      assert.equal(endpoint, "sendEventToAgentThread")
      return Response.json({}, { status, headers: { "Retry-After": "0" } })
    })
    const events = await protocol.open(input())
    await Array.fromAsync(events)
    assert.equal(_internal.sessions.size, 1)
    const followup = [...messages, { role: "assistant", content: "Reply" }, { role: "user", content: "Continue" }]
    await assert.rejects(() => protocol.open(input({ messages: followup })), { status, code: status === 402 ? "payment_reason_unknown" : "rate_limited" })
    assert.deepEqual(calls, ["getAvailableModels", "createAgentThread", "getThreadTranscript", "getThreadTranscript", "sendEventToAgentThread"])
  }
})

test("actual protocol HTTP failures reach plugin clients before stream headers are sent", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    assert.equal(endpoint, "createAgentThread")
    return Response.json({ code: "subscription_required", message: "DO-NOT-LEAK" }, { status: 402 })
  })
  const loader = await createPlugin(protocol).auth.loader(async () => auth)
  for (const stream of [false, true]) {
    const response = await loader.fetch("https://notion.invalid/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream }),
    })
    assert.equal(response.status, 402)
    assert.match(response.headers.get("Content-Type"), /application\/json/)
    const result = await response.json()
    assert.equal(result.error.code, "plan_required")
    assert.match(result.error.message, /createAgentThread.*HTTP 402/)
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-LEAK/)
  }
  assert.equal(calls.filter(name => name === "createAgentThread").length, 2)
})
