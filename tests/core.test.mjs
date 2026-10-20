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
  assert.equal(badOutput.status, 502)
  assert.equal((await badOutput.json()).error.code, "invalid_tool_call")
})

test("unfinished transcripts fail without inventing a successful response", async () => {
  const { send } = await adapter([async function* () { yield { type: "text", text: toolReply } }])
  const response = await send(body())
  assert.equal(response.status, 502)
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

test("invalid SSE tool output reports an error and never a successful tool delta", async () => {
  const { send } = await adapter(["not a JSON envelope"])
  const output = await (await send(body({ stream: true }))).text()
  assert.match(output, /"error"/)
  assert.match(output, /invalid_tool_reply/)
  assert.doesNotMatch(output, /"tool_calls":\[/)
  assert.doesNotMatch(output, /\[DONE\]/)
})

test("pre-cancelled requests never reach the model", async () => {
  const { send, observed } = await adapter([toolReply])
  const controller = new AbortController()
  controller.abort()
  const response = await send(body(), controller.signal)
  assert.equal(response.status, 499)
  assert.equal(observed.length, 0)
})
