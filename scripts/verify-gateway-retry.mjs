import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, dirname, basename, join } from 'node:path'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { ProviderError, _internal as core } from '../core.mjs'

// Run with node scripts/verify-gateway-retry.mjs /absolute/path/to/magpie,
// or set MAGPIE_BIN. All provider requests stay on randomly bound loopback
// ports. Every sign-in and configuration used below is synthetic.
const executable = process.argv[2] || process.env.MAGPIE_BIN
if (!executable) throw new Error('Provide the Magpie executable as the first argument or MAGPIE_BIN.')
const temporaryRoot = resolve(tmpdir())
const directory = await mkdtemp(join(temporaryRoot, 'magpie-retry-contract-'))
const configRoot = join(directory, 'config')
const cacheRoot = join(directory, 'cache')
const profileRoot = join(directory, 'profile')
const counts = new Map()
let gateway
let gatewayLog = ''
let mock
let current

const listen = async server => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
const errorMessage = 'Notion response could not be delivered. This attempt has ended. Automatic resubmission is disabled.'
const submittedError = new ProviderError(409, 'empty_answer', 'Synthetic upstream content must stay private.', { retryable: false, submitted: true })
const coreErrorMessage = core.publicError(submittedError).message
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

try {
  for (const path of [join(configRoot, 'magpie'), cacheRoot, profileRoot]) await mkdir(path, { recursive: true })
  mock = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: ['terminal409', 'terminal422', 'transient502', 'shape422', 'ok'].map(id => ({ id, object: 'model' })) }))
      return
    }
    let data = ''
    for await (const chunk of req) data += chunk
    const body = JSON.parse(data || '{}')
    const provider = req.url.split('/')[1]
    const key = current + ':' + provider
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (body.model === 'coreterminal') {
      const response = core.errorResponse(submittedError)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
      return
    }
    const status = provider === 'backup' ? 200 : ({ terminal409: 409, terminal422: 422, transient502: 502, shape422: 422 })[body.model] ?? 200
    res.setHeader('content-type', 'application/json')
    res.setHeader('x-should-retry', 'false')
    res.statusCode = status
    if (body.model === 'embedded422') {
      res.setHeader('content-type', 'text/event-stream')
      res.end('data: ' + JSON.stringify({ error: { message: errorMessage, type: 'notion_error', code: 'empty_answer', status: 422, retryable: false, submitted: true } }) + '\n\n')
      return
    }
    if (status >= 400) {
      res.end(JSON.stringify({ error: { message: body.model === 'shape422' ? 'Unknown parameter: synthetic_field' : errorMessage, type: 'notion_error', code: 'empty_answer', retryable: false, submitted: true } }))
      return
    }
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream')
      const c = (delta, finish_reason = null) => ({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
      res.end([c({ role: 'assistant', content: 'OK' }), c({}, 'stop'), '[DONE]'].map(x => 'data: ' + (typeof x === 'string' ? x : JSON.stringify(x)) + '\n\n').join(''))
    } else res.end(JSON.stringify({ id: 'synthetic', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
  const upstreamPort = await listen(mock)
  const portHolder = createServer()
  const gatewayPort = await listen(portHolder)
  await new Promise(resolve => portHolder.close(resolve))
  const models = ['terminal409', 'terminal422', 'transient502', 'shape422', 'embedded422', 'coreterminal']
  const provider = id => ({ id, name: id, key: 'synthetic-only', chat: `http://127.0.0.1:${upstreamPort}/${id}/v1`, models: id === 'backup' ? ['ok'] : models })
  const primary = { ...provider('primary'), fallback: ['backup/ok'] }
  const shapeControl = { ...provider('shapecontrol'), fallback: ['backup/ok'] }
  await writeFile(join(configRoot, 'magpie', 'providers.json'), JSON.stringify({ providers: [provider('solo'), primary, shapeControl, provider('ssechat'), provider('sseanthro'), provider('backup')], groups: [] }))
  await writeFile(join(configRoot, 'magpie', 'settings.json'), JSON.stringify({ proxy: 'direct', telemetry: false }))
  const env = { ...process.env, USERPROFILE: profileRoot, XDG_CONFIG_HOME: configRoot, XDG_CACHE_HOME: cacheRoot,
    MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_NO_ACCOUNTS: '1', DO_NOT_TRACK: '1', MAGPIE_NO_STATS: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*', NODE_USE_ENV_PROXY: '0' }
  gateway = spawn(executable, ['serve'], { env, cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => { gatewayLog = (gatewayLog + chunk).slice(-12000) })
  const address = `http://127.0.0.1:${gatewayPort}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (gateway.exitCode !== null) throw new Error('Isolated Magpie exited: ' + gatewayLog)
    try {
      const response = await fetch(address + '/v1/models', { signal: AbortSignal.timeout(1000) })
      const data = await response.json()
      if (data.data?.some(x => x.id === 'solo/terminal422')) { ready = true; break }
    } catch {}
    await pause(100)
  }
  assert.ok(ready, 'Isolated Magpie did not expose the synthetic catalog: ' + gatewayLog)
  const results = []
  for (const spec of [
    { name: 'solo409-chat', provider: 'solo', model: 'terminal409', status: 409, attempts: 1 },
    { name: 'solo422-chat', provider: 'solo', model: 'terminal422', status: 422, attempts: 1 },
    { name: 'solo502-chat', provider: 'solo', model: 'transient502', status: 502, attempts: 3 },
    { name: 'primary409-chat', provider: 'primary', model: 'terminal409', status: 409, attempts: 1, backup: 0 },
    { name: 'primary422-chat', provider: 'primary', model: 'terminal422', status: 422, attempts: 1, backup: 0 },
    { name: 'primary502-chat', provider: 'primary', model: 'transient502', status: 200, attempts: 1, backup: 1 },
    { name: 'shape422-control', provider: 'shapecontrol', model: 'shape422', status: 200, attempts: 1, backup: 1 },
    { name: 'solo422-chat-stream', provider: 'solo', model: 'terminal422', status: 422, attempts: 1, stream: true },
    { name: 'solo422-anthropic', provider: 'solo', model: 'terminal422', status: 422, attempts: 1, anthropic: true },
    { name: 'solo422-anthropic-stream', provider: 'solo', model: 'terminal422', status: 422, attempts: 1, anthropic: true, stream: true },
    { name: 'core422-chat-stream', provider: 'solo', model: 'coreterminal', status: 422, attempts: 1, stream: true, expectedMessage: coreErrorMessage },
    { name: 'core422-anthropic-stream', provider: 'solo', model: 'coreterminal', status: 422, attempts: 1, anthropic: true, stream: true, expectedMessage: coreErrorMessage },
    { name: 'embedded422-chat-control', provider: 'ssechat', model: 'embedded422', status: 200, attempts: 3, stream: true },
    { name: 'embedded422-anthropic-control', provider: 'sseanthro', model: 'embedded422', status: 200, attempts: 3, stream: true, anthropic: true },
  ]) {
    current = spec.name
    const input = { model: spec.provider + '/' + spec.model, messages: [{ role: 'user', content: 'Synthetic request' }], stream: !!spec.stream, max_tokens: 32 }
    const response = await fetch(address + (spec.anthropic ? '/v1/messages' : '/v1/chat/completions'), {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer magpie', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    const result = { name: spec.name, http: response.status, attempts: counts.get(spec.name + ':' + spec.provider) ?? 0, backup: counts.get(spec.name + ':backup') ?? 0, shouldRetryHeader: response.headers.get('x-should-retry'), contentType: response.headers.get('content-type'), bodyHasTerminalMessage: text.includes(spec.expectedMessage || errorMessage) }
    console.log(JSON.stringify(result))
    results.push(result)
    assert.equal(response.status, spec.status, spec.name + ' status')
    assert.equal(result.attempts, spec.attempts, spec.name + ' attempts')
    if (spec.backup !== undefined) assert.equal(result.backup, spec.backup, spec.name + ' fallback')
    if (spec.status >= 400) assert.ok(result.bodyHasTerminalMessage, spec.name + ' terminal message')
  }
  console.log(JSON.stringify({ passed: results.length, syntheticOnly: true, notionRequests: 0 }))
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill('SIGTERM')
    await Promise.race([once(gateway, 'exit'), pause(3000)])
  }
  if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)) }
  const target = resolve(directory)
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith('magpie-retry-contract-')) throw new Error('Refusing to remove a path outside this test directory')
  await rm(target, { recursive: true, force: true })
}
