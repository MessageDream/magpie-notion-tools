import test from "node:test"
import assert from "node:assert/strict"
import { createPlugin, ProviderError } from "../core.mjs"

const tool = { type: "function", function: { name: "Read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } }
const body = (extra = {}) => ({ model: "test-model", messages: [{ role: "user", content: "Read the file." }], tools: [tool], ...extra })
const envelope = (calls = [], text = "") => JSON.stringify({ text, tool_calls: calls })
const toolReply = envelope([{ name: "Read", arguments: { path: "fixture.txt" } }])

test("advertises tools when an existing Notion provider configured text-only models", async () => {
  const { plugin } = await adapter([])
  const config = { provider: { notion: { name: "My Notion", models: { saved: { name: "Saved model", tool_call: false } } } } }
  await plugin.config(config)
  assert.equal(config.provider.notion.models.saved.tool_call, true)
  assert.equal(config.provider.notion.name, "My Notion")
})

test("an existing Auto model advertises the client tool bridge when configuration is refreshed", async () => {
  const { plugin } = await adapter([])
  const config = { provider: { notion: { models: { auto: { tool_call: true }, manual: { tool_call: false } } } } }
  await plugin.config(config)
  assert.equal(config.provider.notion.models.auto.tool_call, true)
  assert.equal(config.provider.notion.models.manual.tool_call, true)
})

async function adapter(replies, options) {
  const observed = []
  const auth = { type: "api", key: "synthetic-test-only" }
  const protocol = {
    async open(input) {
      observed.push(input)
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return (async function* () {
        if (typeof reply === "function") { yield* reply(input.signal); return }
        yield { type: "text", text: reply }
        yield { type: "done", text: reply, finishReason: "stop" }
      })()
    },
    async models() { return {} },
    async usage() { return { windows: [] } },
  }
  const plugin = createPlugin(protocol, options)
  const loader = await plugin.auth.loader(async () => auth)
  const send = (value, signal) => loader.fetch("https://notion.invalid/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal,
  })
  return { plugin, observed, auth, send, loader }
}

test("unknown tokens remain explicit on buffered, streamed and error replies", async () => {
  for (const stream of [false, true]) {
    for (const reply of ["hello", new ProviderError(429, "rate_limited", "quota", { submitted: true })]) {
      const { send } = await adapter([reply])
      const response = await send({ model: "test-model", messages: [{ role: "user", content: "hello" }], stream })
      assert.equal(response.headers.get("X-Magpie-Tokens-Unknown"), "true")
      assert.equal(response.status, reply instanceof Error ? 429 : 200)
      await response.text()
    }
  }
})

test("preflight failures remain known zero without opening Notion", async () => {
  const { send, observed } = await adapter([])
  const response = await send({ model: "test-model", messages: [] })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get("X-Magpie-Tokens-Unknown"), null)
  assert.equal(observed.length, 0)
})

test("protocol validation failures do not mark unsubmitted tokens unknown", async () => {
  for (const [status, code] of [[403, "model_unavailable"], [400, "reasoning_effort_unavailable"]]) {
    const { send } = await adapter([new ProviderError(status, code, "Unavailable")])
    const response = await send({ model: "test-model", messages: [{ role: "user", content: "hello" }] })
    assert.equal(response.status, status)
    assert.equal(response.headers.get("X-Magpie-Tokens-Unknown"), null)
  }
})

test("full tool round trip retains arguments, result id, and the scoped account", async () => {
  const { send, observed, auth } = await adapter([toolReply, envelope([], "The file contains verified-value.")])
  const first = await (await send(body())).json()
  const assistant = first.choices[0].message
  assert.equal(first.choices[0].finish_reason, "tool_calls")
  assert.equal(assistant.tool_calls[0].function.name, "Read")
  const callId = assistant.tool_calls[0].id
  const second = await (await send(body({ messages: [...body().messages, assistant, { role: "tool", tool_call_id: callId, content: "verified-value" }] }))).json()
  assert.equal(second.choices[0].message.content, "The file contains verified-value.")
  assert.equal(second.choices[0].finish_reason, "stop")
  assert.equal(observed[0].auth, auth)
  assert.equal(observed[0].chat.tools, undefined)
  const result = JSON.parse(observed[1].chat.messages.at(-1).content).tool_results[0]
  assert.equal(result.tool_call_id, callId)
  assert.equal(result.content, "verified-value")
})

