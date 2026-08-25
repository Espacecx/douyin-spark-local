import assert from 'node:assert/strict'
import test from 'node:test'

import {
  avatarSignature,
  cleanConversationName,
  conversationHeaderMatches,
  friendIdentity,
  normalizeMessageText,
} from '../src/browser/friend-utils.js'

test('normalizes names and message text', () => {
  assert.equal(cleanConversationName('  小明   昨天  '), '小明')
  assert.equal(cleanConversationName('小红 3 小时前'), '小红')
  assert.equal(cleanConversationName('iy 63', '63'), 'iy')
  assert.equal(cleanConversationName('iy 🍃63', '63'), 'iy')
  assert.equal(cleanConversationName('用户63'), '用户63')
  assert.equal(cleanConversationName('小雨 9 周五'), '小雨')
  assert.equal(normalizeMessageText('  你好\u200b\n 世界  '), '你好 世界')
})

test('matches chat titles after separating spark metadata', () => {
  assert.equal(conversationHeaderMatches(['iy 63'], 'iy', '63'), true)
  assert.equal(conversationHeaderMatches(['iy 🍃63'], 'iy', '63'), true)
  assert.equal(conversationHeaderMatches(['iy\n63\n视频通话'], 'iy', '63'), true)
  assert.equal(conversationHeaderMatches(['iy 64'], 'iy', '63'), false)
  assert.equal(conversationHeaderMatches(['another 63'], 'iy', '63'), false)
})

test('builds stable friend identity from avatar path', () => {
  assert.equal(avatarSignature('https://a.test/path/avatar.jpeg?x=1'), 'avatar.jpeg')
  assert.equal(
    friendIdentity('小明', 'https://a.test/path/avatar.jpeg?x=1'),
    friendIdentity('小明', 'https://cdn.test/other/avatar.jpeg?x=2'),
  )
  assert.notEqual(
    friendIdentity('小明', 'https://a.test/path/avatar.jpeg'),
    friendIdentity('小红', 'https://a.test/path/avatar.jpeg'),
  )
})
