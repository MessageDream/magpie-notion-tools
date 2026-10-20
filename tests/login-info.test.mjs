import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import protocol, { _internal } from '../protocol.mjs'

const userId = '11111111-1111-4111-8111-111111111111'
const otherId = '22222222-2222-4222-8222-222222222222'
const spaceId = '33333333-3333-4333-8333-333333333333'
const auth = { type: 'api', key: 'synthetic-session-only' }
const wrap = value => ({ value: { value, role: 'reader' } })
function entry(owner, email = 'owner@example.test') {
  return { notion_user: { [otherId]: wrap({ id: otherId, email:'other@example.test' }), [owner]: wrap({ id:owner, email }) }, space: { [spaceId]: wrap({ id:spaceId, name:'Test workspace' }) } }
}
function fixture(body) {
  _internal.useFetch(async url => {
    const name = new URL(url).pathname.split('/').at(-1)
    assert.ok(['authValidate','getSpaces'].includes(name))
    return Response.json(name === 'authValidate' ? {} : body)
  })
}
afterEach(() => _internal.useFetch(undefined))

test('login info uses the owning user and supports actual nested record wrappers', async () => {
  fixture({ [userId]:entry(userId) })
  assert.deepEqual(await protocol.loginInfo({ auth }), { email:'owner@example.test',activeUserId:userId,workspaces:[{spaceId,name:'Test workspace'}] })
})

test('login info returns all owned workspaces for explicit user selection', async () => {
  const value = entry(userId)
  value.space[otherId] = { id:otherId,name:'Other workspace' }
  fixture({ [userId]:value })
  assert.equal((await protocol.loginInfo({ auth })).workspaces.length, 2)
})

test('login info refuses ambiguous accounts and accepts an explicit active user', async () => {
  fixture({ [userId]:entry(userId), [otherId]:entry(otherId,'second@example.test') })
  await assert.rejects(() => protocol.loginInfo({ auth }), { code:'login_account_ambiguous' })
  assert.equal((await protocol.loginInfo({ auth:{...auth,metadata:{activeUserId:otherId}} })).email,'second@example.test')
})

test('login info does not substitute a teammate email or mismatched record', async () => {
  const value = entry(userId)
  delete value.notion_user[userId]
  fixture({ [userId]:value })
  await assert.rejects(() => protocol.loginInfo({ auth }), { code:'login_account_ambiguous' })
  value.notion_user[userId] = wrap({id:otherId,email:'wrong@example.test'})
  await assert.rejects(() => protocol.loginInfo({ auth }), { code:'login_account_ambiguous' })
})
