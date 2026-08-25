import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AppDatabase } from '../src/db.js'

test('preserves selection across scans and records idempotency states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-spark-db-'))
  const db = new AppDatabase(join(directory, 'test.db'))
  try {
    db.upsertFriends([
      { id: 'f1', name: '小明', avatar: 'a', sparkText: '7 天' },
      { id: 'f2', name: '小红', avatar: 'b', sparkText: '' },
    ])
    db.setSelectedFriends(['f1'])
    db.upsertFriends([{ id: 'f1', name: '小明', avatar: 'a', sparkText: '8 天' }])

    assert.deepEqual(db.selectedFriends(10).map((friend) => friend.id), ['f1'])
    assert.equal(db.selectedFriends(10)[0]?.sparkText, '8 天')

    db.createRun('run-1', 'manual', '2026-08-24T10:00:00.000Z')
    db.addDispatch('dispatch-1', 'run-1', '2026-08-24', {
      friendId: 'f1',
      friendName: '小明',
      state: 'delivery_unconfirmed',
      detail: '等待人工确认',
      message: '你好',
    })
    assert.equal(db.hasAttemptedDispatch('f1', '2026-08-24'), true)
    assert.equal(db.hasAttemptedDispatch('f1', '2026-08-25'), false)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('replaces a legacy name containing its spark count and preserves selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-spark-db-'))
  const db = new AppDatabase(join(directory, 'test.db'))
  try {
    db.upsertFriends([{
      id: 'old',
      name: 'iy 63',
      avatar: 'https://old.example/avatar/same-avatar.webp?version=1',
      sparkText: '63',
    }])
    db.setSelectedFriends(['old'])
    db.upsertFriends([{
      id: 'new',
      name: 'iy',
      avatar: 'https://new.example/cdn/same-avatar.webp?version=2',
      sparkText: '63',
    }])

    assert.deepEqual(db.listFriends().map((friend) => ({ id: friend.id, name: friend.name, selected: friend.selected })), [
      { id: 'new', name: 'iy', selected: true },
    ])
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('repairs a stored legacy spark suffix when the database opens', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-spark-db-'))
  const path = join(directory, 'test.db')
  const first = new AppDatabase(path)
  try {
    first.upsertFriends([{
      id: 'legacy',
      name: 'iy 63',
      avatar: 'https://example.test/avatar/stable.webp?old=1',
      sparkText: '63',
    }])
    first.setSelectedFriends(['legacy'])
  } finally {
    first.close()
  }

  const reopened = new AppDatabase(path)
  try {
    assert.deepEqual(reopened.listFriends().map((friend) => ({ name: friend.name, sparkText: friend.sparkText, selected: friend.selected })), [
      { name: 'iy', sparkText: '63', selected: true },
    ])
  } finally {
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
