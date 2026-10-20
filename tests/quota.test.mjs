import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import protocol, { _internal } from "../protocol.mjs"

const { quotaWindows } = _internal
const periodEndMs = 1795136400000
const bucket = (bucketId, used, limit, extra = {}) => ({
  bucketId, cadence: "billing_period", state: "resolved", used: 100 * used / limit, limit: 100,
  periodEndMs, credits: { used, limit }, ...extra,
})
const auth = { type: "api", key: "synthetic-quota-test-only", metadata: { spaceId: "11111111-1111-4111-8111-111111111111", activeUserId: "22222222-2222-4222-8222-222222222222" } }
afterEach(() => _internal.useFetch(undefined))

test("resolved standard and select buckets survive not_applicable and hidden buckets", () => {
  const windows = quotaWindows({ status: "not_applicable", allowances: [
    { bucketId: "standard", cadence: "billing_period", state: "not_exposed" },
    bucket("auto", 0, 1500), bucket("flex", 0, 500),
    { bucketId: "standard", cadence: "rolling", state: "not_exposed" },
  ] })
  assert.deepEqual(windows, [
    { name: "标准 · 0/1500", used: 0, resetsAt: new Date(periodEndMs).toISOString() },
    { name: "精选 · 0/500", used: 0, resetsAt: new Date(periodEndMs).toISOString() },
  ])
})

test("bucket labels follow IDs rather than order or credit limits", () => {
  const windows = quotaWindows({ allowances: [bucket("flex", 300, 1500), bucket("auto", 50, 500)] })
  assert.deepEqual(windows.map(({ name, used }) => ({ name, used })), [
    { name: "精选 · 300/1500", used: 20 }, { name: "标准 · 50/500", used: 10 },
  ])
  assert.equal(quotaWindows({ allowances: [bucket("unknown", 0, 1500)] })[0].name, "Month")
})

test("missing or malformed credit values do not become displayed zero balances", () => {
  for (const credits of [undefined, {}, { used: undefined, limit: 1500 }, { used: "0", limit: 1500 }, { used: -1, limit: 1500 }, { used: 0, limit: 0 }, { used: 0, limit: Infinity }]) {
    const windows = quotaWindows({ allowances: [bucket("auto", 30, 1500, { credits })] })
    assert.equal(windows[0].name, "标准")
    assert.equal(windows[0].used, 2)
  }
  assert.deepEqual(quotaWindows({ allowances: [bucket("auto", 150, 1500, { used: undefined, limit: undefined })] })[0], {
    name: "标准 · 150/1500", used: 10, resetsAt: new Date(periodEndMs).toISOString(),
  })
})

test("unreadable resolved buckets remain unknown while explicitly hidden buckets stay absent", () => {
  const malformed = { bucketId: "auto", cadence: "billing_period", state: "resolved", used: "0", limit: 100 }
  assert.equal(quotaWindows({ status: "not_applicable", allowances: [malformed] }), undefined)
  assert.equal(quotaWindows({ allowances: [malformed] }), undefined)
  assert.deepEqual(quotaWindows({ status: "not_applicable" }), [])
  assert.deepEqual(quotaWindows({ allowances: [{ state: "not_exposed", used: 0, limit: 100 }] }), [])
  assert.deepEqual(quotaWindows({ allowances: [malformed, bucket("flex", 5, 500)] }).map(window => window.name), ["精选 · 5/500"])
  for (const value of [undefined, null, [], "invalid", {}]) assert.equal(quotaWindows(value), undefined)
})

test("legacy rolling and monthly windows and resolved fallbacks remain supported", () => {
  const windows = quotaWindows({
    window: { used: 5, limit: 20, window: "5h", resetsInSeconds: 60 },
    billingPeriodWindow: { used: 30, limit: 100, periodEndMs },
  })
  assert.deepEqual(windows, [
    { name: "5 hours", used: 25, span: 18000, resetSecs: 60 },
    { name: "Month", used: 30, resetsAt: new Date(periodEndMs).toISOString() },
  ])
  const fallback = quotaWindows({ window: {}, billingPeriodWindow: {}, resetsInSeconds: 0, allowances: [
    { cadence: "rolling", state: "resolved", used: 1, limit: 4, window: "1d" },
    { cadence: "billing_period", state: "resolved", used: 20, limit: 100 },
  ] })
  assert.deepEqual(fallback, [
    { name: "1 day", used: 25, span: 86400, resetSecs: 0 }, { name: "Month", used: 20 },
  ])
  assert.equal(quotaWindows({ allowances: [bucket("auto", 0, 1500, { periodEndMs: 9e15 })] })[0].resetsAt, undefined)
})

test("quota reports the actual Notion credit balance without inventing missing balances", async () => {
  for (const balance of [300, 0, undefined, "300", -1]) {
    const calls = []
    _internal.useFetch(async url => {
      const endpoint = new URL(url).pathname.split("/").at(-1)
      calls.push(endpoint)
      if (endpoint === "getCreditRateLimitStatus") return Response.json({ status: "not_applicable", allowances: [bucket("auto", 0, 1500), bucket("flex", 0, 500)] })
      assert.equal(endpoint, "getAIUsageEligibilityV2")
      return Response.json({ premiumCredits: { totalCreditBalance: balance } })
    })
    const usage = await protocol.usage({ auth })
    assert.equal(usage.windows.length, 2)
    assert.equal(usage.balance, typeof balance === "number" && balance >= 0 ? `Notion 积分：${balance}` : undefined)
    assert.deepEqual(calls, ["getCreditRateLimitStatus", "getAIUsageEligibilityV2"])
  }
})
