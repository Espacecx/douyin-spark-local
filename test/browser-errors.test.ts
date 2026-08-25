import assert from 'node:assert/strict'
import test from 'node:test'

import { friendlyBrowserError, networkAccessIsDisabled } from '../src/browser/errors.js'

test('detects a disabled network sandbox explicitly', () => {
  assert.equal(networkAccessIsDisabled({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), true)
  assert.equal(networkAccessIsDisabled({ CODEX_SANDBOX_NETWORK_DISABLED: 'true' }), true)
  assert.equal(networkAccessIsDisabled({ CODEX_SANDBOX_NETWORK_DISABLED: '0' }), false)
  assert.equal(networkAccessIsDisabled({}), false)
})

test('turns raw browser network errors into an actionable message', () => {
  const result = friendlyBrowserError(
    new Error('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://www.douyin.com/chat Call log: \u001b[2m- navigating\u001b[22m'),
    'msedge',
  )
  assert.match(result, /没有外网访问权限/)
  assert.match(result, /启动控制面板\.cmd/)
  assert.doesNotMatch(result, /Call log|\u001b/)
})

test('reports a missing configured browser in plain language', () => {
  assert.match(friendlyBrowserError(new Error("Executable doesn't exist"), 'chrome'), /Google Chrome/)
})