test("SSE emits standard tool deltas, tool_calls finish reason and DONE", async () => {
  const { send } = await adapter([toolReply])
  const response = await send(body({ stream: true }))
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const frames = (await response.text()).split("\n\n").filter(Boolean).map((frame) => frame.slice(6))
  assert.equal(frames.at(-1), "[DONE]")
  const chunks = frames.slice(0, -1).map(JSON.parse)
  assert.equal(chunks[0].choices[0].delta.role, "assistant")
  const call = chunks.find((chunk) => chunk.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0]
  assert.equal(call.index, 0)
  assert.equal(call.function.name, "Read")
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "fixture.txt" })
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls")
})

test("plain chat still streams individual upstream text deltas", async () => {
  const { send } = await adapter([async function* () {
    yield { type: "text", text: "Hel" }
    yield { type: "text", text: "lo" }
    yield { type: "done", text: "Hello", finishReason: "stop" }
  }])
  const text = await (await send(body({ tools: [], stream: true }))).text()
  assert.match(text, /"content":"Hel"/)
  assert.match(text, /"content":"lo"/)
  assert.match(text, /"finish_reason":"stop"/)
})

test("committed answer wins over provisional content for buffered tool parsing", async () => {
  const { send } = await adapter([async function* () {
    yield { type: "text", text: "uncommitted provisional text" }
    yield { type: "done", text: toolReply, finishReason: "stop" }
  }])
  const response = await send(body())
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].finish_reason, "tool_calls")
})

test("malformed tools fail before model access; invalid model output cannot call tools", async () => {
  const { send, observed } = await adapter([envelope([{ name: "Unknown", arguments: {} }])])
  const badInput = await send(body({ tools: [{ type: "custom" }] }))
  assert.equal(badInput.status, 400)
  assert.equal(observed.length, 0)
  const badOutput = await send(body())
  assert.equal(badOutput.status, 422)
  assert.equal(badOutput.headers.get("X-Should-Retry"), "false")
  assert.equal((await badOutput.json()).error.code, "invalid_tool_call")
})

test("unfinished transcripts fail without inventing a successful response", async () => {
  const { send } = await adapter([async function* () { yield { type: "text", text: toolReply } }])
  const response = await send(body())
  assert.equal(response.status, 422)
  assert.equal((await response.json()).error.code, "incomplete_upstream")
})

test("auth expiration, quota and transport errors remain safe and accurate", async () => {
  const { send } = await adapter([
    new ProviderError(401, "session_expired", "Session expired."),
    new ProviderError(402, "credits_exhausted", "Credits exhausted."),
    new Error("DO-NOT-LEAK-session-credential"),
  ])
  const expired = await send(body())
  assert.equal(expired.status, 401)
  assert.equal(expired.headers.get("X-Magpie-Sign-In"), "expired")
  const quota = await send(body())
  assert.equal(quota.status, 402)
  assert.equal(quota.headers.has("X-Magpie-Sign-In"), false)
  const transport = await send(body())
  assert.equal(transport.status, 502)
  assert.doesNotMatch(await transport.text(), /DO-NOT-LEAK/)
})

