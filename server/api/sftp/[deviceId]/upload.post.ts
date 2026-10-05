// POST /api/sftp/[deviceId]/upload?path=… — stream the request body into a remote
// file. No buffering: req → sftp write-stream.
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { sftpWriteStream } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const path = z.string().min(1).parse(getQuery(event).path)
    const w = await sftpWriteStream(target, path)
    await pipeline(event.node.req, w)
    return { ok: true }
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
