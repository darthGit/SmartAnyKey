// Repository: run artifacts.
// One row = one file. Bytes go to the private Storage bucket
// `task-artifacts`, metadata — to `task_artifacts`.
//
// The BFF uploads, not the runner: the runner image has zero Supabase creds
// (ADR-016), so it returns the content in the response, and it arrives here as a
// Buffer. The client downloads via a BFF route (RBAC + signed URL), the bucket is private.
import { createError } from 'h3'
import type { SupabaseClient } from '@supabase/supabase-js'

export const ARTIFACT_BUCKET = 'task-artifacts'

export interface ArtifactRow {
  id: string
  run_id: string
  path: string
  size: number
  content_type: string | null
  created_at: string
}

export interface NewArtifact {
  path: string
  size: number
  contentType?: string | null
  body: Buffer
}

const dbFail = (msg: string): never => {
  throw createError({ statusCode: 502, statusMessage: `DB: ${msg}` })
}

/** Path in the bucket: `<runId>/<relative path in $RUN_OUTPUT>`. */
const storagePath = (runId: string, rel: string) => `${runId}/${rel}`

export async function saveArtifacts(
  sr: SupabaseClient,
  runId: string,
  files: NewArtifact[],
): Promise<ArtifactRow[]> {
  const rows: ArtifactRow[] = []
  for (const file of files) {
    const path = storagePath(runId, file.path)
    const { error: upErr } = await sr.storage.from(ARTIFACT_BUCKET).upload(path, file.body, {
      contentType: file.contentType ?? 'application/octet-stream',
      upsert: true,
    })
    if (upErr)
      throw createError({ statusCode: 502, statusMessage: `Storage: ${upErr.message}` })

    const { data, error } = await sr.from('task_artifacts').upsert({
      run_id: runId,
      path,
      size: file.size,
      content_type: file.contentType ?? null,
    }, { onConflict: 'run_id,path' }).select('id,run_id,path,size,content_type,created_at').single()
    if (error) dbFail(error.message)
    rows.push(data as ArtifactRow)
  }
  return rows
}

export async function listArtifacts(sr: SupabaseClient, runId: string): Promise<ArtifactRow[]> {
  const { data, error } = await sr.from('task_artifacts')
    .select('id,run_id,path,size,content_type,created_at').eq('run_id', runId).order('path')
  if (error) dbFail(error.message)
  return (data ?? []) as ArtifactRow[]
}

/** Signed download URL (the bucket is private; only the BFF issues it, after RBAC). */
export async function signedArtifactUrl(sr: SupabaseClient, path: string, ttlS = 60): Promise<string> {
  const { data, error } = await sr.storage.from(ARTIFACT_BUCKET).createSignedUrl(path, ttlS)
  if (error || !data?.signedUrl)
    throw createError({ statusCode: 502, statusMessage: `Storage: ${error?.message ?? 'no signed url'}` })
  return data.signedUrl
}

/**
 * Retention: removes artifacts older than N days — both rows and bytes.
 * `days = 0` = remove everything (used in retention tests).
 */
export async function pruneArtifactsOlderThan(sr: SupabaseClient, days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data, error } = await sr.from('task_artifacts')
    .select('id,path').lte('created_at', cutoff)
  if (error) dbFail(error.message)

  const rows = (data ?? []) as { id: string, path: string }[]
  if (!rows.length)
    return 0

  // Bytes first, then rows: an orphaned row is worse than an orphaned file —
  // the row promises a download that will not happen.
  const { error: rmErr } = await sr.storage.from(ARTIFACT_BUCKET).remove(rows.map(r => r.path))
  if (rmErr)
    throw createError({ statusCode: 502, statusMessage: `Storage: ${rmErr.message}` })

  const { error: delErr } = await sr.from('task_artifacts').delete().in('id', rows.map(r => r.id))
  if (delErr) dbFail(delErr.message)
  return rows.length
}
