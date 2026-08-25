import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppPaths {
  dataDir: string
  databasePath: string
  browserProfileDir: string
}

export function resolveAppPaths(overrideDataDir?: string): AppPaths {
  const root =
    overrideDataDir ??
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DouyinSparkLocal')
  return {
    dataDir: root,
    databasePath: join(root, 'spark.db'),
    browserProfileDir: join(root, 'browser-profile'),
  }
}
