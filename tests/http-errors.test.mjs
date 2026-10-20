import test from "node:test"
import assert from "node:assert/strict"
import { readFailurePayload, httpFailure } from "../http-errors.mjs"
import { createPlugin, ProviderError } from "../core.mjs"
import { sessionError } from "../transcript.mjs"

const sensitive = "DO-NOT-LEAK-session-token-prompt"

test("an unexplained 402 retains its endpoint without asserting exhausted credits", () => {
  for (const payload of [undefined, null, {}, [], { code: "payment_required" }, { message: "quota exhausted " + sensitive }]) {
    const error = httpFailure("createAgentThread", 402, payload)
    assert.equal(error.status, 402)
    assert.equal(error.code, "payment_reason_unknown")
    assert.match(error.message, /createAgentThread.*HTTP 402/)
    assert.doesNotMatch(error.message, /exhausted|insufficient|DO-NOT-LEAK|payment_required/)
  }
})

test("arbitrary machine identifiers and free text never enter diagnostics", () => {
  for (const value of [sensitive, "sk-secret", "credits_exhausted " + sensitive, "CREDITS_EXHAUSTED", "x".repeat(20000), 123, {}, ["credits_exhausted"]]) {
    const error = httpFailure(sensitive, 402, {
      code: value, errorCode: value, error: { code: value, message: sensitive }, message: sensitive,
    })
    assert.equal(error.code, "payment_reason_unknown")
    assert.match(error.message, /upstream endpoint/)
    assert.doesNotMatch(error.message, /DO-NOT-LEAK|sk-secret|CREDITS_EXHAUSTED|xxx/)
  }
})

test("only exact recognized reason codes distinguish quota, plan and model restrictions", () => {
  const cases = [
    ["credits_exhausted", "credits_exhausted"],
    ["insufficient_quota", "credits_exhausted"],
    ["notion_exhausted", "credits_exhausted"],
    ["subscription_required", "plan_required"],
    ["upgrade_required", "plan_required"],
    ["model_unavailable", "model_unavailable"],
  ]
  const wrap = [code => ({ code }), code => ({ errorCode: code }), code => ({ error: { code } }), code => ({ error: code })]
  for (const [upstream, expected] of cases) {
    for (const status of [402, 403]) {
      for (const payload of wrap.map(fn => fn(upstream))) {
        const error = httpFailure("createAgentThread", status, { ...payload, message: sensitive })
        assert.equal(error.status, status)
        assert.equal(error.code, expected)
        assert.doesNotMatch(error.message, /DO-NOT-LEAK/)
      }
    }
  }
  assert.equal(httpFailure("createAgentThread", 402, { code: "credits_exhausted", errorCode: "subscription_required" }).code, "payment_reason_unknown")
  assert.equal(httpFailure("createAgentThread", 400, { code: "credits_exhausted" }).code, "upstream_http_error")
})

test("authentication and throttling retain their status semantics", () => {
  const expired = httpFailure("authValidate", 401, { code: "credits_exhausted", message: sensitive })
  assert.equal(expired.code, "session_expired")
  assert.equal(expired.signIn, "expired")
  const throttled = httpFailure("getAvailableModels", 429, { code: "credits_exhausted" }, "0")
  assert.equal(throttled.code, "rate_limited")
  assert.equal(throttled.retryAfter, "0")
})

test("failure bodies parse valid JSON and safely discard malformed or absent bodies", async () => {
  assert.deepEqual(await readFailurePayload(Response.json({ code: "subscription_required" })), { code: "subscription_required" })
  for (const body of [null, "", "<html>" + sensitive + "</html>", '{"code":']) {
    const response = new Response(body, { status: 402 })
    assert.equal(await readFailurePayload(response), undefined)
    assert.equal(response.body?.locked ?? false, false)
  }
})

test("oversized failure bodies are discarded and their streams are cancelled", async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: "x".repeat(16385) }))) },
    cancel() { cancelled = true },
  })
  assert.equal(await readFailurePayload(new Response(stream, { status: 402 })), undefined)
  assert.equal(cancelled, true)
  assert.equal(stream.locked, false)
})

test("failed reads do not expose transport errors or retain stream locks", async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new Error(sensitive)) } })
  assert.equal(await readFailurePayload(new Response(stream, { status: 402 })), undefined)
  assert.equal(stream.locked, false)
})

test("aborting an in-flight or pre-aborted error-body read cancels and releases it", async () => {
  for (const preAborted of [false, true]) {
    const controller = new AbortController()
    const reason = new DOMException("Synthetic cancellation", "AbortError")
    let cancelled = false
    const stream = new ReadableStream({ cancel() { cancelled = true } })
    if (preAborted) controller.abort(reason)
    const pending = readFailurePayload(new Response(stream, { status: 402 }), controller.signal)
    if (!preAborted) controller.abort(reason)
    await assert.rejects(pending, error => error === reason)
    assert.equal(cancelled, true)
    assert.equal(stream.locked, false)
  }
})

test("explicit transcript allowance flags are required for an exhaustion diagnosis", () => {
  for (const value of [undefined, false, 1, "true"]) {
    assert.doesNotThrow(() => sessionError({ last_turn_allowance: { notion_exhausted: value } }))
  }
  assert.throws(() => sessionError({ last_turn_allowance: { notion_exhausted: true } }), { status: 402, code: "credits_exhausted" })
})

test("safe HTTP diagnostics survive JSON and SSE client responses", async () => {
  const error = httpFailure("listenToThreadTranscript", 402, { error: { message: sensitive } })
  assert.ok(error instanceof ProviderError)
  const plugin = createPlugin({
    async open() { return (async function* () { throw error })() },
  })
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: "synthetic-test-only" }))
  for (const stream of [false, true]) {
    const response = await loader.fetch("https://notion.invalid/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Test" }], stream }),
    })
    const output = await response.text()
    assert.match(output, /payment_reason_unknown/)
    assert.match(output, /listenToThreadTranscript.*HTTP 402/)
    assert.doesNotMatch(output, /DO-NOT-LEAK|\[DONE\]|"finish_reason":"stop"/)
    if (stream) {
      assert.equal(response.status, 200)
      assert.match(response.headers.get("Content-Type"), /text\/event-stream/)
      assert.match(output, /data: \{"error"/)
    } else assert.equal(response.status, 402)
  }
})
