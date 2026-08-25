import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AppDatabase } from '../src/db.js'
import { TaskRunner } from '../src/services/task-runner.js'
import type { BrowserStatus, DispatchResult, DouyinClient, IdentityCheckRequest, IdentityCheckResult, ProbeResult, SendRequest } from '../src/types.js'

class FakeClient implements DouyinClient {
  sends = 0
  checks = 0

  async status(): Promise<BrowserStatus> {
    return { state: 'ready', detail: 'fake', lastCheckedAt: null }
  }

  async openLogin(): Promise<BrowserStatus> {
    return this.status()
  }

  async probeFriends(_signal: AbortSignal): Promise<ProbeResult> {
    return { friends: [], scannedAt: new Date().toISOString() }
  }

  async checkConversationIdentity(request: IdentityCheckRequest): Promise<IdentityCheckResult> {
    this.checks += 1
    return {
      friendId: request.friend.id,
      friendName: request.friend.name,
      verified: true,
      detail: 'fake verified',
    }
  }

  async sendAndVerify(request: SendRequest): Promise<DispatchResult> {
    this.sends += 1
    return {
      friendId: request.friend.id,
      friendName: request.friend.name,
      state: 'delivery_verified',
      detail: 'fake verified',
      message: request.message,
    }
  }

  async close(): Promise<void> {}
}

function fixture(): { directory: string; db: AppDatabase; client: FakeClient; runner: TaskRunner } {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-spark-runner-'))
  const db = new AppDatabase(join(directory, 'test.db'))
  const client = new FakeClient()
  return { directory, db, client, runner: new TaskRunner(db, client) }
}

test('preview never calls the send client', async () => {
  const { directory, db, client, runner } = fixture()
  try {
    db.upsertFriends([{ id: 'f1', name: '小明', avatar: 'a', sparkText: '' }])
    db.setSelectedFriends(['f1'])
    const run = await runner.run('preview')
    assert.equal(client.sends, 0)
    assert.equal(run.status, 'completed')
    assert.equal(run.dispatches?.[0]?.state, 'preview')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('identity check opens the safe path without sending', async () => {
  const { directory, db, client, runner } = fixture()
  try {
    db.upsertFriends([{ id: 'f1', name: '小明', avatar: 'a', sparkText: '12' }])
    db.setSelectedFriends(['f1'])
    const results = await runner.checkSelectedIdentities()
    assert.equal(results[0]?.verified, true)
    assert.equal(client.checks, 1)
    assert.equal(client.sends, 0)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('actual send requires explicit enablement and blocks a same-day repeat', async () => {
  const { directory, db, client, runner } = fixture()
  try {
    db.upsertFriends([{ id: 'f1', name: '小明', avatar: 'a', sparkText: '' }])
    db.setSelectedFriends(['f1'])
    await assert.rejects(() => runner.run('manual'), /总开关未开启/)

    db.saveSettings({ ...db.getSettings(), sendingEnabled: true, riskAcknowledged: true })
    const first = await runner.run('manual')
    const second = await runner.run('manual')

    assert.equal(first.dispatches?.[0]?.state, 'delivery_verified')
    assert.equal(second.dispatches?.[0]?.state, 'skipped_already_verified')
    assert.equal(client.sends, 1)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('duplicate visible names are skipped without sending', async () => {
  const { directory, db, client, runner } = fixture()
  try {
    db.upsertFriends([
      { id: 'f1', name: '同名', avatar: 'a', sparkText: '' },
      { id: 'f2', name: '同名', avatar: 'b', sparkText: '' },
    ])
    db.setSelectedFriends(['f1', 'f2'])
    const run = await runner.run('preview')
    assert.equal(client.sends, 0)
    assert.deepEqual(run.dispatches?.map((item) => item.state), [
      'skipped_ambiguous_name',
      'skipped_ambiguous_name',
    ])
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
