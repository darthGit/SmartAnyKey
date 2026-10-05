// PUT /api/sftp/[deviceId]/write — save inline-edit text.
import { z } from 'zod'
import { sftpWriteText } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

const bodySchema = z.object({ path: z.string().min(1), content: z.string() })

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const { path, content } = await readValidatedBody(event, bodySchema.parse)
    await sftpWriteText(target, path, content)
    return { ok: true }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
