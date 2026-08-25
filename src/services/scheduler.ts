import { localDate } from '../template.js'
import type { AppSettings, RunRecord } from '../types.js'

export interface SchedulerSnapshot {
  enabled: boolean
  armed: boolean
  scheduleTime: string
  lastTriggeredDate: string | null
  nextCheckAt: string | null
}

export class LocalScheduler {
  readonly #settings: () => AppSettings
  readonly #run: () => Promise<RunRecord>
  #timer: NodeJS.Timeout | null = null
  #lastTriggeredDate: string | null = null
  #nextCheckAt: string | null = null

  constructor(settings: () => AppSettings, run: () => Promise<RunRecord>) {
    this.#settings = settings
    this.#run = run
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.#tick(), 15_000)
    this.#timer.unref()
    void this.#tick()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#nextCheckAt = null
  }

  snapshot(): SchedulerSnapshot {
    const settings = this.#settings()
    return {
      enabled: settings.scheduleEnabled,
      armed: settings.scheduleEnabled && settings.sendingEnabled && settings.riskAcknowledged,
      scheduleTime: settings.scheduleTime,
      lastTriggeredDate: this.#lastTriggeredDate,
      nextCheckAt: this.#nextCheckAt,
    }
  }

  async #tick(): Promise<void> {
    this.#nextCheckAt = new Date(Date.now() + 15_000).toISOString()
    const settings = this.#settings()
    if (!settings.scheduleEnabled || !settings.sendingEnabled || !settings.riskAcknowledged) return

    const now = new Date()
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now)
    const today = localDate(now)
    if (hhmm !== settings.scheduleTime || this.#lastTriggeredDate === today) return

    this.#lastTriggeredDate = today
    await this.#run().catch(() => undefined)
  }
}
