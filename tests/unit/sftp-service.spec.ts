// Pins the error → HTTP classification (non-trivial branching; a wrong status
// leaks/misleads). resolveSftpTarget is glue over tested pieces, verified
// against a live device.
import { describe, expect, it } from 'vitest'
import { SftpTooLarge } from '../../server/repositories/ssh'
import { SftpNoAction, SftpNoDevice, sftpHttpError } from '../../server/services/sftp'

describe('sftpHttpError mapping', () => {
  it('passes through existing H3 errors (requireRole 401/403)', () => {
    expect(sftpHttpError({ statusCode: 403, statusMessage: 'Forbidden' }))
      .toEqual({ statusCode: 403, statusMessage: 'Forbidden' })
  })
  it('maps typed domain errors', () => {
    expect(sftpHttpError(new SftpNoDevice()).statusCode).toBe(404)
    expect(sftpHttpError(new SftpNoAction())).toEqual({ statusCode: 409, statusMessage: 'no-ssh-action' })
    expect(sftpHttpError(new SftpTooLarge())).toEqual({ statusCode: 413, statusMessage: 'file-too-large' })
  })
  it('maps ssh2 auth + sftp status codes', () => {
    expect(sftpHttpError({ level: 'client-authentication' })).toEqual({ statusCode: 502, statusMessage: 'ssh-auth' })
    expect(sftpHttpError({ code: 2 })).toEqual({ statusCode: 404, statusMessage: 'not-found' })
    expect(sftpHttpError({ code: 3 })).toEqual({ statusCode: 403, statusMessage: 'permission-denied' })
    expect(sftpHttpError({ message: 'No such file' }).statusCode).toBe(404)
    expect(sftpHttpError({ message: 'Permission denied' }).statusCode).toBe(403)
    expect(sftpHttpError({ code: 'ECONNREFUSED' })).toEqual({ statusCode: 502, statusMessage: 'host-unreachable' })
  })
  it('defaults unknown to 502', () => {
    expect(sftpHttpError(new Error('weird'))).toEqual({ statusCode: 502, statusMessage: 'sftp-error' })
  })
})
