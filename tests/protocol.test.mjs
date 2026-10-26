import test, { afterEach, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import protocol, { _internal } from "../protocol.mjs"
import { createPlugin } from "../core.mjs"

const auth = { type: "api", key: "synthetic-protocol-test-only", metadata: { spaceId: "11111111-1111-4111-8111-111111111111", activeUserId: "22222222-2222-4222-8222-222222222222" } }
const threadId = "33333333-3333-4333-8333-333333333333"
const model = "synthetic-model"
const messages = [{ role: "user", content: "Synthetic request" }]
const catalog = () => Response.json({ models: [{ model, modelMessage: "Synthetic model", agentService: {} }] })
const input = (extra = {}) => ({ auth, chat: { model, messages, ...extra }, signal: new AbortController().signal })

let stateDir
async function reset() {
  _internal.activeRequests.clear()
  _internal.useFetch(undefined)
  _internal.catalogs.clear()
  _internal.resolved.clear()
  await _internal.store.close()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = await mkdtemp(join(tmpdir(), "notion-protocol-"))
  await _internal.store.setStateDir(stateDir)
}
beforeEach(async () => reset())
afterEach(async () => {
  _internal.useFetch(undefined)
  await _internal.store.close()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
})

function intercept(handler) {
  const calls = []
  _internal.useFetch(async (url, init) => {
    const endpoint = new URL(url).pathname.split("/").at(-1)
    calls.push(endpoint)
    return handler(endpoint, init, calls)
  })
  return calls
}

test("Auto is a named local mode beside the eligible personal-agent catalog", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "authValidate") return Response.json({})
    assert.equal(endpoint, "getAvailableModels")
    return catalog()
  })
  const models = await protocol.models({ auth })
  assert.equal(models.auto.id, "auto")
  assert.equal(models.auto.name, "Notion Auto")
  assert.equal(models.auto.api.id, "auto")
  assert.equal(models.auto.capabilities.toolcall, true)
  assert.equal(models.auto.capabilities.reasoning, false)
  assert.deepEqual(models.auto.variants, {})
  assert.equal(models[model].name, "Synthetic model")
  assert.equal(models[model].capabilities.toolcall, true)
  assert.deepEqual(calls, ["authValidate", "getAvailableModels"])
})

async function autoToolAdapter() {
  const writes = []
  let sequence = 2
  const calls = intercept((endpoint, init) => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") { writes.push(JSON.parse(init.body)); return Response.json({ threadId }) }
    if (endpoint === "sendEventToAgentThread") { writes.push(JSON.parse(init.body)); sequence = 4; return Response.json({}) }
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(sequence, sequence === 2 ? rawToolReply : '{"text":"SYNTHETIC_FRESH_RESULT","tool_calls":[]}')
  })
  const loader = await createPlugin(protocol).auth.loader(async () => auth)
  const tools = [{ type: "function", function: { name: "Read", description: "SYNTHETIC_CATALOG_FIRST_TURN_ONLY", parameters: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false,
  } } }]
  const start = [{ role: "system", content: "SYNTHETIC_OPERATOR_FIRST_TURN_ONLY" }, { role: "user", content: "SYNTHETIC_REQUEST_FIRST_TURN_ONLY" }]
  const first = { model: "auto", messages: start, tools, tool_choice: { type: "function", function: { name: "Read" } } }
  const continuation = (assistant) => ({ model: "auto", tools, tool_choice: "none", messages: [...start, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "SYNTHETIC_FRESH_RESULT" }] })
  const send = (body) => loader.fetch("https://notion.invalid/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  return { calls, writes, first, continuation, send }
}

function assertAutoDelta(writes, callId) {
  assert.equal(writes.length, 2)
  for (const body of writes) {
    assert.equal(Object.hasOwn(body, "model"), false)
    assert.equal(Object.hasOwn(body, "reasoningEffort"), false)
  }
  const initial = writes[0].content[0].text[0][0]
  assert.match(initial, /SYNTHETIC_CATALOG_FIRST_TURN_ONLY/)
  assert.doesNotMatch(initial, /Conversation supplied by the client|\[system\]/)
  const delta = writes[1].event.content[0].text[0][0]
  const packet = JSON.parse(delta.split("BEGIN_CLIENT_PACKET_JSON\n")[1].split("\nEND_CLIENT_PACKET_JSON")[0])
  assert.deepEqual(packet.delta, [{ tool_results: [{ tool_call_id: callId, name: "Read", call_index: 0, content: "SYNTHETIC_FRESH_RESULT" }] }])
  assert.deepEqual(packet.policy, { choice: "none", max_calls: 8 })
  assert.equal(Object.hasOwn(packet, "catalog"), false)
  assert.equal(Object.hasOwn(packet, "conversation"), false)
  assert.doesNotMatch(delta, /SYNTHETIC_CATALOG_FIRST_TURN_ONLY|SYNTHETIC_REQUEST_FIRST_TURN_ONLY|SYNTHETIC_OPERATOR_FIRST_TURN_ONLY|fixture\.txt/)
}

