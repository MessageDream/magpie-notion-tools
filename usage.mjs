import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0
const select = (value, keys) => Object.fromEntries(keys.filter(key => number(value?.[key])).map(key => [key, value[key]]))
export const unknownTokens = () => ({ status: "not_reported", source: "notion_agent_transcript" })

function trustedParents(directory) {
  const uid = process.getuid?.()
  for (let parent = path.dirname(directory);;) {
    const stat = fs.lstatSync(parent)
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) ||
        ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error("unsafe parent permissions")
    const next = path.dirname(parent)
    if (next === parent) return
    parent = next
  }
}

// Keep vendor units separate. Legacy usage counters are not model tokens.
export function creditSnapshot(payload, eligibility, account, observedAt = new Date().toISOString()) {
  const buckets = (Array.isArray(payload?.allowances) ? payload.allowances : []).flatMap(entry => {
    if (!["auto", "flex", "standard"].includes(entry?.bucketId) ||
        !["billing_period", "rolling"].includes(entry?.cadence)) return []
    const item = {
      bucket: entry.bucketId, cadence: entry.cadence,
      status: entry.state === "resolved" ? "reported" : "not_reported",
    }
    if (item.status === "reported") {
      item.credits = select(entry.credits, ["used", "limit"])
      item.allowance = select(entry, ["used", "limit"])
      Object.assign(item, select(entry, ["periodStartMs", "periodEndMs"]))
    }
    return [item]
  })
  const premium = eligibility?.premiumCredits
  const perSource = Object.fromEntries(["monthlyAllocated", "monthlyCommitted", "stackedTrial", "yearlyElastic"]
    .filter(key => premium?.perSource?.[key])
    .map(key => [key, select(premium.perSource[key], ["usageTotal", "limit"])]))
  return {
    version: 1, kind: "credit_snapshot", account, observedAt,
    source: "getCreditRateLimitStatus", scope: "workspace_account", unit: "notion_credit",
    tokenUsage: unknownTokens(), buckets,
    eligibility: {
      status: eligibility ? "reported" : "unavailable",
      source: "getAIUsageEligibilityV2",
      premiumCredits: { ...select(premium, ["totalCreditBalance", "creditsInOverage", "overageLimit", "servicePeriodStartMs"]), perSource },
      legacyUsage: {
        unit: "vendor_usage_counter_not_tokens",
        currentServicePeriod: select(eligibility?.usage?.currentServicePeriod, ["spaceUsage", "userUsage"]),
        lifetime: select(eligibility?.usage?.lifetime, ["spaceUsage", "userUsage", "userPromotionalUsage"]),
        timestamps: select(eligibility?.usage, ["lastSpaceUsageAtMs", "lastSpaceUserUsageAtMs"]),
        basicCredits: select(eligibility?.basicCredits, ["spaceUsage", "userUsage", "userPromotionalUsage",
          "spaceLimit", "userLimit", "userPromotionalLimit", "lastSpaceUsageAtMs", "lastSpaceUserUsageAtMs"]),
      },
    },
  }
}

export function creditDelta(before, after) {
  const result = { kind: "credit_delta", scope: "account_interval", unit: "notion_credit",
    attribution: "not_per_request", from: before?.observedAt, to: after?.observedAt, buckets: [] }
  if (!before?.account || before.account !== after?.account ||
      !Number.isFinite(Date.parse(before.observedAt)) || !Number.isFinite(Date.parse(after.observedAt)) ||
      Date.parse(after.observedAt) < Date.parse(before.observedAt)) return { ...result, status: "incomparable" }
  const names = new Set([...(before.buckets ?? []), ...(after.buckets ?? [])]
    .filter(x => x.cadence === "billing_period").map(x => x.bucket))
  for (const bucket of names) {
    const start = before.buckets?.find(x => x.bucket === bucket && x.cadence === "billing_period")
    const end = after.buckets?.find(x => x.bucket === bucket && x.cadence === "billing_period")
    const valid = start?.status === "reported" && end?.status === "reported" &&
      number(start.periodStartMs) && number(start.periodEndMs) &&
      start.periodEndMs > start.periodStartMs &&
      start.periodStartMs === end.periodStartMs && start.periodEndMs === end.periodEndMs &&
      number(start.credits?.used) && number(end.credits?.used) && end.credits.used >= start.credits.used
    result.buckets.push({ bucket, status: valid ? "observed" : "unknown",
      ...(valid ? { consumed: Number((end.credits.used - start.credits.used).toFixed(6)) } : {}) })
  }
  return { ...result, status: result.buckets.length && result.buckets.every(x => x.status === "observed")
    ? "observed" : result.buckets.some(x => x.status === "observed") ? "partial" : "unknown" }
}

// Opt-in, independent receipts cannot turn telemetry failures into generation retries.
// Exclusive files avoid concurrent appends and retain receipts across process restarts.
export function recordUsage(record) {
  const directory = process.env.MAGPIE_NOTION_USAGE_DIR
  if (!directory) return { status: "disabled" }
  let fd, temporary
  try {
    if (!path.isAbsolute(directory)) throw new Error("absolute directory required")
    if (fs.realpathSync(path.dirname(directory)) !== path.dirname(path.resolve(directory))) throw new Error("unsafe parent")
    trustedParents(path.resolve(directory))
    try { fs.mkdirSync(directory, { mode: 0o700 }) }
    catch (error) { if (error.code !== "EEXIST") throw error }
    const stat = fs.lstatSync(directory)
    if (fs.realpathSync(directory) !== path.resolve(directory) || !stat.isDirectory() ||
        (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe directory")
    const data = JSON.stringify({ ...record, recordedAt: new Date().toISOString() }) + "\n"
    if (Buffer.byteLength(data) > 32768) throw new Error("oversized receipt")
    const filename = `${Date.now()}-${randomUUID()}.json`
    temporary = path.join(directory, "." + filename + ".tmp")
    fd = fs.openSync(temporary, "wx", 0o600)
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temporary, path.join(directory, filename))
    temporary = undefined
    fd = fs.openSync(directory, "r")
    fs.fsyncSync(fd)
    return { status: "recorded" }
  } catch {
    try { fs.writeSync(2, "Notion usage receipt unavailable; generation retry was not requested.\n") } catch {}
    return { status: "unavailable" }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    if (temporary) { try { fs.unlinkSync(temporary) } catch {} }
  }
}
