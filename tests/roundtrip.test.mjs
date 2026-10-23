import test, { beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, realpath, readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import protocol, { _internal } from "../protocol.mjs"
import { createPlugin } from "../core.mjs"

const model = "synthetic-offline-model"
const auth = { type: "api", key: "synthetic-roundtrip-only", metadata: { spaceId: "11111111-1111-4111-8111-111111111111", activeUserId: "22222222-2222-4222-8222-222222222222" } }
const tools = ["Read", "Write"].map(name => ({ type: "function", function: { name, parameters: { type: "object", properties: {}, additionalProperties: false } } }))
const envelope = (name, text = "") => JSON.stringify({ text, tool_calls: name ? [{ name, arguments: {} }] : [] })
const messages = () => [{ role: "system", content: "SYNTHETIC_LARGE_CONTEXT_".repeat(100) }, { role: "user", content: "Read, write, then confirm." }]

let stateDir
async function reset() {
  _internal.useFetch(undefined)
  _internal.catalogs.clear()
  _internal.resolved.clear()
  await _internal.store.close()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = await mkdtemp(join(tmpdir(), "notion-roundtrip-"))
  await _internal.store.setStateDir(stateDir)
}
beforeEach(async () => reset())
afterEach(async () => {
  _internal.useFetch(undefined)
  await _internal.store.close()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
})

async function fixture(replies) {
  const calls = [], writes = []
  let step = 0, thread
  _internal.useFetch(async (url, init) => {
    const endpoint = new URL(url).pathname.split("/").at(-1)
    const body = JSON.parse(init.body)
    calls.push(endpoint)
    if (endpoint === "getAvailableModels") return Response.json({ models: [{ model, modelMessage: "Synthetic offline model", agentService: {} }] })
    if (["createAgentThread", "sendEventToAgentThread"].includes(endpoint)) {
      writes.push({ endpoint, body })
      if (endpoint === "createAgentThread") thread = body.threadId
      else { assert.equal(body.threadId, thread); step++ }
      return Response.json({ threadId: thread })
    }
    assert.equal(endpoint, "getThreadTranscript")
    return Response.json({
      type: "agent_service_transcript_page", has_more_backward: false,
      session: { sequence: step * 2 + 2, status: "idle" },
      patches: [
        { op: "put", entity: { id: "reply-" + step, kind: "assistant_message", sequence: step * 2 + 1, content: [{ type: "text", text: replies[step] }] } },
        { op: "put", entity: { id: "done-" + step, kind: "turn_completed", sequence: step * 2 + 2, source: "committed", stop_reason: "end_turn" } },
      ],
    })
  })
  const loader = await createPlugin(protocol).auth.loader(async () => auth)
  const send = (history, extra = {}) => loader.fetch("https://notion.invalid/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: history, tools, stream: false, ...extra }) })
  return { send, calls, writes }
}

test("usage receipts correlate restart replay without another submission", async () => {
  const old = process.env.MAGPIE_NOTION_USAGE_DIR
  process.env.MAGPIE_NOTION_USAGE_DIR = join(await realpath(stateDir), "usage")
  try {
    const { send, writes } = await fixture([envelope("Read")])
    assert.equal((await send(messages())).status, 200)
    await _internal.store.close()
    await _internal.store.setStateDir(stateDir)
    assert.equal((await send(messages())).status, 200)
    const rows = await Promise.all((await readdir(process.env.MAGPIE_NOTION_USAGE_DIR))
      .map(async file => JSON.parse(await readFile(join(process.env.MAGPIE_NOTION_USAGE_DIR,file),"utf8"))))
    assert.equal(writes.length,1)
    assert.equal(rows.filter(x=>x.event==="submission_attempt").length,1)
    assert.equal(rows.filter(x=>x.event==="replay_completed").length,1)
    assert.equal(new Set(rows.map(x=>x.submission)).size,1)
    assert.equal(new Set(rows.map(x=>x.attempt)).size,2)
    assert.ok(rows.every(x=>x.tokenUsage.status==="not_reported"))
    assert.ok(!JSON.stringify(rows).includes("SYNTHETIC_LARGE_CONTEXT"))
    assert.ok(!JSON.stringify(rows).includes(auth.key))
  } finally {
    if(old===undefined)delete process.env.MAGPIE_NOTION_USAGE_DIR
    else process.env.MAGPIE_NOTION_USAGE_DIR=old
  }
})

test("an unavailable usage sink cannot fail or resubmit a completed generation", async () => {
  const old = process.env.MAGPIE_NOTION_USAGE_DIR
  process.env.MAGPIE_NOTION_USAGE_DIR = "invalid-relative-receipt-directory"
  try {
    const { send, writes } = await fixture([envelope("Read")])
    assert.equal((await send(messages())).status,200)
    assert.equal((await send(messages())).status,200)
    assert.equal(writes.length,1)
  } finally {
    if(old===undefined)delete process.env.MAGPIE_NOTION_USAGE_DIR
    else process.env.MAGPIE_NOTION_USAGE_DIR=old
  }
})

test("real adapter and protocol execute three tool rounds with one thread and delta-only followups", async () => {
  const { send, writes } = await fixture([envelope("Read"), envelope("Write"), envelope(null, "Verified")])
  const history = messages()
  const first = await (await send(history, { tool_choice: { type: "function", function: { name: "Read" } } })).json()
  const read = first.choices[0].message
  history.push(read, { role: "tool", tool_call_id: read.tool_calls[0].id, content: "SYNTHETIC_READ_RESULT" })
  const secondBody = structuredClone(history)
  const second = await (await send(history, { tool_choice: { type: "function", function: { name: "Write" } } })).json()
  const write = second.choices[0].message
  history.push(write, { role: "tool", tool_call_id: write.tool_calls[0].id, content: "SYNTHETIC_WRITE_OK" })
  const final = await (await send(history, { tool_choice: "none" })).json()
  assert.equal(final.choices[0].message.content, "Verified")
  assert.deepEqual(writes.map(call => call.endpoint), ["createAgentThread", "sendEventToAgentThread", "sendEventToAgentThread"])
  const initial = JSON.stringify(writes[0].body.content)
  assert.match(initial, /SYNTHETIC_LARGE_CONTEXT_|Tool catalog/)
  for (const followup of writes.slice(1)) assert.doesNotMatch(JSON.stringify(followup.body), /SYNTHETIC_LARGE_CONTEXT_|Tool catalog/)
  assert.match(JSON.stringify(writes[1].body), /SYNTHETIC_READ_RESULT/)
  assert.match(JSON.stringify(writes[2].body), /SYNTHETIC_WRITE_OK/)
  assert.doesNotMatch(JSON.stringify(writes[2].body), /SYNTHETIC_READ_RESULT/)
  // Retrying a delivered earlier turn is served locally with its original IDs.
  const replay = await (await send(secondBody, { tool_choice: { type: "function", function: { name: "Write" } } })).json()
  assert.deepEqual(replay.choices[0].message, write)
  assert.equal(writes.length, 3)
})

test("an empty completed turn is terminal and repeated client requests submit no new generation", async () => {
  const { send, writes } = await fixture([""])
  for (const stream of [false, true, false]) {
    const response = await send(messages(), { stream })
    assert.equal(response.status, 422)
    assert.equal((await response.json()).error.retryable, false)
  }
  assert.equal(writes.length, 1)
})

test("unusable tool JSON is never regenerated even when the client changes streaming mode", async () => {
  const { send, writes } = await fixture(["synthetic non-JSON reply"])
  const first = await send(messages())
  assert.equal(first.status, 422)
  assert.equal((await first.json()).error.code, "invalid_tool_reply")
  const retry = await send(messages(), { stream: true })
  assert.equal(retry.status, 422)
  assert.equal(writes.length, 1)
})

test("a lost tool session is stopped without uploading the client's full history again", async () => {
  const { send, writes } = await fixture([envelope("Read")])
  const history = messages()
  const first = await (await send(history)).json()
  const assistant = first.choices[0].message
  history.push(assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "SYNTHETIC_READ_RESULT" })
  _internal.sessions.clear()
  const response = await send(history)
  assert.equal(response.status, 422)
  assert.equal((await response.json()).error.code, "thread_history_missing")
  assert.equal(writes.length, 1)
})

test("removing the tool catalog cannot downgrade a tool continuation into a new full-history thread", async () => {
  const { send, writes } = await fixture([envelope("Read")])
  const history = messages()
  const first = await (await send(history)).json()
  const assistant = first.choices[0].message
  history.push(assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "SYNTHETIC_READ_RESULT" })
  for (const omitted of [[], undefined]) {
    const response = await send(history, { tools: omitted })
    assert.equal(response.status, 422)
    assert.equal((await response.json()).error.code, "tool_catalog_required")
  }
  assert.equal(writes.length, 1)
})