test("the real Auto adapter completes a tool loop and replays both turns without new upstream calls", async () => {
  const { calls, writes, first, continuation, send } = await autoToolAdapter()
  const response = await send(first)
  assert.equal(response.status, 200)
  const initial = await response.json()
  const assistant = initial.choices[0].message
  assert.equal(initial.choices[0].finish_reason, "tool_calls")
  assert.equal(assistant.tool_calls[0].function.name, "Read")
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: "fixture.txt" })
  const next = continuation(assistant)
  const completed = await send(next)
  assert.equal(completed.status, 200)
  const final = await completed.json()
  assert.equal(final.choices[0].message.content, "SYNTHETIC_FRESH_RESULT")
  assert.equal(final.choices[0].finish_reason, "stop")
  const count = calls.length
  const replayedInitial = await (await send(first)).json()
  const replayedFinal = await (await send(next)).json()
  assert.deepEqual(replayedInitial.choices, initial.choices)
  assert.deepEqual(replayedFinal.choices, final.choices)
  assert.equal(calls.length, count)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
  assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 1)
  assertAutoDelta(writes, assistant.tool_calls[0].id)
})

test("the real Auto adapter emits standard SSE tool calls and a verified continuation", async () => {
  const { calls, writes, first, continuation, send } = await autoToolAdapter()
  const chunks = async (response) => {
    assert.equal(response.status, 200)
    assert.match(response.headers.get("Content-Type"), /text\/event-stream/)
    const frames = (await response.text()).split("\n\n").filter(Boolean).map(frame => frame.slice(6))
    assert.equal(frames.at(-1), "[DONE]")
    return frames.slice(0, -1).map(JSON.parse)
  }
  const initial = await chunks(await send({ ...first, stream: true }))
  assert.equal(initial[0].choices[0].delta.role, "assistant")
  const { index, ...call } = initial.find(chunk => chunk.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0]
  assert.equal(index, 0)
  assert.equal(call.type, "function")
  assert.equal(call.function.name, "Read")
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "fixture.txt" })
  assert.equal(initial.at(-1).choices[0].finish_reason, "tool_calls")
  const assistant = { role: "assistant", content: null, tool_calls: [call] }
  const final = await chunks(await send({ ...continuation(assistant), stream: true }))
  assert.equal(final.map(chunk => chunk.choices[0].delta.content ?? "").join(""), "SYNTHETIC_FRESH_RESULT")
  assert.equal(final.at(-1).choices[0].finish_reason, "stop")
  const count = calls.length
  const replay = await chunks(await send({ ...first, stream: true }))
  const replayedCall = replay.find(chunk => chunk.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0]
  assert.equal(replayedCall.id, call.id)
  assert.equal(calls.length, count)
  assertAutoDelta(writes, call.id)
})

test("restricted or empty catalogs do not expose Auto or fall back to a manual model", async () => {
  const entry = { model, modelMessage: "Synthetic model", agentService: {} }
  for (const payload of [
    { models: [entry], modelSelectionRestricted: true },
    { models: [entry], restrictedGeoHiddenModelModes: ["agent_service"] },
    { models: [] },
    { models: [{ ...entry, agentService: { isDisabled: true } }] },
    { models: [{ ...entry, restrictedForPersonalAgent: true }] },
  ]) {
    await reset()
    const calls = intercept(endpoint => {
      if (endpoint === "authValidate") return Response.json({})
      assert.equal(endpoint, "getAvailableModels")
      return Response.json(payload)
    })
    assert.deepEqual(await protocol.models({ auth }), {})
    await assert.rejects(() => protocol.open(input({ model: "auto" })), { status: 403, code: "model_unavailable" })
    assert.deepEqual(calls, ["authValidate", "getAvailableModels"])
  }
})

