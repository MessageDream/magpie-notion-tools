import { createHash, randomUUID } from "node:crypto"
import { ProviderError } from "./core.mjs"
import { readNDJSON, transcriptEvents, sessionError } from "./transcript.mjs"
import { readFailurePayload, httpFailure } from "./http-errors.mjs"
import { formatToolPlanner } from "./tools.mjs"
import { submissionStore } from "./submission-store.mjs"
import { creditSnapshot, recordUsage, unknownTokens } from "./usage.mjs"

const ORIGIN = "https://app.notion.com"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sessions = submissionStore.sessions
const submissions = submissionStore.submissions
const catalogs = new Map()
const TTL = 30 * 60 * 1000
const MAX_REPLAY_BYTES = 1024 * 1024
const MAX_TOTAL_REPLAY_BYTES = 8 * 1024 * 1024
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const moduleFetch = globalThis.fetch
const CONTROL = /[\x00-\x1f\x7f]/
const READ_RETRIES = new Set([
  "getSpaces",
  "getAvailableModels",
  "authValidate",
  "getThreadTranscript",
  "getCreditRateLimitStatus",
  "getAIUsageEligibilityV2",
])
const MAX_READ_RETRIES = 2
const MAX_BACKWARD_PAGES = 8
let impitClient
let impitLoading
let fetchOverride

// A stable UUID for Notion's device cookie. The session token selects it, so
// repeated requests look like one browser without writing a new identifier
// back into the saved sign-in.
function deviceId(token) {
  const bytes = createHash("sha256").update(token).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function cookieFields(header) {
  return header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=")
    if (separator < 1) return { name: part, value: undefined }
    return { name: part.slice(0, separator).trim(), value: part.slice(separator + 1) }
  })
}

function hasUser(value, activeUserId) {
  if (typeof value !== "string" || !value) return false
  try {
    return decodeURIComponent(value).includes(activeUserId)
  } catch {
    return value.includes(activeUserId)
  }
}

// The web client sends a device cookie and a notion_users cookie naming the
// active account. Derive the former from token_v2 and add the latter when the
// sign-in names a user, keeping every other cookie exactly as supplied.
function normalizeCookie(header, activeUserId) {
  const fields = cookieFields(header)
  if (!fields.some((field) => field.name === "device_id")) {
    const token = fields.find((field) => field.name === "token_v2")?.value
    if (token !== undefined && token !== "") fields.push({ name: "device_id", value: deviceId(token) })
  }
  if (activeUserId && !fields.some((field) => field.name === "notion_users" && hasUser(field.value, activeUserId))) {
    const encoded = encodeURIComponent(JSON.stringify([activeUserId]))
    const existing = fields.find((field) => field.name === "notion_users")
    if (existing) existing.value = encoded
    else fields.push({ name: "notion_users", value: encoded })
  }
  return fields.map((field) => field.value === undefined ? field.name : `${field.name}=${field.value}`).join("; ")
}

async function impit() {
  if (impitClient) return impitClient
  if (!impitLoading) {
    impitLoading = import("impit")
      .then(({ Impit }) => (impitClient = new Impit({ browser: "chrome", followRedirects: false })))
      .catch(() => {
        impitLoading = undefined
        throw new ProviderError(503, "transport_unavailable", "Reinstall the plugin so Magpie can install its impit dependency.")
      })
  }
  return impitLoading
}

async function request(name, url, init) {
  if (fetchOverride) return fetchOverride(url, init)
  // Only thread creation needs Chrome's browser fingerprint. Other calls keep
  // the fetch captured at module load so a host replacing globalThis.fetch
  // cannot silently change their transport.
  if (name !== "createAgentThread") return moduleFetch(url, init)
  const client = await impit()
  // The shared client already refuses redirects. Omit the unsupported
  // request-level option on the first write instead of retrying a POST after
  // a transport exception that may have followed a successful submission.
  const { redirect, ...withoutRedirect } = init
  return client.fetch(url, withoutRedirect)
}

function useFetch(fetch) {
  if (fetch !== undefined && typeof fetch !== "function") throw new TypeError("The Notion fetch override must be a function.")
  fetchOverride = fetch
}

function wait(ms, signal) {
  if (!ms) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      signal.removeEventListener("abort", aborted)
      reject(signal.reason)
    }
    if (signal?.aborted) aborted()
    else signal?.addEventListener("abort", aborted, { once: true })
  })
}

