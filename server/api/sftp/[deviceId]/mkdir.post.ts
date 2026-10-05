// POST /api/sftp/[deviceId]/mkdir — create a folder.
import { z } from 'zod'
import { sftpMkdir } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

const bodySchema = z.object({ path: z.string().min(1) })

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const { path } = await readValidatedBody(event, bodySchema.parse)
    await sftpMkdir(target, path)
    return { ok: true }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