test("Auto creates and continues an unpinned thread without model or reasoning fields", async () => {
  const writes = []
  let sequence = 2
  const calls = intercept((endpoint, init) => {
    if (endpoint === "getAvailableModels") return Response.json({ models: [{
      model, modelMessage: "Synthetic manual model", agentService: {},
      modelConfiguration: { defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium"] },
    }] })
    if (endpoint === "createAgentThread") { writes.push(JSON.parse(init.body)); return Response.json({ threadId }) }
    if (endpoint === "sendEventToAgentThread") { writes.push(JSON.parse(init.body)); sequence = 4; return Response.json({}) }
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(sequence, sequence === 2 ? "Auto reply" : "Auto continuation")
  })
  const first = await protocol.open(input({ model: "auto", reasoning_effort: "high" }))
  await Array.fromAsync(first)
  const followup = [...messages, { role: "assistant", content: "Auto reply" }, { role: "user", content: "Continue in Auto" }]
  const second = await protocol.open(input({ model: "auto", reasoning_effort: "low", messages: followup }))
  await Array.fromAsync(second)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
  assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 1)
  for (const body of writes) {
    assert.equal(Object.hasOwn(body, "model"), false)
    assert.equal(Object.hasOwn(body, "reasoningEffort"), false)
  }
})

test("manual model requests preserve their model and supported reasoning effort", async () => {
  let posted
  intercept((endpoint, init) => {
    if (endpoint === "getAvailableModels") return Response.json({ models: [{
      model, modelMessage: "Synthetic manual model", agentService: {},
      modelConfiguration: { defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "low"] },
    }] })
    assert.equal(endpoint, "createAgentThread")
    posted = JSON.parse(init.body)
    return Response.json({}, { status: 429 })
  })
  await assert.rejects(() => protocol.open(input({ reasoning_effort: "low" })), { status: 429 })
  assert.equal(posted.model, model)
  assert.equal(posted.reasoningEffort, "low")
})

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
    await reset()
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
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Synthetic request " + stream }], stream }),
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

function completedPage(sequence, reply) {
  return Response.json({
    type: "agent_service_transcript_page", has_more_backward: false,
    session: { sequence, status: "idle" },
    patches: [
      { op: "put", entity: { id: "assistant-" + sequence, kind: "assistant_message", sequence: sequence - 1, content: [{ type: "text", text: reply }] } },
      { op: "put", entity: { id: "completed-" + sequence, kind: "turn_completed", sequence, source: "committed", stop_reason: "end_turn" } },
    ],
  })
}

function toolInput(clientMessages, extra = {}) {
  return input({
    toolBridge: true, bufferedResponse: true, clientMessages,
    bridgeContextKey: "synthetic-tool-catalog",
    bridgePolicy: { choice: "auto", max_calls: 1 },
    messages: [{ role: "system", content: "SYNTHETIC_TOOL_CATALOG" }, { role: "user", content: "FULL_HISTORY_MUST_NOT_BE_REPEATED" }],
    ...extra,
  })
}

const acceptedTool = (id = "client-generated-id") => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "Read", arguments: '{"path":"fixture.txt"}' } }] })
const rawToolReply = JSON.stringify({ text: "", tool_calls: [{ name: "Read", arguments: { path: "fixture.txt" } }] })

