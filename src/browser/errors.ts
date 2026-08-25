import type { BrowserChannel } from '../types.js'

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

export function networkAccessIsDisabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.CODEX_SANDBOX_NETWORK_DISABLED?.trim().toLowerCase()
  return value === '1' || value === 'true'
}

export function friendlyBrowserError(error: unknown, channel: BrowserChannel): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(ANSI_PATTERN, '').split('Call log:')[0]?.trim() ?? raw

  if (/ERR_NETWORK_ACCESS_DENIED/i.test(message)) {
    return '当前启动进程没有外网访问权限。请停止这个预览实例，再从项目文件夹双击“启动控制面板.cmd”运行。'
  }
  if (/Executable doesn't exist|channel.*not found|browserType\.launchPersistentContext/i.test(message)) {
    return `未找到 ${channel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}，请安装后重试`
  }
  return message
}
