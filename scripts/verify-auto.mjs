import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname, basename, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import assert from "node:assert/strict"
import { Impit } from "impit"
import protocol, { _internal } from "../protocol.mjs"
import { createPlugin } from "../core.mjs"

if (!process.env.MAGPIE_PLUGIN_AUTH_FILE) throw new Error("Set MAGPIE_PLUGIN_AUTH_FILE to the saved Magpie plugin authentication file. No credentials are printed.")
const saved = JSON.parse(await fs.readFile(process.env.MAGPIE_PLUGIN_AUTH_FILE, "utf8"))
const entries = Object.entries(saved).filter(([id]) => id === "notion" || id.startsWith("notion#"))
assert.equal(entries.length, 1, "Expected exactly one Notion login")
const auth = entries[0][1]
const directory = await fs.mkdtemp(join(tmpdir(), "notion-auto-tools-"))
const input = join(directory, "input.txt"), output = join(directory, "output.txt"), checker = join(directory, "check.mjs")
const marker = "auto-fixture-" + randomUUID()
const contextMarker = "AUTO_CONTEXT_" + randomUUID()
const report = { startedAt: new Date().toISOString(), model: "notion/auto", writes: [], checks: {}, snapshots: [] }
const transport = new Impit({ browser: "chrome", followRedirects: false, ...(process.env.HTTPS_PROXY ? { proxyUrl: process.env.HTTPS_PROXY } : {}) })
const reads = new Set(["authValidate", "getAvailableModels", "getCreditRateLimitStatus", "getAIUsageEligibilityV2", "getThreadTranscript", "listenToThreadTranscript"])
let stage = "setup", threadId, latestText

