export type BrowserChannel = 'msedge' | 'chrome'

export interface AppSettings {
  browserChannel: BrowserChannel
  messageTemplate: string
  scheduleEnabled: boolean
  scheduleTime: string
  sendingEnabled: boolean
  riskAcknowledged: boolean
  maxTargetsPerRun: number
  verificationTimeoutMs: number
}

export interface FriendRecord {
  id: string
  name: string
  avatar: string
  sparkText: string
  selected: boolean
  lastSeenAt: string
}

export type BrowserState = 'closed' | 'opening' | 'login_required' | 'ready' | 'error'

export interface BrowserStatus {
  state: BrowserState
  detail: string
  lastCheckedAt: string | null
}

export type RunMode = 'preview' | 'manual' | 'scheduled'
export type RunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'stopped'

export type DispatchState =
  | 'preview'
  | 'skipped_already_verified'
  | 'skipped_ambiguous_name'
  | 'delivery_verified'
  | 'delivery_unconfirmed'
  | 'spark_changed'
  | 'failed'

export interface DispatchResult {
  friendId: string
  friendName: string
  state: DispatchState
  detail: string
  message: string
  sparkBefore?: string
  sparkAfter?: string
}

export interface RunRecord {
  id: string
  mode: RunMode
  status: RunStatus
  startedAt: string
  endedAt: string | null
  summary: string
  dispatches?: DispatchRecord[]
}

export interface DispatchRecord extends DispatchResult {
  id: string
  runId: string
  localDate: string
  createdAt: string
  updatedAt: string
}

export interface ProbeResult {
  friends: Array<Omit<FriendRecord, 'selected' | 'lastSeenAt'>>
  scannedAt: string
}

export interface SendRequest {
  friend: FriendRecord
  message: string
  verificationTimeoutMs: number
  signal: AbortSignal
}

export interface IdentityCheckRequest {
  friend: FriendRecord
  signal: AbortSignal
}

export interface IdentityCheckResult {
  friendId: string
  friendName: string
  verified: boolean
  detail: string
}

export interface DouyinClient {
  status(): Promise<BrowserStatus>
  openLogin(): Promise<BrowserStatus>
  probeFriends(signal: AbortSignal): Promise<ProbeResult>
  checkConversationIdentity(request: IdentityCheckRequest): Promise<IdentityCheckResult>
  sendAndVerify(request: SendRequest): Promise<DispatchResult>
  close(): Promise<void>
}

export const DEFAULT_SETTINGS: AppSettings = {
  browserChannel: 'msedge',
  messageTemplate: '今天也来续个火花 🔥 {{date}}',
  scheduleEnabled: false,
  scheduleTime: '20:30',
  sendingEnabled: false,
  riskAcknowledged: false,
  maxTargetsPerRun: 20,
  verificationTimeoutMs: 12_000,
}