test("tool follow-ups reuse one thread and send only new results and the current policy", async () => {
  const writes = []
  let sequence = 0
  const calls = intercept((endpoint, init) => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") { writes.push(JSON.parse(init.body)); sequence = 2; return Response.json({ threadId }) }
    if (endpoint === "sendEventToAgentThread") { writes.push(JSON.parse(init.body)); sequence += 2; return Response.json({}) }
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(sequence, sequence === 2 ? rawToolReply : '{"text":"Verified result","tool_calls":[]}')
  })
  const start = [{ role: "user", content: "SYNTHETIC_ORIGINAL_REQUEST" }]
  const first = await protocol.open(toolInput(start))
  await Array.fromAsync(first)
  const accepted = acceptedTool()
  assert.deepEqual(await first.accept(accepted), accepted)
  const followup = [...start, accepted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "NEW_VERIFIED_RESULT" }]
  const second = await protocol.open(toolInput(followup, { bridgePolicy: { choice: "none", max_calls: 1 } }))
  await Array.fromAsync(second)
  const final = { role: "assistant", content: "Verified result" }
  await second.accept(final)
  const third = await protocol.open(toolInput([...followup, final, { role: "user", content: "NEXT_USER_MESSAGE" }]))
  await Array.fromAsync(third)
  await third.accept(final)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
  assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 2)
  const delta = writes[1].event.content[0].text[0][0]
  assert.match(delta, /NEW_VERIFIED_RESULT/)
  assert.match(delta, /client-generated-id/)
  assert.match(delta, /"name":"Read"/)
  assert.match(delta, /"choice":"none"/)
  assert.doesNotMatch(delta, /SYNTHETIC_TOOL_CATALOG|FULL_HISTORY_MUST_NOT_BE_REPEATED|SYNTHETIC_ORIGINAL_REQUEST|fixture\.txt/)
  const next = writes[2].event.content[0].text[0][0]
  assert.match(next, /NEXT_USER_MESSAGE/)
  assert.doesNotMatch(next, /NEW_VERIFIED_RESULT|SYNTHETIC_TOOL_CATALOG/)
})

test("replaying a successful tool request uses no network and preserves client call IDs", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(2, rawToolReply)
  })
  const start = [{ role: "user", content: "Replay synthetic request" }]
  const first = await protocol.open(toolInput(start))
  const original = await Array.fromAsync(first)
  const accepted = acceptedTool("original-client-id")
  await first.accept(accepted)
  await first.accept(acceptedTool("must-not-replace-id"))
  await first.reject(new Error("must not erase accepted response"))
  const count = calls.length
  const replay = await protocol.open(toolInput(start))
  const replayed = await Array.fromAsync(replay)
  assert.equal(replayed.at(-1).text, original.at(-1).text)
  assert.deepEqual(await replay.accept(acceptedTool("regenerated-client-id")), accepted)
  assert.equal(calls.length, count)
})

test("an in-flight or rejected tool request cannot submit the same generation again", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(2, rawToolReply)
  })
  const request = toolInput([{ role: "user", content: "Do not repeat this turn" }])
  const first = await protocol.open(request)
  await assert.rejects(() => protocol.open(request), { status: 409, code: "generation_already_submitted" })
  await Array.fromAsync(first)
  await first.reject(new Error("synthetic response validation failed"))
  await first.reject(new Error("second rejection must be harmless"))
  await assert.rejects(() => protocol.open(request), { status: 409, code: "generation_already_submitted" })
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
  assert.equal(_internal.sessions.size, 0)
})

test("failed writes are remembered across duplicate opens without a replacement thread", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    assert.equal(endpoint, "createAgentThread")
    return Response.json({}, { status: 429 })
  })
  const request = toolInput([{ role: "user", content: "Failed synthetic request" }])
  await assert.rejects(() => protocol.open(request), error => error.status === 429 && error.submitted === true && error.retryable === false)
  await assert.rejects(() => protocol.open(request), { status: 409, code: "generation_already_submitted" })
  assert.deepEqual(calls, ["getAvailableModels", "createAgentThread"])
})

test("tool histories without a retained matching thread fail before any write", async () => {
  const calls = intercept(endpoint => {
    assert.equal(endpoint, "getAvailableModels")
    return catalog()
  })
  const accepted = acceptedTool()
  const request = toolInput([{ role: "user", content: "Synthetic previous turn" }, accepted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "new result" }])
  await assert.rejects(() => protocol.open(request), { status: 409, code: "thread_history_missing" })
  assert.deepEqual(calls, ["getAvailableModels"])
})

test("changed or busy upstream threads fail closed instead of resending client history", async () => {
  for (const state of ["busy", "changed"]) {
    await reset()
    let precheck = false
    const calls = intercept(endpoint => {
      if (endpoint === "getAvailableModels") return catalog()
      if (endpoint === "createAgentThread") return Response.json({ threadId })
      assert.equal(endpoint, "getThreadTranscript")
      if (precheck) return Response.json({ session: { sequence: state === "changed" ? 8 : 2, status: state === "busy" ? "running" : "idle" } })
      return completedPage(2, rawToolReply)
    })
    const start = [{ role: "user", content: "Synthetic controlled thread" }]
    const first = await protocol.open(toolInput(start))
    await Array.fromAsync(first)
    const accepted = acceptedTool()
    await first.accept(accepted)
    precheck = true
    const next = toolInput([...start, accepted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "controlled result" }])
    await assert.rejects(() => protocol.open(next), { status: 409, code: state === "busy" ? "thread_busy" : "thread_history_changed" })
    assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
    assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 0)
  }
})