test("invalid streamed tool output is rejected before HTTP success headers", async () => {
  const { send } = await adapter(["not a JSON envelope"])
  const response = await send(body({ stream: true }))
  assert.equal(response.status, 422)
  assert.match(response.headers.get("Content-Type"), /application\/json/)
  assert.equal(response.headers.get("X-Should-Retry"), "false")
  const output = await response.text()
  assert.match(output, /"error"/)
  assert.match(output, /invalid_tool_reply/)
  assert.doesNotMatch(output, /"tool_calls":\[/)
  assert.doesNotMatch(output, /\[DONE\]/)
})

test("a completed empty plain stream returns a terminal HTTP error before 200", async () => {
  const { send } = await adapter([async function* () {
    throw new ProviderError(409, "empty_answer", "Synthetic completed empty answer", { submitted: true, retryable: false })
  }])
  const response = await send(body({ tools: [], stream: true }))
  assert.equal(response.status, 422)
  assert.equal((await response.json()).error.code, "empty_answer")
  assert.equal(response.headers.get("X-Should-Retry"), "false")
})

test("accepted tool IDs and failed parsing are committed to the protocol exactly once", async () => {
  const accepted = [], rejected = []
  let bad = false
  const plugin = createPlugin({
    async open() {
      const events = (async function* () {
        yield { type: "done", text: bad ? "invalid JSON" : toolReply, sequence: 2, finishReason: "stop" }
      })()
      events.accept = async message => { accepted.push(message); return message }
      events.reject = async error => rejected.push(error)
      return events
    },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "synthetic-test-only" }))
  const send = stream => loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify(body({ stream })) })
  const good = await (await send(false)).json()
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0], good.choices[0].message)
  bad = true
  const response = await send(true)
  assert.equal(response.status, 422)
  assert.equal(accepted.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].submitted, true)
})

test("replayed tool completions retain the original client tool IDs", async () => {
  const original = { role: "assistant", content: null, tool_calls: [{ id: "call_original", type: "function", function: { name: "Read", arguments: '{"path":"fixture.txt"}' } }] }
  const plugin = createPlugin({
    async open() {
      const events = (async function* () { yield { type: "done", text: toolReply, finishReason: "stop" } })()
      events.accept = async () => structuredClone(original)
      return events
    },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "synthetic-test-only" }))
  for (const stream of [false, true]) {
    const response = await loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify(body({ stream })) })
    assert.equal(response.status, 200)
    const output = await response.text()
    assert.match(output, /call_original/)
    assert.doesNotMatch(output, /call_[0-9a-f]{32}/)
  }
})

test("tool policy can change without changing the thread's tool catalog identity", async () => {
  const { send, observed } = await adapter([toolReply, envelope([], "Done")])
  await send(body({ tool_choice: "auto" }))
  await send(body({ tool_choice: "none" }))
  assert.equal(observed[0].chat.bridgeContextKey, observed[1].chat.bridgeContextKey)
  assert.deepEqual(observed[0].chat.clientMessages, body().messages)
  assert.equal(observed[0].chat.bridgePolicy.choice, "auto")
  assert.equal(observed[1].chat.bridgePolicy.choice, "none")
})

test("empty final tool envelopes fail without claiming a successful answer", async () => {
  for (const stream of [false, true]) for (const text of ["", "  \n"]) {
    const { send } = await adapter([envelope([], text)])
    const response = await send(body({ stream }))
    assert.equal(response.status, 422)
    const result = await response.json()
    assert.equal(result.error.code, "empty_answer")
    assert.equal(result.error.retryable, false)
    assert.equal(result.choices, undefined)
  }
})

test("cancelling before the first stream chunk closes the prefetched upstream", async () => {
  let closed = 0, rejected = 0
  const plugin = createPlugin({
    async open() {
      const events = (async function* () {
        try { yield { type: "text", text: "Hello" }; yield { type: "done", text: "Hello", finishReason: "stop" } }
        finally { closed++ }
      })()
      events.reject = () => { rejected++ }
      return events
    },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "synthetic-test-only" }))
  const response = await loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify(body({ stream: true, tools: [] })) })
  await response.body.cancel()
  assert.equal(closed, 1)
  assert.equal(rejected, 1)
})

test("pre-cancelled requests never reach the model", async () => {
  const { send, observed } = await adapter([toolReply])
  const controller = new AbortController()
  controller.abort()
  const response = await send(body(), controller.signal)
  assert.equal(response.status, 499)
  assert.equal(observed.length, 0)
})
