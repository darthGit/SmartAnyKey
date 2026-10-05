// Controller: create the first admin (ADR-021).
// Without authentication, like status.get.ts. Validation at the boundary;
// the real gate is the atomic claim in the service.
import { serverSupabaseServiceRole } from '#supabase/server'
import { SetupClosedError, createFirstAdmin, firstAdminSchema } from '../../services/setup'

export default defineEventHandler(async (event) => {
  // Open without auth while no admin exists: keyed by client IP.
  assertRate(event, `setup:${getRequestIP(event) ?? 'unknown'}`, LIMITS.authAction)
  const body = await readValidatedBody(event, firstAdminSchema.parse)
  try {
    const id = await createFirstAdmin(serverSupabaseServiceRole(event), body)
    setResponseStatus(event, 201)
    return { id }
  }
  catch (e) {
    if (e instanceof SetupClosedError) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Setup is closed: this installation already has an admin',
      })
    }
    throw e
  }
})
