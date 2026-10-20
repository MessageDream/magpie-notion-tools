const COOKIE_URLS = ["https://app.notion.com", "https://www.notion.so", "https://notion.so"]
const COOKIE_DOMAINS = new Set(["notion.com", "app.notion.com", "notion.so", "www.notion.so"])
const NONCE = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BYTES = 16 * 1024
const active = new Map()
class ConnectionError extends Error {}

export function validateSender(message, sender, extensionId) {
  if (!message || !["session", "select", "cancel"].includes(message.op) || typeof message.nonce !== "string" || !NONCE.test(message.nonce)
    || sender?.id !== extensionId || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0) {
    throw new ConnectionError("连接来源无效，请从 Magpie 重新发起登录。")
  }
  let url
  try { url = new URL(sender.url) } catch { throw new ConnectionError("连接页面无效，请从 Magpie 重新发起登录。") }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/connect"
    || url.username || url.password || url.search || url.hash !== "#" + message.nonce
    || (sender.origin !== undefined && sender.origin !== url.origin)) {
    throw new ConnectionError("连接页面无效，请从 Magpie 重新发起登录。")
  }
  if (message.op === "select" && (typeof message.spaceId !== "string" || !UUID.test(message.spaceId))) throw new ConnectionError("请选择有效的 Notion 工作区。")
  return { origin: url.origin, nonce: message.nonce, op: message.op, spaceId: message.spaceId }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

async function responseJson(response, signal) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) throw new ConnectionError("本机服务返回了无效响应，请重新发起登录。")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0, text = ""
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new ConnectionError("本机服务响应过大，连接已停止。")
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    let data
    try { data = JSON.parse(text) } catch { throw new ConnectionError("本机服务返回了无效响应，请重新发起登录。") }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ConnectionError("本机服务返回了无效响应，请重新发起登录。")
    return data
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function post(origin, endpoint, body, signal) {
  const payload = JSON.stringify(body)
  if (new TextEncoder().encode(payload).byteLength > MAX_BYTES) throw new ConnectionError("会话数据格式无效，未发送登录。")
  const response = await fetch(origin + endpoint, {
    method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", signal,
    headers: { "Content-Type": "application/json" }, body: payload,
  })
  if (!response.ok) {
    const detail = await responseJson(response, signal).catch(() => null)
    if (response.status === 409 && detail?.code === "login_account_ambiguous") {
      throw new ConnectionError("当前 Notion 会话包含多个账号，无法唯一确认要连接的账号；未保存到 Magpie，请先取消连接。")
    }
    throw new ConnectionError(response.status === 401 || response.status === 403 || response.status === 410
      ? "本机登录会话已失效，请从 Magpie 重新发起登录。"
      : "本机连接未完成，请返回 Magpie 查看状态后重试。")
  }
  return responseJson(response, signal)
}

async function sessionCookie(api, signal) {
  let found = false
  for (const url of COOKIE_URLS) {
    signal.throwIfAborted()
    const cookie = await abortable(api.cookies.get({ url, name: "token_v2" }), signal)
    if (!cookie) continue
    found = true
    // Chrome represents domain cookies with a leading dot, including .app.notion.com.
    if (typeof cookie.domain !== "string" || !COOKIE_DOMAINS.has(cookie.domain.replace(/^\./, "")) || (cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now() / 1000)) continue
    if (typeof cookie.value !== "string" || !cookie.value || cookie.value.length > 12000 || /[\x00-\x20;\x7f]/.test(cookie.value)) continue
    return cookie.value
  }
  throw new ConnectionError(found
    ? "已找到 Notion 会话，但其域名、有效期或格式未通过检查；尚未保存账号。"
    : "当前浏览器配置中没有读取到 Notion 会话。请确认扩展与已登录的 Notion 网页位于同一个浏览器配置。")
}

export function publicIdentity(data) {
  if (typeof data.email !== "string" || data.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
    || !Array.isArray(data.workspaces) || !data.workspaces.length || data.workspaces.length > 100
    || data.workspaces.some(space => typeof space?.spaceId !== "string" || !UUID.test(space.spaceId) || typeof space.name !== "string")
    || new Set(data.workspaces.map(space => space.spaceId)).size !== data.workspaces.length) {
    throw new ConnectionError("无法确认 Notion 账号及工作区，未保存登录。")
  }
  return {
    ok: true, email: data.email,
    workspaces: data.workspaces.map(space => ({ spaceId: space.spaceId, name: space.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200) })),
  }
}

export async function handleMessage(message, sender, api = chrome) {
  let request
  try { request = validateSender(message, sender, api.runtime.id) } catch (error) { return { error: error instanceof ConnectionError ? error.message : "连接来源无效。" } }
  const id = request.origin + "#" + request.nonce
  const previous = active.get(id)
  if (previous && request.op !== "cancel") return { error: "连接正在进行，请稍候。" }
  if (previous) previous.abort(new ConnectionError("登录已取消。"))
  const controller = new AbortController()
  active.set(id, controller)
  const signal = controller.signal
  const timer = setTimeout(() => controller.abort(new ConnectionError("本机连接超时，请从 Magpie 重新发起登录。")), 30_000)
  try {
    const probe = await post(request.origin, "/probe", { nonce: request.nonce }, signal)
    if (probe.ok !== true) throw new ConnectionError("本机登录会话无效，请从 Magpie 重新发起登录。")
    if (request.op === "session") {
      const key = await sessionCookie(api, signal)
      const identity = await post(request.origin, "/session", { nonce: request.nonce, key }, signal)
      return publicIdentity(identity)
    }
    const endpoint = request.op === "select" ? "/select" : "/cancel"
    const result = await post(request.origin, endpoint, { nonce: request.nonce, ...(request.op === "select" ? { spaceId: request.spaceId } : {}) }, signal)
    if (result.ok !== true) throw new ConnectionError("本机连接未完成，请返回 Magpie 查看状态。")
    return { ok: true }
  } catch (error) {
    const reason = signal.aborted ? signal.reason : error
    return { error: reason instanceof ConnectionError ? reason.message : "无法连接本机 Magpie，请返回 Magpie 重新发起登录。" }
  } finally {
    clearTimeout(timer)
    if (active.get(id) === controller) active.delete(id)
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then(sendResponse, () => sendResponse({ error: "连接未完成，请重新发起登录。" }))
  return true
})