test("failed tool-result submission cannot be retried or branched into a fresh thread", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    if (endpoint === "getThreadTranscript") return completedPage(2, rawToolReply)
    assert.equal(endpoint, "sendEventToAgentThread")
    throw new Error("synthetic lost write response")
  })
  const start = [{ role: "user", content: "Synthetic tool turn" }]
  const first = await protocol.open(toolInput(start))
  await Array.fromAsync(first)
  const accepted = acceptedTool()
  await first.accept(accepted)
  const request = toolInput([...start, accepted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "Synthetic new result" }])
  await assert.rejects(() => protocol.open(request), { status: 409, code: "generation_unconfirmed", submitted: true })
  await assert.rejects(() => protocol.open(request), error => error.submitted === true)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
  assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 1)
})

test("tool continuation tolerates equivalent client formatting without resending schemas", async () => {
  let sequence = 2
  let posted
  const calls = intercept((endpoint, init) => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    if (endpoint === "sendEventToAgentThread") { posted = JSON.parse(init.body); sequence = 4; return Response.json({}) }
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(sequence, rawToolReply)
  })
  const first = await protocol.open(toolInput([{ role: "user", content: "Synthetic equivalent history" }]))
  await Array.fromAsync(first)
  const accepted = acceptedTool()
  await first.accept(accepted)
  const reformatted = { tool_calls: [{ function: { arguments: '{ "path": "fixture.txt" }', name: "Read" }, type: "function", id: accepted.tool_calls[0].id }], role: "assistant", content: "", refusal: null }
  const next = await protocol.open(toolInput([{ role: "user", content: [{ type: "text", text: "Synthetic equivalent history" }] }, reformatted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "Synthetic equivalent result" }]))
  await Array.fromAsync(next)
  await next.accept(accepted)
  assert.match(JSON.stringify(posted), /Synthetic equivalent result/)
  assert.doesNotMatch(JSON.stringify(posted), /SYNTHETIC_TOOL_CATALOG/)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

test("parallel results for the same tool preserve IDs and original call positions", async () => {
  let sequence = 2
  let posted
  const calls = intercept((endpoint, init) => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    if (endpoint === "sendEventToAgentThread") { posted = JSON.parse(init.body); sequence = 4; return Response.json({}) }
    assert.equal(endpoint, "getThreadTranscript")
    return completedPage(sequence, rawToolReply)
  })
  const start = [{ role: "user", content: "Synthetic parallel tools" }]
  const first = await protocol.open(toolInput(start))
  await Array.fromAsync(first)
  const accepted = acceptedTool("first-id")
  accepted.tool_calls.push({ id: "second-id", type: "function", function: { name: "Read", arguments: '{"path":"other.txt"}' } })
  await first.accept(accepted)
  const next = await protocol.open(toolInput([...start, accepted,
    { role: "tool", tool_call_id: "second-id", content: "SECOND_RESULT" },
    { role: "tool", tool_call_id: "first-id", content: "FIRST_RESULT" },
  ]))
  await Array.fromAsync(next)
  await next.accept({ role: "assistant", content: "Done" })
  const sent = posted.event.content[0].text[0][0]
  const results = JSON.parse(sent.split("\n\n").at(-1)).tool_results
  assert.deepEqual(results, [
    { tool_call_id: "second-id", name: "Read", call_index: 1, content: "SECOND_RESULT" },
    { tool_call_id: "first-id", name: "Read", call_index: 0, content: "FIRST_RESULT" },
  ])
  assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 1)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

