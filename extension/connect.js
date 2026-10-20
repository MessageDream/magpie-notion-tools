(() => {
  const nonce = location.hash.slice(1)
  const status = document.getElementById("status")
  const connect = document.getElementById("connect")
  const workspaces = document.getElementById("workspaces")
  const confirm = document.getElementById("confirm")
  const cancel = document.getElementById("cancel")
  if (!status || !connect || !(workspaces instanceof HTMLSelectElement) || !confirm || !cancel) return
  if (location.hostname !== "127.0.0.1" || location.pathname !== "/connect" || !/^[0-9a-f]{64}$/.test(nonce)) {
    status.textContent = "登录页面无效，请从 Magpie 重新发起登录。"
    connect.disabled = confirm.disabled = cancel.disabled = true
    return
  }
  let busy = false, finished = false, choices = []
  function controls() {
    connect.disabled = busy || finished || choices.length > 0
    workspaces.disabled = busy || finished || !choices.length
    confirm.disabled = busy || finished || !choices.some(space => space.spaceId === workspaces.value)
    cancel.disabled = finished
  }
  async function send(op, extra = {}) {
    const reply = await chrome.runtime.sendMessage({ op, nonce, ...extra })
    if (!reply || reply.ok !== true) throw new Error(typeof reply?.error === "string" ? reply.error : "连接未完成，请重新发起登录。")
    return reply
  }
  workspaces.addEventListener("change", controls)
  connect.addEventListener("click", async event => {
    if (!event.isTrusted || busy || finished) return
    busy = true
    choices = []
    workspaces.replaceChildren()
    controls()
    status.textContent = "正在验证本机会话并连接当前 Notion 账号…"
    try {
      const identity = await send("session")
      if (finished) return
      choices = identity.workspaces
      const placeholder = document.createElement("option")
      placeholder.value = ""
      placeholder.textContent = "请选择工作区"
      workspaces.append(placeholder)
      for (const space of choices) {
        const option = document.createElement("option")
        option.value = space.spaceId
        option.textContent = space.name || "Notion 工作区 " + space.spaceId.slice(0, 8)
        workspaces.append(option)
      }
      if (choices.length === 1) workspaces.value = choices[0].spaceId
      status.textContent = "已确认账号 " + identity.email + "。请选择工作区并点击确认，之后才会保存到 Magpie。"
    } catch (error) {
      if (!finished) status.textContent = error instanceof Error ? error.message : "连接未完成，请重新发起登录。"
    } finally { busy = false; controls() }
  })
  confirm.addEventListener("click", async event => {
    if (!event.isTrusted || busy || finished || !choices.some(space => space.spaceId === workspaces.value)) return
    busy = true
    controls()
    status.textContent = "正在确认工作区…"
    try {
      await send("select", { spaceId: workspaces.value })
      if (finished) return
      finished = true
      status.textContent = "已连接到 Magpie，可以关闭此页面。"
    } catch (error) {
      if (!finished) status.textContent = error instanceof Error ? error.message : "连接未完成，请返回 Magpie 查看状态。"
    } finally { busy = false; controls() }
  })
  cancel.addEventListener("click", async event => {
    if (!event.isTrusted || finished) return
    finished = true
    controls()
    status.textContent = "正在取消登录…"
    try {
      await send("cancel")
      status.textContent = "登录已取消，可以关闭此页面。"
    } catch {
      status.textContent = "取消请求未获确认，请返回 Magpie 查看登录状态。"
    }
  })
  status.textContent = "浏览器扩展已就绪。点击连接账号，再确认要使用的 Notion 工作区。"
  controls()
})()
