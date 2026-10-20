import { readFileSync } from "node:fs"
import { createPlugin } from "./core.mjs"
import protocol from "./protocol.mjs"
import { createExtensionLogin } from "./auth-extension.mjs"
import { EXTENSION_ID } from "./extension-config.mjs"

const icon = "data:image/svg+xml;base64," + readFileSync(new URL("./assets/logo.svg", import.meta.url)).toString("base64")

export const NotionToolsPlugin = async (_input, options) => {
  const plugin = createPlugin(protocol, options)
  plugin.auth.icon = icon
  plugin.auth.methods.unshift(createExtensionLogin({ loginInfo: protocol.loginInfo, extensionId: EXTENSION_ID, timeoutMs: options?.loginTimeoutMs }))
  return plugin
}
