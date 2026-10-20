import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY = 16 * 1024
const POST_PATHS = new Set(["/probe", "/session", "/select", "/cancel"])
const LOGO = readFileSync(new URL("./assets/logo.svg", import.meta.url), "utf8")
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notion 连接 · Magpie</title><style>body{font:16px system-ui,sans-serif;background:#f7f7f5;color:#222;margin:0;padding:64px 20px}main{max-width:520px;margin:auto;background:#fff;padding:32px;border:1px solid #ddd;border-radius:16px}.logo{width:48px;height:48px}.logo svg{width:100%;height:100%;display:block}h1{font-size:24px}p{line-height:1.6;color:#555}button,select{font:inherit;box-sizing:border-box;width:100%;padding:12px;margin-top:12px;border-radius:8px}button{background:#222;color:white;border:0;cursor:pointer}button:disabled{opacity:.4;cursor:default}#cancel{background:#eee;color:#333}select{background:white;border:1px solid #bbb}</style></head><body><main><div class="logo" aria-hidden="true">${LOGO}</div><h1>连接 Notion 到 Magpie</h1><p id="status" role="status" aria-live="polite">未检测到连接扩展，请先安装或启用扩展并刷新页面。</p><p>第一步：点击连接，授权扩展读取当前 Notion 登录会话并交给本机 Magpie 验证。</p><button id="connect" type="button" disabled>连接当前 Notion 账号</button><p>第二步：核对显示的邮箱，选择工作区后点击确认。确认前不会替换 Magpie 中保存的账号。</p><label for="workspaces">使用此工作区的模型与额度</label><select id="workspaces" disabled><option value="">连接后选择工作区</option></select><button id="confirm" type="button" disabled>确认连接</button><button id="cancel" type="button">取消</button><p>相同邮箱重新连接会更新 Magpie 中已有账号的工作区。此页面 1 分钟后失效。</p></main></body></html>`

class RequestError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code }
}

function identityOf(info) {
  if (!info || typeof info.email !== "string" || info.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(info.email)
    || !UUID.test(info.activeUserId) || !Array.isArray(info.workspaces) || !info.workspaces.length
    || info.workspaces.some((space) => !UUID.test(space?.spaceId) || typeof space.name !== "string")
    || new Set(info.workspaces.map((space) => space.spaceId)).size !== info.workspaces.length) {
    throw new RequestError(502, "无法确认 Notion 账号和工作区，请重新连接。")
  }
  return { email: info.email, activeUserId: info.activeUserId, workspaces: info.workspaces.map(({ spaceId, name }) => ({ spaceId, name: name.slice(0, 200) })) }
}

function equalNonce(value, nonce) {
  if (typeof value !== "string") return false
  const input = Buffer.from(value)
  return input.length === nonce.length && timingSafeEqual(input, nonce)
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Login ended."))
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

function readJson(request) {
  const type = request.headers["content-type"]
  if (typeof type !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new RequestError(415, "请求必须使用 JSON。")
  if (Number(request.headers["content-length"]) > MAX_BODY) throw new RequestError(413, "请求内容过大。")
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    const cleanup = () => {
      clearTimeout(timer)
      request.off("data", data); request.off("end", end); request.off("error", failed); request.off("aborted", aborted)
    }
    const failed = () => { cleanup(); reject(new RequestError(400, "请求未完成。")) }
    const aborted = () => failed()
    const data = (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { cleanup(); chunks.length = 0; request.resume(); reject(new RequestError(413, "请求内容过大。")) }
      else chunks.push(chunk)
    }
    const end = () => {
      cleanup()
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
        resolve(value)
      } catch { reject(new RequestError(400, "JSON 请求无效。")) }
      finally { chunks.length = 0 }
    }
    const timer = setTimeout(() => { cleanup(); request.resume(); reject(new RequestError(408, "请求已超时。")) }, 10_000)
    timer.unref?.()
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted)
  })
}