test("an expired tool thread or changed catalog does not silently replay full history", async () => {
  for (const cause of ["expired", "catalog"]) {
    await reset()
    const calls = intercept(endpoint => {
      if (endpoint === "getAvailableModels") return catalog()
      if (endpoint === "createAgentThread") return Response.json({ threadId })
      assert.equal(endpoint, "getThreadTranscript")
      return completedPage(2, rawToolReply)
    })
    const start = [{ role: "user", content: "Synthetic cache lifetime" }]
    const first = await protocol.open(toolInput(start))
    await Array.fromAsync(first)
    const accepted = acceptedTool()
    await first.accept(accepted)
    if (cause === "expired") for (const value of _internal.sessions.values()) value.at = Date.now() - 31 * 60 * 1000
    const next = toolInput([...start, accepted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "NEW_RESULT" }], cause === "catalog" ? { bridgeContextKey: "different-catalog" } : {})
    await assert.rejects(() => protocol.open(next), { status: 409, code: "thread_history_missing" })
    assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
    assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 0)
  }
})

test("concurrent continuations cannot consume the same saved prefix twice", async () => {
  let releaseRead
  let waiting = false
  let sequence = 2
  const calls = intercept(async (endpoint) => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    if (endpoint === "sendEventToAgentThread") { sequence = 4; return Response.json({}) }
    assert.equal(endpoint, "getThreadTranscript")
    if (waiting) { waiting = false; await new Promise(resolve => { releaseRead = resolve }) }
    return completedPage(sequence, rawToolReply)
  })
  const start = [{ role: "user", content: "Synthetic concurrent result" }]
  const first = await protocol.open(toolInput(start))
  await Array.fromAsync(first)
  const accepted = acceptedTool()
  await first.accept(accepted)
  const next = toolInput([...start, accepted, { role: "tool", tool_call_id: accepted.tool_calls[0].id, content: "ONE_RESULT" }])
  waiting = true
  const second = protocol.open(next)
  while (!releaseRead) await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(() => protocol.open(next), { status: 409, code: "thread_busy" })
  releaseRead()
  const events = await second
  await Array.fromAsync(events)
  await events.accept({ role: "assistant", content: "Done" })
  assert.equal(calls.filter(endpoint => endpoint === "sendEventToAgentThread").length, 1)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

test("an interrupted transcript cannot generate the same submitted request again", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    if (endpoint === "getThreadTranscript") return Response.json({ type: "agent_service_transcript_page", has_more_backward: false, session: { sequence: 1, status: "running" }, forward_cursor: "synthetic-cursor", patches: [] })
    assert.equal(endpoint, "listenToThreadTranscript")
    return new Response("")
  })
  const request = toolInput([{ role: "user", content: "Synthetic incomplete stream" }])
  const events = await protocol.open(request)
  await assert.rejects(() => Array.fromAsync(events), error => error.code === "incomplete_upstream" && error.submitted === true && error.retryable === false)
  const recovered = await protocol.open(request)
  await assert.rejects(() => Array.fromAsync(recovered), { code: "incomplete_upstream" })
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

test("read429 recovers the submitted thread after reload and TTL without new generation", async () => {
  let reads = 0
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    assert.equal(endpoint, "getThreadTranscript")
    if (++reads <= 3) return Response.json({}, { status: 429, headers: { "retry-after": "0" } })
    return completedPage(2, rawToolReply)
  })
  const request = toolInput([{ role: "user", content: "PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED" }])
  await assert.rejects(() => protocol.open(request), { status: 429 })
  for (const record of _internal.submissions.values()) record.at = 0
  await _internal.store.persist()
  await _internal.store.setStateDir(stateDir)
  const recovered = await protocol.open(request)
  await Array.fromAsync(recovered)
  const accepted = acceptedTool("durable-tool-id")
  await recovered.accept(accepted)
  await _internal.store.setStateDir(stateDir)
  const replay = await protocol.open(request)
  await Array.fromAsync(replay)
  assert.deepEqual(await replay.accept(acceptedTool("new-id-must-not-win")), accepted)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
  assert.equal(reads, 4)
  const disk = await readFile(join(stateDir, "ledger.json"), "utf8")
  assert.doesNotMatch(disk, /PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED|synthetic-protocol-test-only/)
})

test("a lost create response recovers the reserved thread after restart without another write", async () => {
  let proposed
  const calls = intercept(async (endpoint, init) => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") {
      proposed = JSON.parse(init.body).threadId
      assert.equal([..._internal.submissions.values()][0].threadId, proposed)
      throw new TypeError("Synthetic response lost after creation")
    }
    assert.equal(endpoint, "getThreadTranscript")
    assert.equal(JSON.parse(init.body).threadId, proposed)
    return completedPage(2, rawToolReply)
  })
  const request = toolInput([{ role: "user", content: "Synthetic lost creation reply" }])
  await assert.rejects(() => protocol.open(request), { submitted: true })
  await _internal.store.setStateDir(stateDir)
  const recovered = await protocol.open(request)
  await Array.fromAsync(recovered)
  await recovered.accept(acceptedTool("recovered-id"))
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

