// POST /api/sftp/[deviceId]/rename — rename/move.
import { z } from 'zod'
import { sftpRename } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

const bodySchema = z.object({ from: z.string().min(1), to: z.string().min(1) })

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const { from, to } = await readValidatedBody(event, bodySchema.parse)
    await sftpRename(target, from, to)
    return { ok: true }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