// Accept either the token value by itself or a Cookie header the user pasted by
// mistake. Only token_v2 is kept, so unrelated pasted cookies never reach the
// upstream request.
function cookie(auth) {
  const reject = () => new ProviderError(401, "session_required", "请粘贴 Notion 的 token_v2。")
  if (auth?.type !== "api" || typeof auth.key !== "string" || CONTROL.test(auth.key)) throw reject()
  const pasted = auth.key.trim().replace(/^Cookie\s*:\s*/i, "")
  if (!pasted) throw reject()
  const field = cookieFields(pasted).find((entry) => entry.name === "token_v2")
  if (field) {
    const token = field.value?.trim()
    if (!token || CONTROL.test(token)) throw reject()
    return `token_v2=${token}`
  }
  // A Cookie header without token_v2 is not a token, even when it has one field.
  if (pasted.includes("=") || pasted.includes(";")) throw reject()
  return `token_v2=${pasted}`
}

// A field the sign-in left blank is not a value: an unanswered optional prompt
// is saved as an empty string, and a blank workspace or user must mean
// "discover it" the same way an absent one does.
function optional(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string" && !value.trim()) return undefined
  return value
}

// credentials reads the pasted token and the workspace/user metadata where the
// account carries them. The workspace is not required: an account without one
// has it resolved from the session itself, so nobody has to type a UUID.
function credentials(auth) {
  const key = cookie(auth)
  const metadata = auth?.metadata ?? {}
  const spaceId = optional(metadata.spaceId)
  if (spaceId !== undefined && (typeof spaceId !== "string" || !UUID.test(spaceId))) throw new ProviderError(400, "workspace_required", "The Notion workspace id must be a UUID.")
  const activeUserId = optional(metadata.activeUserId)
  if (activeUserId !== undefined && (typeof activeUserId !== "string" || !UUID.test(activeUserId))) throw new ProviderError(400, "invalid_active_user", "The Notion active user id must be a UUID.")
  return { cookie: key, spaceId, activeUserId }
}

