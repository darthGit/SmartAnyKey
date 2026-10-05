// Service: backup on-ramp at the end of the first run.
//
// Why this block exists at all: the backup is built and a ready
// `Database backup` row sits there with a nightly cron, but `enabled=false` on purpose — writing to
// the client's disk without their consent is not allowed (migration 0018). The consequence this
// left: an install where the toggle was not flipped **is not backed up, and nothing says
// so**. This is the one place where the client sees it at the moment they think about the
// installation.
//
// ⚠ `BACKUP_HOST_DIR` is NOT accepted here, and that is not a simplification. It is a
// compose variable: docker reads it at container start from `docker/.env` on the host, so
// the application physically cannot change it — just like the public address. It is
// set by `install.sh`. The screen shows what came out, and how to change it.
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'

const BUILTIN = 'backup'

export interface BackupOnRamp {
  taskId: string | null
  enabled: boolean
  /** Path inside the container — fixed (`/backups`, compose). */
  dirInContainer: string
  /** How many newest dumps to keep (`BACKUP_KEEP`). */
  keep: number
  /** Next scheduled run, ISO; null — no trigger. */
  nextRunAt: string | null
}

async function findBackupTask(service: SupabaseClient) {
  const { data, error } = await service
    .from('tasks')
    .select('id, enabled')
    .eq('builtin', BUILTIN)
    .maybeSingle()
  if (error)
    throw new Error(`tasks(builtin=${BUILTIN}): ${error.message}`)
  return data as { id: string, enabled: boolean } | null
}

export async function backupOnRampState(service: SupabaseClient): Promise<BackupOnRamp> {
  const task = await findBackupTask(service)
  const base: BackupOnRamp = {
    taskId: task?.id ?? null,
    enabled: task?.enabled ?? false,
    dirInContainer: process.env.BACKUP_DIR || '/backups',
    keep: Number(process.env.BACKUP_KEEP || 30),
    nextRunAt: null,
  }
  if (!task)
    return base

  const { data } = await service
    .from('task_triggers')
    .select('next_run_at')
    .eq('task_id', task.id)
    .order('next_run_at', { ascending: true })
    .limit(1)
  base.nextRunAt = (data?.[0] as { next_run_at: string } | undefined)?.next_run_at ?? null
  return base
}

export async function enableBackup(service: SupabaseClient): Promise<BackupOnRamp> {
  const task = await findBackupTask(service)
  if (!task) {
    // The row is laid down by migration 0018. If it is missing, the install is not migrated to 0018,
    // and a silent "success" here would be a lie in the UI.
    throw createError({ statusCode: 404, statusMessage: 'Backup task is missing: this install predates migration 0018' })
  }
  const { error } = await service.from('tasks').update({ enabled: true }).eq('id', task.id)
  if (error)
    throw createError({ statusCode: 500, statusMessage: `enable backup: ${error.message}` })
  return await backupOnRampState(service)
}
