// GET /api/sftp/[deviceId]/read?path=… — file text for inline edit.
// Size cap (1 MiB) in repo/service → 413 file-too-large.
import { z } from 'zod'
import { sftpReadText } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const path = z.string().min(1).parse(getQuery(event).path)
    return { content: await sftpReadText(target, path) }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
