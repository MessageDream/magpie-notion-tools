import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { creditSnapshot, creditDelta, recordUsage } from "../usage.mjs"

const snapshot = (used, extra = {}) => creditSnapshot({ allowances: [
  { bucketId: "auto", cadence: "billing_period", state: "resolved",
    credits: { used, limit: 1500 }, used: 1.2, limit: 100,
    periodStartMs: 1000, periodEndMs: 2000, ...extra },
  { bucketId: "standard", cadence: "rolling", state: "not_exposed", credits: { used: 999 } },
] }, { usage: { lifetime: { spaceUsage: 672 } }, premiumCredits: { totalCreditBalance: 300 } },
"account-a", "2026-10-22T15:00:00Z")

test("snapshots preserve units and keep hidden and absent values unknown", () => {
  const value = snapshot(16.860314)
  assert.equal(value.buckets[0].credits.used, 16.860314)
  assert.deepEqual(value.buckets[0].allowance, {used:1.2,limit:100})
  assert.equal(value.buckets[1].credits, undefined)
  assert.equal(value.tokenUsage.status, "not_reported")
  assert.equal(value.eligibility.legacyUsage.lifetime.spaceUsage, 672)
  assert.equal(value.eligibility.premiumCredits.totalCreditBalance, 300)
  assert.deepEqual(snapshot("unknown").buckets[0].credits, {limit:1500})
  assert.equal(creditSnapshot({}, undefined, "a").eligibility.status, "unavailable")
  const legacy=creditSnapshot({},{
    usage:{lastSpaceUsageAtMs:1234,lastSpaceUserUsageAtMs:1235},
    basicCredits:{spaceUsage:672,userUsage:672,spaceLimit:50,userLimit:50,secret:"excluded"},
  },"a").eligibility.legacyUsage
  assert.deepEqual(legacy.timestamps,{lastSpaceUsageAtMs:1234,lastSpaceUserUsageAtMs:1235})
  assert.deepEqual(legacy.basicCredits,{spaceUsage:672,userUsage:672,spaceLimit:50,userLimit:50})
})

test("credit deltas require matching accounts, periods, numeric counters, and time order", () => {
  const a = snapshot(10), b = snapshot(10.418776)
  assert.equal(creditDelta(a,b).buckets[0].consumed, .418776)
  assert.equal(creditDelta(b,b).buckets[0].consumed, 0)
  for (const invalid of [snapshot(9), snapshot(undefined), snapshot(12,{periodStartMs:3000}),
    snapshot(12,{periodEndMs:undefined}), snapshot(12,{state:"not_exposed"})]) {
    assert.equal(creditDelta(a,invalid).buckets[0].status,"unknown")
    assert.equal(creditDelta(a,invalid).buckets[0].consumed,undefined)
  }
  assert.equal(creditDelta(a,{...b,account:"other"}).status,"incomparable")
  assert.equal(creditDelta(a,{...b,observedAt:"2020-01-01"}).status,"incomparable")
  assert.equal(creditDelta(a,{...b,buckets:[]}).buckets[0].status,"unknown")
  assert.equal(creditDelta({...a,buckets:[]},{...b,buckets:[]}).status,"unknown")
})

test("receipts survive independent writes and reject unsafe paths without throwing", () => {
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"notion-usage-")))
  const old=process.env.MAGPIE_NOTION_USAGE_DIR
  try {
    delete process.env.MAGPIE_NOTION_USAGE_DIR
    assert.equal(recordUsage(snapshot(1)).status,"disabled")
    process.env.MAGPIE_NOTION_USAGE_DIR=path.join(parent,"receipts")
    assert.equal(recordUsage(snapshot(1)).status,"recorded")
    assert.equal(recordUsage(snapshot(2)).status,"recorded")
    const files=fs.readdirSync(process.env.MAGPIE_NOTION_USAGE_DIR)
    assert.equal(files.length,2)
    for(const file of files) {
      const name=path.join(process.env.MAGPIE_NOTION_USAGE_DIR,file)
      assert.equal(fs.statSync(name).mode&0o777,0o600)
      assert.equal(JSON.parse(fs.readFileSync(name)).kind,"credit_snapshot")
    }
    const link=path.join(parent,"link")
    fs.symlinkSync(path.join(parent,"receipts"),link)
    process.env.MAGPIE_NOTION_USAGE_DIR=link
    assert.equal(recordUsage(snapshot(3)).status,"unavailable")
    process.env.MAGPIE_NOTION_USAGE_DIR=path.join(link,"escape")
    assert.equal(recordUsage(snapshot(3)).status,"unavailable")
    assert.equal(fs.existsSync(path.join(parent,"receipts","escape")),false)
    process.env.MAGPIE_NOTION_USAGE_DIR=path.join(parent,"receipts")
    fs.chmodSync(process.env.MAGPIE_NOTION_USAGE_DIR,0o777)
    assert.equal(recordUsage(snapshot(3)).status,"unavailable")
    fs.chmodSync(process.env.MAGPIE_NOTION_USAGE_DIR,0o700)
    fs.chmodSync(parent,0o777)
    assert.equal(recordUsage(snapshot(3)).status,"unavailable")
    fs.chmodSync(parent,0o700)
  } finally {
    if(old===undefined) delete process.env.MAGPIE_NOTION_USAGE_DIR
    else process.env.MAGPIE_NOTION_USAGE_DIR=old
    fs.rmSync(parent,{recursive:true,force:true})
  }
})

test("partial writes and broken diagnostics cannot publish malformed receipts or throw", () => {
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"notion-usage-failure-")))
  const old=process.env.MAGPIE_NOTION_USAGE_DIR
  const writeFile=fs.writeFileSync, write=fs.writeSync
  process.env.MAGPIE_NOTION_USAGE_DIR=path.join(parent,"receipts")
  try {
    fs.writeFileSync=(fd)=>{ write(fd,"{");throw new Error("simulated disk failure") }
    fs.writeSync=()=>{throw new Error("simulated stderr failure")}
    assert.deepEqual(recordUsage(snapshot(1)),{status:"unavailable"})
    assert.deepEqual(fs.readdirSync(process.env.MAGPIE_NOTION_USAGE_DIR),[])
  } finally {
    fs.writeFileSync=writeFile;fs.writeSync=write
    if(old===undefined)delete process.env.MAGPIE_NOTION_USAGE_DIR
    else process.env.MAGPIE_NOTION_USAGE_DIR=old
    fs.rmSync(parent,{recursive:true,force:true})
  }
})
