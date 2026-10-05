// GET /api/sftp/[deviceId]/download?path=… — file stream. No buffering.
import { posix } from 'node:path'
import { z } from 'zod'
import { sftpReadStream } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const path = z.string().min(1).parse(getQuery(event).path)
    const stream = await sftpReadStream(target, path)
    setHeader(event, 'Content-Type', 'application/octet-stream')
    setHeader(event, 'Content-Disposition', `attachment; filename="${encodeURIComponent(posix.basename(path))}"`)
    return sendStream(event, stream)
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
