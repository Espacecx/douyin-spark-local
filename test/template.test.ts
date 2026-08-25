import assert from 'node:assert/strict'
import test from 'node:test'

import { localDate, renderMessage } from '../src/template.js'
import type { FriendRecord } from '../src/types.js'

const friend: FriendRecord = {
  id: 'friend-1',
  name: '小明',
  avatar: 'https://example.test/avatar.png',
  sparkText: '火花 7 天',
  selected: true,
  lastSeenAt: '2026-08-24T00:00:00.000Z',
}

test('renders supported variables in Shanghai time', () => {
  const now = new Date('2026-08-23T16:05:00.000Z')
  const rendered = renderMessage('{{friend}}，{{date}} {{time}} {{weekday}} 🔥', friend, now)
  assert.match(rendered, /^小明，2026-08-24 00:05 星期一 🔥$/)
  assert.equal(localDate(now), '2026-08-24')
})

test('rejects unknown, empty and oversized templates', () => {
  assert.throws(() => renderMessage('{{unknown}}', friend), /未知模板变量/)
  assert.throws(() => renderMessage('   ', friend), /渲染后为空/)
  assert.throws(() => renderMessage('a'.repeat(501), friend), /超过 500/)
})
