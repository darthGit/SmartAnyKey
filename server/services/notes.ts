// Domain service: a point's note (operator memory). Limit 2000 —
// a memory, not a document; duplicates the DB CHECK (0014) + client maxlength.
// write is injected (3-tier: the service does not hold a SupabaseClient directly — unit test
// without a live DB, like services/health).
import { z } from 'zod'

export const NOTE_MAX = 2000

export const noteSchema = z.object({ note: z.string().max(NOTE_MAX) })

export interface NoteDeps {
  write: (pointId: string, note: string) => Promise<void>
}

// Validates (limit) → writes. Over NOTE_MAX throws before write (nothing is persisted).
export async function updateNote(deps: NoteDeps, pointId: string, note: string): Promise<void> {
  noteSchema.parse({ note })
  await deps.write(pointId, note)
}
