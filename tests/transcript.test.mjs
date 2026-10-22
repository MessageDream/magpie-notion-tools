import test from "node:test"
import assert from "node:assert/strict"
import { transcriptEvents } from "../transcript.mjs"

const entity = (text) => ({ id: "assistant", kind: "assistant_message", sequence: 1, content: [{ type: "text", text }] })
const frame = (patches) => ({ type: "agent_service_transcript_delta", patches })
const put = (value) => ({ op: "put", entity: value })
const done = put({ id: "completed", kind: "turn_completed", sequence: 2, source: "committed", stop_reason: "end_turn" })
async function collect(pages, options) {
  const source = (async function* () { yield* pages })()
  return Array.fromAsync(transcriptEvents(source, new AbortController().signal, options))
}

test("buffered tool replies use committed replacements rather than provisional JSON", async () => {
  const draft = '{"text":"Draft","tool_calls":[]}'
  const final = '{"text":"Final","tool_calls":[]}'
  const output = await collect([frame([put(entity(draft))]), frame([put(entity(final)), done])], { buffered: true })
  assert.deepEqual(output, [
    { type: "text", text: final },
    { type: "done", text: final, sequence: 2, finishReason: "stop" },
  ])
})

test("buffered shorter committed text cannot retain a provisional suffix", async () => {
  const output = await collect([frame([put(entity("Final extra draft"))]), frame([put(entity("Final")), done])], { buffered: true })
  assert.equal(output[0].text, "Final")
  assert.equal(output[1].text, "Final")
})

test("buffered append patches and complete transcript pages remain supported", async () => {
  const output = await collect([
    { type: "agent_service_transcript_page", patches: [put(entity("Hel"))] },
    frame([{ op: "patch", id: "assistant", ops: [{ op: "append", path: "/content/0/text", value: "lo" }] }, done]),
  ], { buffered: true })
  assert.equal(output[0].text, "Hello")
})

test("a missing completion marker is an error even when JSON looks complete", async () => {
  await assert.rejects(() => collect([frame([put(entity('{"text":"x","tool_calls":[]}'))])], { buffered: true }), { code: "incomplete_upstream" })
})

test("completed empty and whitespace-only replies stop instead of returning retryable 502", async () => {
  for (const buffered of [false, true]) {
    for (const text of ["", " \n\t"]) {
      await assert.rejects(() => collect([frame([put(entity(text)), done])], { buffered }), error => {
        assert.equal(error.status, 409)
        assert.equal(error.code, "empty_answer")
        assert.match(error.message, /may already have used credits/)
        assert.match(error.message, /automatic regeneration is disabled/i)
        return true
      })
    }
  }
})

test("non-text or unknown entities are not invented into a successful tool response", async () => {
  const secret = "DO-NOT-LEAK-content"
  // Synthetic types deliberately make no assertion about Notion's private
  // schema: unsupported data must fail safely rather than produce fake calls.
  const replies = [
    { ...entity(""), content: [{ type: "synthetic_non_text", text: secret }] },
    { id: "synthetic", kind: "synthetic_unknown_entity", sequence: 1, content: [{ type: "text", text: secret }] },
  ]
  for (const reply of replies) {
    await assert.rejects(() => collect([frame([put(reply), done])], { buffered: true }), error => {
      assert.equal(error.status, 409)
      assert.equal(error.code, "empty_answer")
      assert.doesNotMatch(error.message, /DO-NOT-LEAK/)
      return true
    })
  }
})

test("completed failures cannot ask the gateway to regenerate a finished turn", async () => {
  const reasons = new Map([
    ["runtime_error", "notion_agent_error"],
    ["retries_exhausted", "notion_agent_error"],
    ["requires_action", "notion_action_required"],
    ["synthetic_unknown_reason", "unsupported_stop_reason"],
  ])
  for (const [reason, code] of reasons) {
    const completed = put({ ...done.entity, stop_reason: reason })
    await assert.rejects(() => collect([frame([put(entity("Not a verified success")), completed])], { buffered: true }), { status: 409, code })
  }
})

test("completion markers still require a committed positive sequence", async () => {
  for (const extra of [{ sequence: 0 }, { sequence: 1.5 }, { source: "provisional" }]) {
    const completed = put({ ...done.entity, ...extra })
    await assert.rejects(() => collect([frame([put(entity("Text")), completed])], { buffered: true }), { code: "invalid_transcript" })
  }
})

test("old completed turns cannot finish a resumed response", async () => {
  const oldDone = put({ ...done.entity, sequence: 2 })
  const current = { ...entity("Current"), id: "new-assistant", sequence: 3 }
  const currentDone = put({ ...done.entity, id: "new-completed", sequence: 4 })
  const output = await collect([frame([put(entity("Old")), oldDone, put(current), currentDone])], { buffered: true, afterSequence: 2 })
  assert.deepEqual(output, [
    { type: "text", text: "Current" },
    { type: "done", text: "Current", sequence: 4, finishReason: "stop" },
  ])
})
