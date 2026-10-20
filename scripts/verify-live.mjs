import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname, basename } from "node:path"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const key = process.env.MAGPIE_GATEWAY_KEY
const model = process.argv[2]
if (!key || !model?.startsWith("notion/")) {
  console.error("Provide MAGPIE_GATEWAY_KEY in the environment and a notion/model-id argument.")
  process.exitCode = 1
} else {
  const directory = await mkdtemp(join(tmpdir(), "magpie-notion-tools-"))
  const marker = "notion-tools-" + randomUUID()
  const input = join(directory, "input.txt")
  const output = join(directory, "output.txt")
  const checker = join(directory, "check.mjs")
  const tools = [
    { type: "function", function: { name: "ReadTestFile", description: "Read the private test fixture. No arguments.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
    { type: "function", function: { name: "WriteTestFile", description: "Write exactly the text returned by ReadTestFile into the test output file.", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false } } },
    { type: "function", function: { name: "RunTestCheck", description: "Run a controlled Node process to check that both test files match. No arguments.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  ]
  const messages = [{ role: "user", content: "Read the test fixture, copy its exact content into the test output file, then run the check. Use the provided tools. After successful verification reply with the exact fixture content and nothing else." }]
  async function request(choice) {
    const response = await fetch("http://127.0.0.1:3425/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, parallel_tool_calls: false, tool_choice: choice, stream: false, max_tokens: 256 }),
    })
    const data = await response.json()
    if (!response.ok || data.error) {
      const code = String(data.error?.code ?? "request_failed")
      throw new Error("Gateway HTTP " + response.status + ": " + (/^[a-z_]+$/.test(code) ? code : "request_failed"))
    }
    const message = data.choices?.[0]?.message
    if (!message) throw new Error("Gateway returned no assistant message.")
    return message
  }
  try {
    await writeFile(input, marker, "utf8")
    await writeFile(checker, 'import {readFile} from "node:fs/promises"; if(await readFile(process.argv[2],"utf8") !== await readFile(process.argv[3],"utf8")) process.exit(1); console.log("CHECK_OK");', "utf8")
    for (const name of ["ReadTestFile", "WriteTestFile", "RunTestCheck"]) {
      const message = await request({ type: "function", function: { name } })
      if (message.tool_calls?.length !== 1 || message.tool_calls[0].function?.name !== name) throw new Error("The expected single test tool was not returned.")
      const call = message.tool_calls[0]
      const args = JSON.parse(call.function.arguments)
      let result
      if (name === "ReadTestFile") result = await readFile(input, "utf8")
      else if (name === "WriteTestFile") {
        if (args.content !== marker) throw new Error("The model did not preserve the tool result.")
        await writeFile(output, args.content, "utf8")
        result = "WRITE_OK"
      } else {
        const { stdout } = await promisify(execFile)(process.execPath, [checker, input, output], { windowsHide: true, timeout: 10_000 })
        if (stdout.trim() !== "CHECK_OK") throw new Error("The child process check failed.")
        result = "CHECK_OK"
      }
      messages.push(message, { role: "tool", tool_call_id: call.id, content: result })
      console.log(JSON.stringify({ step: name, ok: true }))
    }
    const final = await request("none")
    if (final.tool_calls?.length || final.content?.trim() !== marker) throw new Error("The final answer did not preserve the verified tool result.")
    console.log(JSON.stringify({ model, read: true, write: true, processCheck: true, resultRoundTrip: true, requests: 4 }))
  } catch (error) {
    console.error(error instanceof Error && !String(error.message).includes(key) ? error.message : "Live verification failed.")
    process.exitCode = 1
  } finally {
    // Only this process's newly created temporary fixture directory is removed.
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("magpie-notion-tools-")) {
      throw new Error("Refusing to remove a path outside this verification's temporary directory.")
    }
    await rm(directory, { recursive: true, force: true })
  }
}
