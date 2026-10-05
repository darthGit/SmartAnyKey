// PUT /api/sftp/[deviceId]/chmod — change file/folder permissions.
// mode — perm bits 0o000..0o777. ≥operator (ADR-013).
import { z } from 'zod'
import { sftpChmod } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

const bodySchema = z.object({ path: z.string().min(1), mode: z.number().int().min(0).max(0o777) })

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const { path, mode } = await readValidatedBody(event, bodySchema.parse)
    await sftpChmod(target, path, mode)
    return { ok: true }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
