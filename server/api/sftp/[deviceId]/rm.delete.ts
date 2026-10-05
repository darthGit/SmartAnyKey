// DELETE /api/sftp/[deviceId]/rm — delete a file or a directory recursively.
// Confirming a non-empty directory is on the client (FileManager); the server deletes as asked.
import { z } from 'zod'
import { sftpRemove } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

const bodySchema = z.object({ path: z.string().min(1) })

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const { path } = await readValidatedBody(event, bodySchema.parse)
    await sftpRemove(target, path)
    return { ok: true }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
