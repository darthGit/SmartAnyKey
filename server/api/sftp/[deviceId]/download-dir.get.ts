// GET /api/sftp/[deviceId]/download-dir?path=… — a folder as .tar.gz.
// Archives on the remote host (tar); a target without tar → error, the panel stays alive.
import { posix } from 'node:path'
import { z } from 'zod'
import { sftpTarStream } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const path = z.string().min(1).parse(getQuery(event).path)
    const stream = await sftpTarStream(target, path)
    setHeader(event, 'Content-Type', 'application/gzip')
    setHeader(event, 'Content-Disposition', `attachment; filename="${encodeURIComponent(posix.basename(path))}.tar.gz"`)
    return sendStream(event, stream)
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