_internal.useFetch(async (url, init) => {
  const target = new URL(url)
  assert.equal(target.origin, "https://app.notion.com")
  const endpoint = target.pathname.split("/").at(-1)
  const body = JSON.parse(init.body)
  if (["createAgentThread", "sendEventToAgentThread"].includes(endpoint)) {
    assert.ok(!Object.hasOwn(body, "model") && !Object.hasOwn(body, "reasoningEffort"), "Auto wire must not select a manual model")
    assert.ok(report.writes.length < 4, "At most four generation writes are allowed")
    if (endpoint === "createAgentThread") {
      assert.equal(report.writes.length, 0, "Only one thread may be created")
      threadId = body.threadId
    } else {
      assert.equal(body.threadId, threadId, "All turns must use the same thread")
      const text = body.event.content.map(part => part.text.flat(Infinity).join("")).join("")
      assert.ok(!text.includes(contextMarker) && !text.includes('"catalog"'), "Followups must not resend context or tools")
    }
    report.writes.push({ endpoint, bytes: Buffer.byteLength(init.body), autoWire: true })
    console.log(JSON.stringify({ stage, generation: report.writes.length, endpoint, bytes: report.writes.at(-1).bytes }))
  } else assert.ok(reads.has(endpoint), "Unexpected endpoint")
  const response = endpoint === "createAgentThread"
    ? await transport.fetch(url, (({ redirect, ...rest }) => rest)(init))
    : await fetch(url, init)
  if (["createAgentThread", "sendEventToAgentThread"].includes(endpoint)) report.writes.at(-1).status = response.status
  return response
})
const observed = { ...protocol, async open(input) {
  const events = await protocol.open(input)
  const stream = (async function* () {
    for await (const event of events) {
      if (event.type === "done") latestText = event.text
      yield event
    }
  })()
  stream.accept = events.accept?.bind(events)
  stream.reject = events.reject?.bind(events)
  return stream
} }
const loader = await createPlugin(observed, { timeoutMs: 90_000 }).auth.loader(async () => auth)
const tools = [
  { type: "function", function: { name: "ReadTestFile", description: "The client reads the test input file and returns its content.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "WriteTestFile", description: "The client writes the exact input content into the test output file.", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false } } },
  { type: "function", function: { name: "RunTestCheck", description: "The client runs a controlled Node process to compare the test input and output files.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
]
const messages = [
  { role: "system", content: contextMarker },
  { role: "user", content: "Read the input file, write its exact content into the output file, then run the check. After CHECK_OK, answer with the exact input content only. The client implements all three actions in the attached catalog." },
]
async function snapshot(label) {
  const value = await protocol.usage({ auth })
  assert.ok(!value.error && value.windows.some(w => w.name.startsWith("标准")), "Quota must be readable")
  if (label === "before") assert.ok(value.windows.find(w => w.name.startsWith("标准")).used < 100, "Standard credits must be available")
  report.snapshots.push({ stage: label, at: new Date().toISOString(), windows: value.windows, balance: value.balance })
  console.log(JSON.stringify({ quota: report.snapshots.at(-1) }))
}
async function send(history, choice, stream = false) {
  const response = await loader.fetch("https://notion.invalid/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(95_000),
    body: JSON.stringify({ model: "auto", messages: history, tools, tool_choice: choice, parallel_tool_calls: false, max_tokens: 256, stream }),
  })
  if (!response.ok) {
    const body = await response.json()
    const code = body.error?.code
    report.failure = { stage, status: response.status, code: /^[a-z_]+$/.test(code) ? code : "request_failed", retryable: body.error?.retryable }
    throw new Error("Adapter request failed")
  }
  if (!stream) return (await response.json()).choices[0].message
  const message = { role: "assistant", content: "" }, calls = []
  let done = false, finish
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue
    if (line === "data: [DONE]") { done = true; continue }
    const value = JSON.parse(line.slice(6))
    assert.ok(!value.error, "SSE must not contain an error")
    const choice = value.choices?.[0]
    if (choice?.finish_reason) finish = choice.finish_reason
    if (choice?.delta?.content) message.content += choice.delta.content
    for (const call of choice?.delta?.tool_calls ?? []) {
      const item = calls[call.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } }
      if (call.id) item.id = call.id
      if (call.function?.name) item.function.name += call.function.name
      if (call.function?.arguments) item.function.arguments += call.function.arguments
    }
  }
  assert.ok(done && finish === (calls.length ? "tool_calls" : "stop"), "SSE must be complete")
  if (calls.length) { message.tool_calls = calls; if (!message.content) message.content = null }
  return message
}
try {
  await fs.writeFile(input, marker)
  await fs.writeFile(checker, 'import{readFile}from"node:fs/promises";if(await readFile(process.argv[2],"utf8")!==await readFile(process.argv[3],"utf8"))process.exit(1);console.log("CHECK_OK");')
  stage = "catalog"; assert.ok((await protocol.models({ auth })).auto)
  stage = "before"; await snapshot("before")
  for (const [index, name] of ["ReadTestFile", "WriteTestFile", "RunTestCheck"].entries()) {
    stage = name
    // First action is selected automatically; later choices exercise policy updates.
    const choice = index === 0 ? "auto" : { type: "function", function: { name } }
    const answer = await send(messages, choice, index === 1)
    assert.equal(answer.tool_calls?.length, 1, "Expected exactly one action")
    const call = answer.tool_calls[0]
    assert.equal(call.function.name, name, "Unexpected action")
    const args = JSON.parse(call.function.arguments)
    const writesBefore = report.writes.length
    const replay = await send(messages, choice)
    assert.deepEqual(replay, answer, "Replay must preserve the original action and ID")
    assert.equal(report.writes.length, writesBefore, "Replay must not generate")
    let result
    if (index === 0) { assert.deepEqual(args, {}); result = await fs.readFile(input, "utf8") }
    else if (index === 1) { assert.equal(args.content, marker); await fs.writeFile(output, args.content); result = "WRITE_OK" }
    else {
      assert.deepEqual(args, {})
      const { stdout } = await promisify(execFile)(process.execPath, [checker, input, output], { windowsHide: true, timeout: 10_000 })
      assert.equal(stdout.trim(), "CHECK_OK"); result = "CHECK_OK"
    }
    messages.push(answer, { role: "tool", tool_call_id: call.id, content: result })
    report.checks[name] = true
    console.log(JSON.stringify({ step: name, actualExecution: true, duplicateGenerated: false }))
  }
  stage = "final"
  const answer = await send(messages, "none", true)
  assert.equal(answer.content?.trim(), marker)
  assert.ok(!answer.tool_calls?.length)
  const replay = await send(messages, "none")
  assert.equal(replay.content, answer.content)
  assert.equal(report.writes.length, 4)
  report.checks.resultRoundTrip = true
  report.checks.originalToolIdsReplayed = true
  report.checks.deltaOnly = true
  report.checks.streaming = true
  report.checks.complete = true
  console.log(JSON.stringify({ realTest: "passed", checks: report.checks }))
} catch (error) {
  report.failure ??= { stage, code: error.code === "ERR_ASSERTION" ? "verification_assertion" : "verification_failed" }
  if (latestText) report.diagnostic = { responseCharacters: latestText.length }
  console.log(JSON.stringify({ realTest: "failed", failure: report.failure, diagnostic: report.diagnostic }))
  process.exitCode = 1
} finally {
  await snapshot("immediate-after").catch(() => { report.quotaReadFailed = true })
  if (report.writes.length) {
    await new Promise(resolve => setTimeout(resolve, 45_000))
    await snapshot("delayed-after").catch(() => { report.quotaReadFailed = true })
  }
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("notion-auto-tools-")) throw new Error("Unsafe cleanup target")
  await fs.rm(directory, { recursive: true, force: true })
  report.temporaryFilesRemoved = true
  report.finishedAt = new Date().toISOString()
  const destination = new URL("../../outputs/notion-auto-tool-check.json", import.meta.url)
  await fs.mkdir(new URL(".", destination), { recursive: true })
  const previous = JSON.parse(await fs.readFile(destination, "utf8").catch(() => "null"))
  await fs.writeFile(destination, JSON.stringify({ attempts: [...(previous?.attempts ?? []), report], summary: { toolRoundTrip: report.checks.complete === true, automaticRetries: 0 } }, null, 2) + "\n")
  console.log(JSON.stringify({ receiptSaved: true, temporaryFilesRemoved: true }))
}
