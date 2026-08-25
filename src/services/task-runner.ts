import { randomUUID } from 'node:crypto'

import { AppDatabase } from '../db.js'
import { localDate, renderMessage } from '../template.js'
import type {
  DispatchResult,
  DouyinClient,
  FriendRecord,
  IdentityCheckResult,
  ProbeResult,
  RunMode,
  RunRecord,
  RunStatus,
} from '../types.js'

export interface RunnerSnapshot {
  busy: boolean
  operation: 'idle' | 'probing' | 'checking' | 'running'
  startedAt: string | null
}

export class TaskRunner {
  readonly #db: AppDatabase
  readonly #client: DouyinClient
  #controller: AbortController | null = null
  #snapshot: RunnerSnapshot = { busy: false, operation: 'idle', startedAt: null }

  constructor(db: AppDatabase, client: DouyinClient) {
    this.#db = db
    this.#client = client
  }

  snapshot(): RunnerSnapshot {
    return { ...this.#snapshot }
  }

  stop(): boolean {
    if (!this.#controller) return false
    this.#controller.abort(new Error('用户已停止任务'))
    return true
  }

  async probe(): Promise<ProbeResult> {
    return this.#exclusive('probing', async (signal) => {
      const result = await this.#client.probeFriends(signal)
      this.#db.upsertFriends(result.friends, result.scannedAt)
      return result
    })
  }

  async checkSelectedIdentities(): Promise<IdentityCheckResult[]> {
    return this.#exclusive('checking', async (signal) => {
      const settings = this.#db.getSettings()
      const targets = this.#db.selectedFriends(settings.maxTargetsPerRun)
      if (targets.length === 0) throw new Error('尚未选择好友')
      const duplicateNames = duplicateNameSet(targets)
      const results: IdentityCheckResult[] = []
      for (const friend of targets) {
        signal.throwIfAborted()
        if (duplicateNames.has(friend.name)) {
          results.push({
            friendId: friend.id,
            friendName: friend.name,
            verified: false,
            detail: '存在同名好友，请设置唯一备注后重新扫描',
          })
          continue
        }
        results.push(await this.#client.checkConversationIdentity({ friend, signal }))
      }
      return results
    })
  }

  async run(mode: RunMode): Promise<RunRecord> {
    return this.#exclusive('running', async (signal) => {
      const settings = this.#db.getSettings()
      if (mode !== 'preview' && (!settings.sendingEnabled || !settings.riskAcknowledged)) {
        throw new Error('实际发送总开关未开启')
      }

      const targets = this.#db.selectedFriends(settings.maxTargetsPerRun)
      if (targets.length === 0) throw new Error('尚未选择好友')

      const runId = randomUUID()
      const startedAt = new Date().toISOString()
      const date = localDate()
      this.#db.createRun(runId, mode, startedAt)

      const duplicateNames = duplicateNameSet(targets)
      const results: DispatchResult[] = []
      let finalStatus: RunStatus = 'completed'

      try {
        for (const friend of targets) {
          signal.throwIfAborted()
          const message = renderMessage(settings.messageTemplate, friend)
          let result: DispatchResult

          if (duplicateNames.has(friend.name)) {
            result = {
              friendId: friend.id,
              friendName: friend.name,
              state: 'skipped_ambiguous_name',
              detail: '扫描结果中存在同名好友，请设置唯一备注后重新扫描',
              message,
            }
          } else if (mode === 'preview') {
            result = {
              friendId: friend.id,
              friendName: friend.name,
              state: 'preview',
              detail: '仅预览，不会打开会话或发送消息',
              message,
            }
          } else if (this.#db.hasAttemptedDispatch(friend.id, date)) {
            result = {
              friendId: friend.id,
              friendName: friend.name,
              state: 'skipped_already_verified',
              detail: '今天已有已确认或待确认的发送记录，已跳过以防重复',
              message,
            }
          } else {
            result = await this.#client.sendAndVerify({
              friend,
              message,
              verificationTimeoutMs: settings.verificationTimeoutMs,
              signal,
            })
          }

          results.push(result)
          this.#db.addDispatch(randomUUID(), runId, date, result)
        }

        const failed = results.filter((result) => result.state === 'failed').length
        const uncertain = results.filter((result) => result.state === 'delivery_unconfirmed').length
        const ambiguous = results.filter((result) => result.state === 'skipped_ambiguous_name').length
        finalStatus = failed === results.length ? 'failed' : failed + uncertain + ambiguous > 0 ? 'partial' : 'completed'
      } catch (error) {
        finalStatus = signal.aborted ? 'stopped' : 'failed'
        const summary = signal.aborted ? '任务已停止' : `任务异常：${error instanceof Error ? error.message : String(error)}`
        this.#db.finishRun(runId, finalStatus, summary)
        return this.#db.listRuns(1)[0] as RunRecord
      }

      this.#db.finishRun(runId, finalStatus, summarize(results, mode))
      return this.#db.listRuns(1)[0] as RunRecord
    })
  }

  async #exclusive<T>(operation: RunnerSnapshot['operation'], work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#controller) throw new Error('已有任务正在运行')
    this.#controller = new AbortController()
    this.#snapshot = { busy: true, operation, startedAt: new Date().toISOString() }
    try {
      return await work(this.#controller.signal)
    } finally {
      this.#controller = null
      this.#snapshot = { busy: false, operation: 'idle', startedAt: null }
    }
  }
}

function duplicateNameSet(friends: FriendRecord[]): Set<string> {
  const counts = new Map<string, number>()
  for (const friend of friends) counts.set(friend.name, (counts.get(friend.name) ?? 0) + 1)
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
}

function summarize(results: DispatchResult[], mode: RunMode): string {
  const counts = new Map<string, number>()
  for (const result of results) counts.set(result.state, (counts.get(result.state) ?? 0) + 1)
  if (mode === 'preview') return `已生成 ${results.length} 位好友的消息预览`
  const verified = (counts.get('delivery_verified') ?? 0) + (counts.get('spark_changed') ?? 0)
  const uncertain = counts.get('delivery_unconfirmed') ?? 0
  const failed = counts.get('failed') ?? 0
  const skipped =
    (counts.get('skipped_already_verified') ?? 0) + (counts.get('skipped_ambiguous_name') ?? 0)
  return `已确认 ${verified}，待确认 ${uncertain}，失败 ${failed}，跳过 ${skipped}`
}