test("corrupt durable state stops before any provider request", async () => {
  const calls = intercept(() => { throw new Error("must not reach upstream") })
  await _internal.store.close()
  await writeFile(join(stateDir, "ledger.json"), "{broken")
  await assert.rejects(() => protocol.open(input()), { code: "ledger_corrupt" })
  assert.deepEqual(calls, [])
})

test("failed acceptance persistence never exposes uncommitted IDs in memory", async () => {
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    return completedPage(2, rawToolReply)
  })
  const request = toolInput([{ role: "user", content: "Synthetic interrupted acceptance" }])
  const events = await protocol.open(request)
  await Array.fromAsync(events)
  const marker = join(stateDir, "initialized")
  await rm(marker)
  await mkdir(marker)
  await assert.rejects(events.accept(acceptedTool("committed-before-sync-error")))
  assert.equal([..._internal.submissions.values()][0].state, "pending")
  await assert.rejects(protocol.open(request), { code: "ledger_unavailable" })
  await rm(marker, { recursive: true })
  await writeFile(marker, '{"version":1}')
  await _internal.store.setStateDir(stateDir)
  const replay = await protocol.open(request)
  await Array.fromAsync(replay)
  assert.equal((await replay.accept(acceptedTool("replacement-id"))).tool_calls[0].id, "committed-before-sync-error")
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

test("the adapter returns a safe failure when acceptance cleanup also fails", async () => {
  intercept(async endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    const marker = join(stateDir, "initialized")
    await rm(marker)
    await mkdir(marker)
    return completedPage(2, rawToolReply)
  })
  const loader = await createPlugin(protocol).auth.loader(async () => auth)
  const response = await loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({model:"auto",messages:[{role:"user",content:"Synthetic persistence failure"}]}) })
  assert.equal(response.status, 422)
  assert.equal((await response.json()).error.retryable, false)
})

for (const limit of ["record", "total"]) test(`accepted tool IDs survive the ${limit} replay budget`, async () => {
  const reply = limit === "record" ? "x".repeat(1024 * 1024 + 1) : rawToolReply
  const calls = intercept(endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    if (endpoint === "createAgentThread") return Response.json({ threadId })
    return completedPage(2, reply)
  })
  if (limit === "total") _internal.submissions.set("b".repeat(64), {state:"completed",bytes:8*1024*1024})
  const request = toolInput([{role:"user",content:"Synthetic cache budget " + limit}])
  const events = await protocol.open(request)
  await Array.fromAsync(events)
  const accepted = acceptedTool("retained-budget-id")
  await events.accept(accepted)
  assert.equal((await events.accept(acceptedTool("wrong-id"))).tool_calls[0].id, "retained-budget-id")
  await _internal.store.setStateDir(stateDir)
  const record = [..._internal.submissions.values()].find(value => value.acceptedToolIds)
  assert.deepEqual(record.acceptedToolIds, ["retained-budget-id"])
  const before = calls.length
  await assert.rejects(protocol.open(request), {code:"generation_already_submitted"})
  assert.equal(calls.length, before)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})

for (const status of [402, 429]) test(`upstream ${status} survives a failed failure-record write`, async () => {
  const calls = intercept(async endpoint => {
    if (endpoint === "getAvailableModels") return catalog()
    assert.equal(endpoint, "createAgentThread")
    const marker = join(stateDir, "initialized")
    await rm(marker)
    await mkdir(marker)
    return Response.json({}, {status,headers:{"retry-after":"0"}})
  })
  const loader = await createPlugin(protocol).auth.loader(async () => auth)
  const send = () => loader.fetch("https://notion.invalid/v1/chat/completions", {method:"POST",body:JSON.stringify({model:"auto",messages:[{role:"user",content:"Synthetic combined failure " + status}]})})
  const first = await send()
  assert.equal(first.status, status)
  assert.equal((await first.json()).error.retryable, false)
  assert.equal((await send()).status, 422)
  assert.equal(calls.filter(endpoint => endpoint === "createAgentThread").length, 1)
})