export function createExtensionLogin({ loginInfo, extensionId, timeoutMs = 60_000 }, runtime = {}) {
  if (typeof loginInfo !== "function") throw new TypeError("Notion extension login requires loginInfo.")
  if (typeof extensionId !== "string" || !/^[a-p]{32}$/.test(extensionId)) throw new TypeError("A fixed Chrome extension ID is required.")
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Notion login timeout must be between 1 and 60000 milliseconds.")
  const verificationTimeoutMs = runtime.verificationTimeoutMs ?? 25_000
  if (!Number.isSafeInteger(verificationTimeoutMs) || verificationTimeoutMs < 1 || verificationTimeoutMs > 25_000) throw new TypeError("Notion verification timeout must be between 1 and 25000 milliseconds.")
  const extensionOrigin = `chrome-extension://${extensionId}`
  return {
    type: "oauth", label: "浏览器登录",
    async authorize() {
      const nonce = Buffer.from(randomBytes(32).toString("hex"))
      const controller = new AbortController()
      let host, timer, state = "waiting", key, identity, settled = false, resolveResult
      const result = new Promise((resolve) => { resolveResult = resolve })
      const server = (runtime.createServer ?? createServer)((request, response) => { void handle(request, response) })
      const finish = (value) => {
        if (settled) return
        settled = true
        state = "done"
        key = undefined
        identity = undefined
        nonce.fill(0)
        clearTimeout(timer)
        controller.abort()
        server.close()
        server.closeIdleConnections?.()
        const forceClose = setTimeout(() => server.closeAllConnections?.(), 100)
        forceClose.unref?.()
        resolveResult(value)
      }
      function send(response, status, body, done) {
        if (response.destroyed || response.writableEnded) return
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
        response.end(JSON.stringify(body), done)
      }
      async function handle(request, response) {
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Referrer-Policy", "no-referrer")
        response.setHeader("X-Content-Type-Options", "nosniff")
        response.setHeader("X-Frame-Options", "DENY")
        response.setHeader("Connection", "close")
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        try {
          if (request.headers.host !== host) throw new RequestError(403, "连接地址无效。")
          if (request.method === "GET" && request.url === "/connect") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            response.end(PAGE)
            return
          }
          if (request.headers.origin !== extensionOrigin) throw new RequestError(403, "连接来源未获授权。")
          response.setHeader("Access-Control-Allow-Origin", extensionOrigin)
          response.setHeader("Vary", "Origin")
          if (!POST_PATHS.has(request.url)) throw new RequestError(404, "连接接口不存在。")
          if (request.method === "OPTIONS") {
            const headers = request.headers["access-control-request-headers"]?.toLowerCase().split(",").map((value) => value.trim()) ?? []
            if (request.headers["access-control-request-method"] !== "POST" || headers.some((value) => value !== "content-type")) throw new RequestError(403, "请求方式未获授权。")
            response.setHeader("Access-Control-Allow-Methods", "POST")
            response.setHeader("Access-Control-Allow-Headers", "Content-Type")
            response.writeHead(204); response.end()
            return
          }
          if (request.method !== "POST") throw new RequestError(405, "请求方式无效。")
          const body = await readJson(request)
          if (!equalNonce(body.nonce, nonce)) throw new RequestError(403, "连接已失效，请从 Magpie 重新发起。")
          if (settled || state === "committing") throw new RequestError(409, "连接已经完成。")
          if (request.url === "/probe") {
            send(response, 200, { ok: true })
            return
          }
          if (request.url === "/cancel") {
            state = "committing"
            send(response, 200, { ok: true }, () => finish({ type: "failed", error: "Notion 连接已取消，原有登录未修改。" }))
            return
          }
          if (request.url === "/select") {
            if (state !== "verified") throw new RequestError(409, "请先连接并验证 Notion 账号。")
            if (!identity.workspaces.some((space) => space.spaceId === body.spaceId)) throw new RequestError(400, "请选择当前账号的有效工作区。")
            state = "committing"
            const success = { type: "success", key, metadata: { email: identity.email, spaceId: body.spaceId, activeUserId: identity.activeUserId } }
            send(response, 200, { ok: true }, () => finish(success))
            return
          }
          if (typeof body.key !== "string" || !body.key.length || /[\x00-\x20;\x7f]/.test(body.key)) throw new RequestError(400, "Notion 登录会话无效，请重新登录。")
          if (state === "verified") {
            if (!equalNonce(body.key, Buffer.from(key))) throw new RequestError(409, "已连接其他 Notion 会话，请先取消后重新连接。")
            body.key = undefined
            send(response, 200, { email: identity.email, workspaces: identity.workspaces })
            return
          }
          if (state !== "waiting") throw new RequestError(409, "账号正在验证或已连接，请完成工作区确认。")
          state = "validating"
          const verification = new AbortController()
          const signal = AbortSignal.any([controller.signal, verification.signal])
          const deadline = setTimeout(() => verification.abort(), verificationTimeoutMs)
          try {
            const verified = identityOf(await abortable(loginInfo({ auth: { type: "api", key: body.key }, signal }), signal))
            if (settled || state !== "validating") return
            key = body.key
            identity = verified
            state = "verified"
            send(response, 200, { email: identity.email, workspaces: identity.workspaces })
          } catch (error) {
            if (settled || state !== "validating") return
            key = undefined; identity = undefined; state = "waiting"
            if (verification.signal.aborted) throw new RequestError(504, "Notion 账号验证已超时，请重新连接。")
            if (error?.code === "login_account_ambiguous") throw new RequestError(409, "无法唯一确认 Notion 账号，请在官网切换到要连接的单个账号后重试。", "login_account_ambiguous")
            const status = error?.status === 401 ? 401 : 502
            throw new RequestError(status, status === 401 ? "Notion 登录未通过验证，请在官网重新登录后再连接。" : "无法验证 Notion 账号，请检查网络后重新连接。")
          } finally { clearTimeout(deadline); body.key = undefined }
        } catch (error) {
          if (!settled) send(response, error instanceof RequestError ? error.status : 500, { error: error instanceof RequestError ? error.message : "无法完成连接，请重试。", ...(error instanceof RequestError && error.code ? { code: error.code } : {}) })
        }
      }
      server.headersTimeout = 10_000
      server.requestTimeout = 15_000
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
        })
      } catch {
        nonce.fill(0)
        server.close()
        throw new Error("无法启动本机 Notion 连接，请重试。")
      }
      server.on("error", () => finish({ type: "failed", error: "本机 Notion 连接已中断，原有登录未修改。" }))
      host = `127.0.0.1:${server.address().port}`
      timer = setTimeout(() => finish({ type: "failed", error: "Notion 连接已超时，请从 Magpie 重新发起。" }), timeoutMs)
      return {
        url: `http://${host}/connect#${nonce.toString()}`,
        method: "auto",
        instructions: "请在日常使用的浏览器中打开连接页，点击连接当前 Notion 账号，再确认工作区。",
        callback: () => result,
      }
    },
  }
}
