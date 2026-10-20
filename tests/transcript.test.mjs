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
