import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type DispatchRecord,
  type DispatchResult,
  type FriendRecord,
  type RunMode,
  type RunRecord,
  type RunStatus,
} from './types.js'
import {
  avatarSignature,
  cleanConversationName,
  friendIdentity,
} from './browser/friend-utils.js'

export class AppDatabase {
  readonly #db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.#migrate()
  }

  close(): void {
    this.#db.close()
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friends (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL DEFAULT '',
        spark_text TEXT NOT NULL DEFAULT '',
        selected INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        friend_id TEXT NOT NULL,
        friend_name TEXT NOT NULL,
        local_date TEXT NOT NULL,
        message TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        spark_before TEXT,
        spark_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dispatches_friend_date
      ON dispatches(friend_id, local_date, state);
    `)

    const row = this.#db.prepare('SELECT id FROM settings WHERE id = 1').get()
    if (!row) {
      this.#db
        .prepare('INSERT INTO settings(id, json, updated_at) VALUES(1, ?, ?)')
        .run(JSON.stringify(DEFAULT_SETTINGS), new Date().toISOString())
    }
    this.#repairLegacyFriendNames()
  }

  #repairLegacyFriendNames(): void {
    const rows = this.#db.prepare(`
      SELECT id, name, avatar, spark_text, selected, last_seen_at
      FROM friends WHERE spark_text <> ''
    `).all() as Array<{
      id: string
      name: string
      avatar: string
      spark_text: string
      selected: number
      last_seen_at: string
    }>
    const updateIdentity = this.#db.prepare('UPDATE friends SET id = ?, name = ? WHERE id = ?')
    const mergeTarget = this.#db.prepare(`
      UPDATE friends SET
        selected = CASE WHEN selected = 1 OR ? = 1 THEN 1 ELSE 0 END,
        spark_text = CASE WHEN spark_text = '' THEN ? ELSE spark_text END,
        last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
      WHERE id = ?
    `)
    const removeLegacy = this.#db.prepare('DELETE FROM friends WHERE id = ?')

    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const cleanedName = cleanConversationName(row.name, row.spark_text)
        if (!cleanedName || cleanedName === row.name) continue
        const correctedId = friendIdentity(cleanedName, row.avatar)
        const existing = this.#db.prepare('SELECT id FROM friends WHERE id = ?').get(correctedId)
        if (existing) {
          mergeTarget.run(
            row.selected,
            row.spark_text,
            row.last_seen_at,
            row.last_seen_at,
            correctedId,
          )
          removeLegacy.run(row.id)
        } else {
          updateIdentity.run(correctedId, cleanedName, row.id)
        }
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  getSettings(): AppSettings {
    const row = this.#db.prepare('SELECT json FROM settings WHERE id = 1').get() as
      | { json: string }
      | undefined
    return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.json) as Partial<AppSettings>) : {}) }
  }

  saveSettings(settings: AppSettings): AppSettings {
    this.#db
      .prepare('UPDATE settings SET json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(settings), new Date().toISOString())
    return settings
  }

  upsertFriends(
    friends: Array<Omit<FriendRecord, 'selected' | 'lastSeenAt'>>,
    seenAt = new Date().toISOString(),
  ): FriendRecord[] {
    const statement = this.#db.prepare(`
      INSERT INTO friends(id, name, avatar, spark_text, selected, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        avatar = excluded.avatar,
        spark_text = excluded.spark_text,
        last_seen_at = excluded.last_seen_at
    `)
    const legacyLookup = this.#db.prepare(`
      SELECT id, avatar, selected FROM friends
      WHERE spark_text = ? AND name = ? AND id <> ?
    `)
    const legacyDelete = this.#db.prepare('DELETE FROM friends WHERE id = ?')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const friend of friends) {
        const legacyName = `${friend.name} ${friend.sparkText}`.trim()
        const signature = avatarSignature(friend.avatar)
        const legacyCandidates = friend.sparkText && signature
          ? (legacyLookup.all(friend.sparkText, legacyName, friend.id) as Array<{
              id: string
              avatar: string
              selected: number
            }>).filter((candidate) => avatarSignature(candidate.avatar) === signature)
          : []
        const legacy = legacyCandidates.length === 1 ? legacyCandidates[0] : undefined
        if (legacy) legacyDelete.run(legacy.id)
        statement.run(
          friend.id,
          friend.name,
          friend.avatar,
          friend.sparkText,
          legacy?.selected ?? 0,
          seenAt,
        )
      }
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return this.listFriends()
  }

  listFriends(): FriendRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, name, avatar, spark_text, selected, last_seen_at
         FROM friends ORDER BY selected DESC, name COLLATE NOCASE`,
      )
      .all() as Array<{
      id: string
      name: string
      avatar: string
      spark_text: string
      selected: number
      last_seen_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      avatar: row.avatar,
      sparkText: row.spark_text,
      selected: Boolean(row.selected),
      lastSeenAt: row.last_seen_at,
    }))
  }

  setSelectedFriends(ids: string[]): FriendRecord[] {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#db.prepare('UPDATE friends SET selected = 0').run()
      const select = this.#db.prepare('UPDATE friends SET selected = 1 WHERE id = ?')
      for (const id of [...new Set(ids)]) select.run(id)
      this.#db.exec('COMMIT')
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
    return this.listFriends()
  }

  selectedFriends(limit: number): FriendRecord[] {
    return this.listFriends()
      .filter((friend) => friend.selected)
      .slice(0, limit)
  }

  createRun(id: string, mode: RunMode, startedAt: string): void {
    this.#db
      .prepare('INSERT INTO runs(id, mode, status, started_at, summary) VALUES(?, ?, ?, ?, ?)')
      .run(id, mode, 'running', startedAt, '')
  }

  finishRun(id: string, status: RunStatus, summary: string, endedAt = new Date().toISOString()): void {
    this.#db
      .prepare('UPDATE runs SET status = ?, summary = ?, ended_at = ? WHERE id = ?')
      .run(status, summary, endedAt, id)
  }

  addDispatch(
    id: string,
    runId: string,
    date: string,
    result: DispatchResult,
    createdAt = new Date().toISOString(),
  ): void {
    this.#db
      .prepare(`
        INSERT INTO dispatches(
          id, run_id, friend_id, friend_name, local_date, message, state, detail,
          spark_before, spark_after, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        runId,
        result.friendId,
        result.friendName,
        date,
        result.message,
        result.state,
        result.detail,
        result.sparkBefore ?? null,
        result.sparkAfter ?? null,
        createdAt,
        createdAt,
      )
  }

  hasAttemptedDispatch(friendId: string, date: string): boolean {
    const row = this.#db
      .prepare(`
        SELECT 1 FROM dispatches
        WHERE friend_id = ? AND local_date = ?
          AND state IN ('delivery_verified', 'delivery_unconfirmed', 'spark_changed')
        LIMIT 1
      `)
      .get(friendId, date)
    return Boolean(row)
  }

  listRuns(limit = 25): RunRecord[] {
    const runs = this.#db
      .prepare(`
        SELECT id, mode, status, started_at, ended_at, summary
        FROM runs ORDER BY started_at DESC LIMIT ?
      `)
      .all(limit) as Array<{
      id: string
      mode: RunMode
      status: RunStatus
      started_at: string
      ended_at: string | null
      summary: string
    }>

    const dispatchQuery = this.#db.prepare(`
      SELECT id, run_id, friend_id, friend_name, local_date, message, state, detail,
             spark_before, spark_after, created_at, updated_at
      FROM dispatches WHERE run_id = ? ORDER BY created_at
    `)

    return runs.map((run) => {
      const rows = dispatchQuery.all(run.id) as Array<{
        id: string
        run_id: string
        friend_id: string
        friend_name: string
        local_date: string
        message: string
        state: DispatchRecord['state']
        detail: string
        spark_before: string | null
        spark_after: string | null
        created_at: string
        updated_at: string
      }>
      return {
        id: run.id,
        mode: run.mode,
        status: run.status,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        summary: run.summary,
        dispatches: rows.map((row) => ({
          id: row.id,
          runId: row.run_id,
          friendId: row.friend_id,
          friendName: row.friend_name,
          localDate: row.local_date,
          message: row.message,
          state: row.state,
          detail: row.detail,
          ...(row.spark_before ? { sparkBefore: row.spark_before } : {}),
          ...(row.spark_after ? { sparkAfter: row.spark_after } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
      }
    })
  }
}
