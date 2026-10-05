// GET /api/sftp/[deviceId]/list?path=/ — folder entries. ≥operator (ADR-013).
import { z } from 'zod'
import { sftpList } from '../../../repositories/ssh'
import { sftpHttpError } from '../../../services/sftp'

export default defineEventHandler(async (event) => {
  try {
    const { target } = await resolveSftpFromEvent(event)
    const path = z.string().min(1).default('/').parse(getQuery(event).path || '/')
    return await sftpList(target, path)
  }
  catch (e) {
    throw createError(sftpHttpError(e))
  }
})