async function call(name, data, account, signal) {
  const headers = {
    Accept: name === "listenToThreadTranscript" ? "application/x-ndjson" : "application/json",
    "Content-Type": "application/json",
    Cookie: normalizeCookie(account.cookie, account.activeUserId),
    Origin: ORIGIN,
    "notion-audit-log-platform": "web",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  }
  if (account.spaceId) headers["x-notion-space-id"] = account.spaceId
  if (account.activeUserId) headers["x-notion-active-user-header"] = account.activeUserId
  for (let attempt = 0; ; attempt++) {
    const response = await request(name, `${ORIGIN}/api/v3/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(data), signal, redirect: "error",
    })
    if (response.ok) return response
    const retryAfter = response.headers.get("Retry-After")?.trim()
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined
    if (response.status === 429 && READ_RETRIES.has(name) && attempt < MAX_READ_RETRIES && Number.isSafeInteger(seconds) && seconds <= 5) {
      await response.body?.cancel().catch(() => {})
      await wait(seconds * 1000, signal)
      continue
    }
    const failure = await readFailurePayload(response, signal)
    throw httpFailure(name, response.status, failure, retryAfter)
  }
}

const resolved = new Map()
const RESOLVED_TTL = 30 * 60 * 1000

// workspace asks the session which workspace its AI can be asked in: getSpaces
// names the ones the user belongs to, and the one that answers the model
// catalog is the account's. The answer is kept, so the question is asked once
// per session instead of on every request.
//
// One entry of getSpaces belongs to one user and lists that user's workspaces,
// so the entry's own key is the user those workspaces belong to. The
// notion_user table beside it can name other members of the same workspaces,
// and taking the first user named anywhere in the reply would send
// x-notion-active-user-header naming someone who is not the account.
async function workspace(read, signal) {
  const key = digest([read.cookie, read.activeUserId])
  const cached = resolved.get(key)
  if (cached && Date.now() - cached.at < RESOLVED_TTL) return cached
  const body = await json("getSpaces", {}, { cookie: read.cookie, activeUserId: read.activeUserId }, signal)
  const owners = new Map()
  const candidates = []
  for (const [entryKey, entry] of Object.entries(body ?? {})) {
    if (!entry || typeof entry !== "object") continue
    const users = Object.keys(entry.notion_user ?? {}).filter((id) => UUID.test(id))
    // The entry's key names its user; only an entry with exactly one listed
    // user can stand in for it, because with several there is no telling which
    // one the session is.
    const owner = UUID.test(entryKey) ? entryKey : users.length === 1 ? users[0] : undefined
    for (const spaceId of Object.keys(entry.space ?? {})) {
      if (!UUID.test(spaceId) || owners.has(spaceId)) continue
      owners.set(spaceId, owner)
      candidates.push(spaceId)
    }
  }
  if (!candidates.length) throw new ProviderError(404, "workspace_not_found", "This Notion session belongs to no workspace the AI can be asked in.")
  let last
  let readable
  for (const spaceId of candidates) {
    // A user the sign-in states is the account it meant; otherwise the entry
    // that lists this workspace names the user it belongs to.
    const user = read.activeUserId ?? owners.get(spaceId)
    const answer = { cookie: read.cookie, spaceId, activeUserId: user }
    try {
      const probe = await call("getAvailableModels", { spaceId }, answer, signal)
      // The answer that names the workspace is the catalog itself, so it is
      // kept rather than asked for again by the request that follows.
      const payload = await probe.json().catch(async () => {
        await probe.body?.cancel().catch(() => {})
        return undefined
      })
      if (!payload || !Array.isArray(payload.models)) {
        await probe.body?.cancel().catch(() => {})
        continue
      }
      const models = keepModels(digest([answer.cookie, spaceId, user]), payload)
      readable ??= answer
      if (!models.length) continue
      while (resolved.size >= 256) resolved.delete(resolved.keys().next().value)
      resolved.set(key, { spaceId, activeUserId: user, at: Date.now() })
      return { spaceId, activeUserId: user, at: Date.now() }
    } catch (error) {
      last = error
    }
  }
  if (readable) {
    while (resolved.size >= 256) resolved.delete(resolved.keys().next().value)
    resolved.set(key, { ...readable, at: Date.now() })
    return { ...readable, at: Date.now() }
  }
  throw last instanceof ProviderError ? last : new ProviderError(502, "workspace_unreadable", "Notion did not answer for any of this session's workspaces.")
}

// accountOf is the account a request runs as, with the workspace resolved from
// the session when the sign-in did not state one.
async function accountOf(auth, signal) {
  const read = credentials(auth)
  if (read.spaceId) return read
  const found = await workspace(read, signal)
  return { cookie: read.cookie, spaceId: found.spaceId, activeUserId: read.activeUserId ?? found.activeUserId }
}

function recordValue(record) {
  let value = record
  for (let depth = 0; depth < 4 && value?.value && typeof value.value === "object"; depth++) value = value.value
  return value
}

function loginRecords(body, activeUserId) {
  const accounts = []
  for (const [owner, entry] of Object.entries(body ?? {})) {
    if (!UUID.test(owner) || (activeUserId && owner !== activeUserId)) continue
    const user = recordValue(entry?.notion_user?.[owner])
    if (!user || (user.id && user.id !== owner) || typeof user.email !== "string" || CONTROL.test(user.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) continue
    const workspaces = Object.entries(entry.space ?? {}).flatMap(([spaceId, record]) => {
      if (!UUID.test(spaceId)) return []
      const value = recordValue(record)
      if (!value || (value.id && value.id !== spaceId)) return []
      const name = typeof value.name === "string" && value.name.trim() && !CONTROL.test(value.name) ? value.name.trim().slice(0, 200) : `Notion 工作区 ${spaceId.slice(0, 8)}`
      return [{ spaceId, name }]
    })
    if (workspaces.length) accounts.push({ email: user.email, activeUserId: owner, workspaces })
  }
  if (accounts.length !== 1) throw new ProviderError(409, "login_account_ambiguous", "无法唯一确认 Notion 登录账号，请在独立登录窗口只登录一个账号后重试。")
  return accounts[0]
}

async function loginInfo({ auth, signal = AbortSignal.timeout(30_000) }) {
  const read = credentials(auth)
  const valid = await call("authValidate", {}, read, signal)
  await valid.body?.cancel().catch(() => {})
  const body = await json("getSpaces", {}, read, signal)
  return loginRecords(body, read.activeUserId)
}

async function json(name, data, account, signal) {
  const response = await call(name, data, account, signal)
  try { return await response.json() } catch { throw new ProviderError(502, "invalid_upstream_json", "Notion AI returned invalid JSON.") }
}

function eligible(entry) {
  return typeof entry?.model === "string" && entry.model.trim().length > 0 && typeof entry?.modelMessage === "string" && entry.agentService && !entry.agentService.isDisabled && !entry.isDisabled && !entry.restrictedForPersonalAgent
}

async function catalog(account, signal, refresh = false) {
  const key = digest([account.cookie, account.spaceId, account.activeUserId])
  const cached = catalogs.get(key)
  if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.models
  const response = await json("getAvailableModels", { spaceId: account.spaceId }, account, signal)
  return keepModels(key, response)
}

// keepModels reads the catalog the way the web client shows it — minus what the
// plan and the workspace don't serve — and keeps it for the next minute.
function keepModels(key, response) {
  if (!Array.isArray(response.models)) throw new ProviderError(502, "invalid_model_catalog", "Notion AI returned an unsupported model catalog.")
  const available = response.modelSelectionRestricted || response.restrictedGeoHiddenModelModes?.includes("agent_service") ? [] : response.models.filter(eligible)
  // Auto is the web client's unpinned personal-agent mode, not an upstream
  // model ID. Only offer it alongside a readable, eligible personal catalog.
  const models = available.length ? [{ model: "auto", modelMessage: "Notion Auto", agentService: {} }, ...available.filter((entry) => entry.model !== "auto")] : []
  while (catalogs.size >= 256) catalogs.delete(catalogs.keys().next().value)
  catalogs.set(key, { models, at: Date.now() })
  return models
}

function modelEntry(entry) {
  const efforts = entry.modelConfiguration?.supportedReasoningEfforts ?? []
  return {
    id: entry.model, providerID: "notion", name: entry.modelMessage,
    api: { id: entry.model, url: "https://notion.invalid/v1", npm: "@ai-sdk/openai-compatible" },
    status: "active", options: {}, headers: {},
    // Zero denotes an unknown limit here, not an asserted vendor allowance.
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: false, reasoning: efforts.length > 0, attachment: false, toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false }, interleaved: false,
    },
    variants: Object.fromEntries(efforts.filter((effort) => typeof effort === "string").map((effort) => [effort, { reasoningEffort: effort }])),
  }
}

function initialText(messages) {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content
  return "Conversation supplied by the client. Follow the system/developer instructions and answer the last user message.\n\n" + messages.map((message) => `[${message.role}]\n${message.content}`).join("\n\n")
}

function content(value) {
  return [{ type: "text", text: [[value]] }]
}

async function take(key) {
  for (const [entry, value] of sessions) {
    if (Date.now() - value.at > TTL) {
      await submissionStore.removeSession(entry)
    }
  }
  const value = sessions.get(key)
  if (!value || claims.has(key)) return undefined
  claims.add(key)
  return value
}

const claims = new Set()
const activeRequests = new Set()

async function release(key) {
  claims.delete(key)
}

async function forget(key) {
  await submissionStore.removeSession(key)
  claims.delete(key)
}

// Cache the history the client actually received, including generated tool IDs,
// rather than the model's JSON envelope. Formatting differences in equivalent
// client messages must not force another paid thread.
function acceptedShape(message) {
  const value = structuredClone(message)
  for (const call of value.tool_calls ?? []) delete call.id
  return digest(stable(value))
}

function acceptedReply(record, message) {
  if (record.message) return structuredClone(record.message)
  if (record.acceptedShape !== acceptedShape(message)) throw continuationError("generation_unconfirmed", "The accepted response differs from this recovered result.")
  const canonical = structuredClone(message)
  canonical.tool_calls?.forEach((call, index) => { call.id = record.acceptedToolIds[index] })
  return canonical
}

function stable(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
}

function clientText(value) {
  if (Array.isArray(value)) return value.map((part) => part.text ?? "").join("")
  return value == null ? "" : typeof value === "string" ? value : stable(value)
}

function clientHistory(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: clientText(message.content),
    ...(message.role === "tool" ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map((call) => {
      let args = call.function?.arguments
      try { args = typeof args === "string" ? JSON.parse(args) : args } catch { /* Already validated by the client adapter. */ }
      return { id: call.id, name: call.function?.name, arguments: args }
    }) } : {}),
  }))
}

function continuationError(code, message) {
  return new ProviderError(409, code, message, { retryable: false })
}

function submittedError(error) {
  if (error instanceof ProviderError) {
    error.retryable = false
    error.submitted = true
    return error
  }
  return new ProviderError(409, "generation_unconfirmed", "Notion AI may already have generated this turn. Automatic resubmission was stopped.", { retryable: false, submitted: true })
}

function requestRecord(key) {
  return submissions.get(key)
}

async function reserveRequest(key, initial = {}) {
  const previous = requestRecord(key)
  if (previous) throw continuationError("generation_already_submitted", "This Notion AI turn was already submitted. Automatic resubmission was stopped.")
  const record = { ...initial, state: "pending", at: Date.now() }
  const result = await submissionStore.reserve(key, record)
  return result.record
}

function incrementalText(history, start, policy, planner = false) {
  const bindings = new Map(history.slice(0, start).flatMap((message) => (message.tool_calls ?? []).map((call, index) => [call.id, { name: call.function?.name, call_index: index }])))
  const added = history.slice(start)
  if (!added.length || added.some((message) => !["user", "tool"].includes(message.role))) {
    throw continuationError("client_history_changed", "The client history no longer continues the saved Notion AI thread. Start a new conversation explicitly.")
  }
  const parts = []
  const results = []
  for (const message of added) {
    if (message.role === "tool") results.push({ tool_call_id: message.tool_call_id, ...bindings.get(message.tool_call_id), content: clientText(message.content) })
    else {
      if (results.length) { parts.push({ tool_results: results.splice(0) }) }
      parts.push(clientText(message.content))
    }
  }
  if (results.length) parts.push({ tool_results: results })
  if (planner) return formatToolPlanner({ delta: parts, policy })
  return [...(policy === undefined ? [] : ["Client tool policy for this turn: " + stable(policy)]), ...parts.map((part) => typeof part === "string" ? part : stable(part))].join("\n\n")
}

// ---- quota -----------------------------------------------------------------
// getCreditRateLimitStatus is the allowance card the web client shows: a
// rolling window and the billing period's, as percentages. Resets are only
// what the vendor states; a missing stop is unknown, never guessed. A bucket
// the vendor leaves unexposed (state not_exposed) is unknown too, not zero.
// getAIUsageEligibilityV2 adds the premium credit balance beside them.

const UNITS = { s: ["second", 1], m: ["minute", 60], h: ["hour", 3600], d: ["day", 86400] }
const CREDIT_BUCKET_NAMES = new Map([["auto", "标准"], ["flex", "精选"]])

function percent(used, limit) {
  const u = typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : undefined
  const l = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined
  return u === undefined || l === undefined ? undefined : (100 * u) / l
}

function rollingWindow(entry, fallbackReset) {
  const used = percent(entry?.used, entry?.limit)
  if (used === undefined) return undefined
  const label = typeof entry?.window === "string" ? entry.window.trim() : ""
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(label)
  const [unit, size] = match ? UNITS[match[2].toLowerCase()] : []
  const count = match ? Number(match[1]) : undefined
  const reset = [entry?.resetsInSeconds, fallbackReset].find((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
  return {
    name: match ? `${match[1]} ${unit}${count === 1 ? "" : "s"}` : label || "Rolling window",
    used,
    ...(count ? { span: count * size } : {}),
    ...(reset !== undefined ? { resetSecs: reset } : {}),
  }
}

function billingWindow(entry) {
  const credits = entry?.credits
  const creditPercent = percent(credits?.used, credits?.limit)
  const used = percent(entry?.used, entry?.limit) ?? creditPercent
  if (used === undefined) return undefined
  const bucketName = CREDIT_BUCKET_NAMES.get(entry?.bucketId)
  const name = bucketName ? bucketName + (creditPercent !== undefined ? ` · ${credits.used}/${credits.limit}` : "") : "Month"
  const end = typeof entry?.periodEndMs === "number" && Number.isFinite(entry.periodEndMs) && entry.periodEndMs > 0 && entry.periodEndMs <= 8.64e15 ? entry.periodEndMs : undefined
  return { name, used,
    ...(creditPercent !== undefined ? { amount: credits.used, limit: credits.limit, unit: "credits" } : {}),
    ...(end !== undefined ? { resetsAt: new Date(end).toISOString() } : {}) }
}

function quotaWindows(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
  const resolved = Array.isArray(data.allowances) ? data.allowances.filter((entry) => entry?.state === "resolved") : []
  const billing = resolved.filter((entry) => entry.cadence === "billing_period").map(billingWindow).filter(Boolean)
  // A bucket is only skipped when the vendor left it unreadable: a window that
  // does not read falls back to the allowance below it, and one that does reads
  // even when the other does not.
  const windows = [
    (data.window ? rollingWindow(data.window, data.resetsInSeconds) : undefined) ?? rollingWindow(resolved.find((entry) => entry.cadence === "rolling"), data.resetsInSeconds),
    ...(billing.length ? billing : [billingWindow(data.billingPeriodWindow)]),
  ].filter(Boolean)
  if (windows.length) return windows
  if (data.status === "not_applicable" && resolved.length === 0) return []
  // Buckets the vendor itself marked unexposed are an understood answer - it
  // names what it will not show. Anything else that reads no window is an
  // unreadable response, which is an error to show, never an empty account.
  const withheld = Array.isArray(data.allowances) && data.allowances.length > 0 && data.allowances.every((entry) => entry?.state === "not_exposed")
  return withheld ? [] : undefined
}

const quotaError = (error) =>
  error instanceof ProviderError ? error.message : "The Notion AI quota could not be read."

function transcriptPage(body) {
  if (body?.type !== "agent_service_transcript_page" || !Array.isArray(body.patches)) throw new ProviderError(502, "invalid_transcript", "Notion AI returned an unsupported transcript page.")
  return body
}

function crossedBoundary(page, afterSequence) {
  return afterSequence > 0 && page.patches.some((patch) => {
    const sequence = patch.op === "put" ? patch.entity?.sequence : undefined
    return Number.isSafeInteger(sequence) && sequence <= afterSequence
  })
}

async function transcriptPages(account, threadId, afterSequence, signal) {
  const latest = transcriptPage(await json("getThreadTranscript", { spaceId: account.spaceId, threadId, direction: "backward", limit: 10 }, account, signal))
  if (crossedBoundary(latest, afterSequence)) return [latest]
  const pages = [latest]
  const seen = new Set()
  let page = latest
  for (let count = 0; count < MAX_BACKWARD_PAGES; count++) {
    const cursor = page.backward_cursor
    if (typeof cursor !== "string" || !cursor || page.has_more_backward === false || seen.has(cursor)) break
    seen.add(cursor)
    page = transcriptPage(await json("getThreadTranscript", { spaceId: account.spaceId, threadId, direction: "backward", cursor, limit: 10 }, account, signal))
    pages.unshift(page)
    if (crossedBoundary(page, afterSequence)) break
  }
  return pages
}

async function quota({ auth }) {
  const signal = AbortSignal.timeout(30_000)
  let account
  try {
    account = await accountOf(auth, signal)
  } catch (error) {
    return { error: quotaError(error), windows: [], signIn: error?.status === 401 ? "expired" : "kept" }
  }
  let payload
  try {
    payload = await json("getCreditRateLimitStatus", { spaceId: account.spaceId }, account, signal)
  } catch (error) {
    return { error: quotaError(error), windows: [], signIn: error?.status === 401 ? "expired" : "kept" }
  }
  const windows = quotaWindows(payload)
  if (windows === undefined) return { error: "Notion AI returned an unsupported quota response.", windows: [], signIn: "kept" }
  let balance, eligibility
  try {
    eligibility = await json("getAIUsageEligibilityV2", { spaceId: account.spaceId }, account, signal)
    const total = eligibility?.premiumCredits?.totalCreditBalance
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) balance = `Notion 积分：${total}`
  } catch {
    // The premium credit line is optional; its failure must not hide the windows.
  }
  const accounting = creditSnapshot(payload, eligibility, digest([account.spaceId, account.activeUserId]))
  const recording = recordUsage(accounting)
  return { windows, ...(balance !== undefined ? { balance } : {}), accounting, recording }
}

export default {
  loginInfo,
  async models({ auth }) {
    const signal = AbortSignal.timeout(30_000)
    const account = await accountOf(auth, signal)
    const valid = await call("authValidate", {}, account, signal)
    await valid.body?.cancel().catch(() => {})
    const entries = await catalog(account, signal, true)
    return Object.fromEntries(entries.map((entry) => [entry.model, modelEntry(entry)]))
  },
  async open({ auth, chat, signal }) {
    await submissionStore.load()
    const account = await accountOf(auth, signal)
    const models = await catalog(account, signal)
    const model = models.find((entry) => entry.model === chat.model)
    if (!model) throw new ProviderError(403, "model_unavailable", "This Notion workspace does not offer the requested model for personal agents. Refresh the model list after signing in.")
    const auto = chat.model === "auto"
    const effort = auto ? undefined : chat.reasoning_effort ?? model.modelConfiguration?.defaultReasoningEffort
    if (effort !== undefined && !model.modelConfiguration?.supportedReasoningEfforts?.includes(effort)) {
      throw new ProviderError(400, "reasoning_effort_unavailable", "The requested reasoning effort is not offered for this Notion model.")
    }
    const last = chat.messages.at(-1)
    if (last.role !== "user") throw new ProviderError(400, "user_message_required", "The conversation must end with a user message.")
    const history = chat.clientMessages ?? chat.messages
    const accountId = digest([account.cookie, account.spaceId, account.activeUserId, chat.model, effort, chat.bridgeContextKey])
    const historyKey = (messages) => digest([accountId, stable(clientHistory(messages))])
    const requestKey = digest([historyKey(history), stable(chat.bridgePolicy)])
    const usageAttempt = randomUUID()
    const accountKey = digest([account.spaceId, account.activeUserId])
    const receipt = (event, extra = {}) => recordUsage({
      version: 1, kind: "request_usage", event, account: accountKey,
      submission: requestKey, attempt: usageAttempt, tokenUsage: unknownTokens(), ...extra,
    })
    if (activeRequests.has(requestKey)) throw continuationError(history.some(message => message.role === "assistant") ? "thread_busy" : "generation_already_submitted", "This request already has a turn in flight.")
    activeRequests.add(requestKey)
    const releaseRequest = () => activeRequests.delete(requestKey)
    signal?.addEventListener("abort", releaseRequest, { once: true })
    const finishRequest = () => { releaseRequest(); signal?.removeEventListener("abort", releaseRequest) }
    try {
      const replay = requestRecord(requestKey)
      receipt("opened", { disposition: replay?.state === "completed" ? "replay" : replay?.threadId ? "recovery" : "new" })
      if (replay) {
        if (replay.state === "completed" && replay.completed && replay.message) {
          receipt("replay_completed")
          const events = (async function* () {
            if (replay.completed.text) yield { type: "text", text: replay.completed.text }
            yield structuredClone(replay.completed)
          })()
          events.accept = () => structuredClone(replay.message)
          events.reject = () => {}
          finishRequest()
          return events
        }
        if (replay.state === "completed" || replay.recoverable === false || !replay.threadId) {
          throw new ProviderError(409, "generation_already_submitted", "This Notion AI turn was already submitted. Automatic resubmission was stopped.", { retryable: false, submitted: true })
        }
      }
      const recovering = Boolean(replay?.threadId)
      let previousKey
      let previous
      let prefixLength = 0
      if (!recovering) {
        for (let length = history.length - 1; length > 0; length--) {
          if (history[length - 1]?.role !== "assistant") continue
          const key = historyKey(history.slice(0, length))
          if (sessions.has(key) && claims.has(key)) throw continuationError("thread_busy", "The saved Notion AI thread already has a turn in flight. Automatic branching was stopped.")
          const value = await take(key)
          if (value) { previousKey = key; previous = value; prefixLength = length; break }
        }
        if (!previous && chat.toolBridge && history.some((message) => ["assistant", "tool"].includes(message.role))) {
          throw continuationError("thread_history_missing", "The Notion AI tool thread is no longer available. Start a new conversation explicitly; the full history was not resent.")
        }
      }
      let claimedKey = previous ? previousKey : undefined
      let afterSequence = 0
      let record
      let threadId
      let liveResponse
      let creating = false
      try {
        if (recovering) {
          threadId = replay.threadId
          afterSequence = replay.afterSequence ?? 0
          record = structuredClone(replay)
          record.state = "pending"
          record.completed = undefined
          record = await submissionStore.updateSubmission(requestKey, record)
        } else if (previous) {
          try {
            const before = await json("getThreadTranscript", { spaceId: account.spaceId, threadId: previous.threadId, direction: "backward", limit: 10 }, account, signal)
            if (before.session?.sequence !== previous.sequence) {
              await forget(previousKey)
              claimedKey = undefined
              throw continuationError("thread_history_changed", "The saved Notion AI thread changed outside this client. Automatic recreation was stopped.")
            } else if (before.session?.status !== "idle") {
              throw continuationError("thread_busy", "The saved Notion AI thread is not idle. Automatic recreation was stopped.")
            } else {
              const delta = incrementalText(history, prefixLength, chat.bridgePolicy, auto && chat.toolBridge)
              afterSequence = previous.sequence
              record = await reserveRequest(requestKey)
              record = await submissionStore.updateSubmission(requestKey, { threadId: previous.threadId, afterSequence })
              // Once a write may have reached Notion, this prefix cannot be used to
              // submit it again, even if its HTTP response is lost.
              await forget(previousKey)
              claimedKey = undefined
              receipt("submission_attempt", { endpoint: "sendEventToAgentThread" })
              await json("sendEventToAgentThread", { spaceId: account.spaceId, threadId: previous.threadId, event: { type: "user.message", content: content(delta) }, surface: "full_page_chat", clientEventId: randomUUID() }, account, signal)
              receipt("submission_accepted", { endpoint: "sendEventToAgentThread" })
            }
          } catch (error) {
            if (claimedKey) await release(claimedKey)
            throw error
          }
        }
        if (previous) {
          threadId = previous.threadId
        } else {
          if (!recovering) {
            threadId = randomUUID()
            record = await reserveRequest(requestKey, { threadId })
            receipt("submission_attempt", { endpoint: "createAgentThread" })
            creating = true
            const created = await json("createAgentThread", {
              type: "personal_agent", spaceId: account.spaceId, threadId,
              ...(!auto ? { model: chat.model } : {}), ...(effort !== undefined ? { reasoningEffort: effort } : {}),
              createdSource: "full_page_chat", content: content(initialText(chat.messages)),
              policies: { approval_mode: "ask", disable_internet_access: true, disable_computer_file_downloads: true },
              agentMemorySettings: { useMemories: false, excludeChatFromMemories: true },
              browserEnabled: false, clientMessageId: randomUUID(),
            }, account, signal)
            receipt("submission_accepted", { endpoint: "createAgentThread" })
            creating = false
            if (typeof created.threadId !== "string" || !UUID.test(created.threadId)) throw new ProviderError(502, "unexpected_thread", "Notion AI returned an invalid thread id.")
            threadId = created.threadId
          }
        }
        if (record) record = await submissionStore.updateSubmission(requestKey, { threadId, ...(afterSequence ? { afterSequence } : {}) })
        const pages = await transcriptPages(account, threadId, afterSequence, signal)
        const newest = pages.at(-1)
        const page = pages.length === 1 ? newest : { ...newest, patches: pages.flatMap((entry) => entry.patches) }
        if (afterSequence === 0 || page.session?.sequence > afterSequence || page.session?.last_turn_allowance?.sequence > afterSequence) sessionError(page.session)
        const completedOnPage = page.patches.some((patch) => patch.op === "put" && patch.entity?.kind === "turn_completed" && patch.entity.sequence > afterSequence)
        if (!completedOnPage) {
          if (typeof page.forward_cursor !== "string") throw new ProviderError(502, "missing_cursor", "Notion AI did not return a transcript cursor.")
          // Establish the HTTP stream before returning client headers, so an
          // expired session at this endpoint can still be reported as HTTP 401.
          liveResponse = await call("listenToThreadTranscript", { spaceId: account.spaceId, threadId, cursor: page.forward_cursor, includeProvisionalUserMessages: true, includeQueueChanges: false }, account, signal)
        }
        async function* frames() {
          yield page
          if (liveResponse) yield* readNDJSON(liveResponse.body, signal)
        }
        const events = (async function* () {
          let answer = ""
          try {
            for await (const event of transcriptEvents(frames(), signal, { afterSequence, buffered: chat.bufferedResponse })) {
              if (event.type === "text") answer += event.text
              else if (event.type === "done") {
                receipt("transcript_completed", { sequence: event.sequence })
                record.completed = { ...event, text: event.text ?? answer }
                // Direct protocol users keep the plain-text contract. The client
                // adapter commits only after validating its final tool envelope.
                if (!chat.clientMessages && !chat.toolBridge) await events.accept({ role: "assistant", content: record.completed.text })
              }
              yield event
            }
          } catch (error) {
            try { await events.reject(error, true) } catch {}
            throw submittedError(error)
          } finally {
            await liveResponse?.body?.cancel().catch(() => {})
            if (!record.completed && record.state === "pending") {
              try { await events.reject(signal?.reason, true) } catch {}
            }
            if (!record.completed) finishRequest()
          }
        })()
        events.accept = async (message) => {
          try {
            if (record.state === "completed") return acceptedReply(record, message)
            if (record.state !== "pending" || !record.completed) throw continuationError("generation_unconfirmed", "The Notion AI turn has not been verified and cannot be continued.")
            const sequence = record.completed.sequence
            const accepted = { ...record, state: "completed", at: Date.now(), acceptedToolIds: message.tool_calls?.map(call => call.id) ?? [], acceptedShape: acceptedShape(message) }
            const bytes = Buffer.byteLength(stable([record.completed, message]))
            const retainedBytes = [...submissions.values()].reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
            if (bytes <= MAX_REPLAY_BYTES && retainedBytes + bytes <= MAX_TOTAL_REPLAY_BYTES) {
              accepted.message = structuredClone(message)
              accepted.bytes = bytes
            } else accepted.completed = undefined
            record = await submissionStore.complete(requestKey, accepted, historyKey([...history, message]), { threadId, sequence, at: Date.now() })
            return acceptedReply(record, message)
          } finally { finishRequest() }
        }
        events.reject = async (error, recoverable = false) => {
          try {
            receipt("delivery_failed", { recoverable, status: error?.status ?? null })
            if (record.state !== "pending") return
            record = await submissionStore.updateSubmission(requestKey, { ...record, state: "failed", completed: undefined, recoverable })
          } finally { finishRequest() }
        }
        return events
      } catch (error) {
        if (claimedKey) await release(claimedKey)
        await liveResponse?.body?.cancel().catch(() => {})
        if (record) {
          record.state = "failed"
          record.at = Date.now()
          const failure = submittedError(error)
          record.recoverable = Boolean(record.threadId) && !(creating && error instanceof ProviderError && error.status >= 400 && error.status < 500)
          try { record = await submissionStore.updateSubmission(requestKey, record) } catch {}
          throw failure
        }
        throw error
      }
    } catch (error) { receipt("request_failed", { status: error?.status ?? null }); finishRequest(); throw error }
  },
  usage: quota,
}

export const _internal = { cookie, credentials, accountOf, workspace, resolved, RESOLVED_TTL, keepModels, initialText, content, sessions, submissions, catalogs, eligible, modelEntry, percent, rollingWindow, billingWindow, quotaWindows, useFetch, store: submissionStore, activeRequests }
