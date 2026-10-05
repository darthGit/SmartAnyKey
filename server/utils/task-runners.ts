// Glue config → runner registry.
// The topology is install DATA (`NUXT_TASK_RUNNERS`), so all controllers and the tick
// take it from here rather than building it themselves.
import type { H3Event } from 'h3'
import type { RunnersConfig } from '../services/task-runner'
import { parseRunnerRegistry } from '../services/task-runner'

export function runnersFromConfig(event?: H3Event): RunnersConfig {
  const cfg = event ? useRuntimeConfig(event) : useRuntimeConfig()
  return {
    registry: parseRunnerRegistry(cfg.taskRunners as string),
    secret: cfg.executorSecret as string,
  }
}

export function credKey(event?: H3Event): string {
  const cfg = event ? useRuntimeConfig(event) : useRuntimeConfig()
  return cfg.credEncryptionKey as string
}
