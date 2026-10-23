// Controller: the caller's own 2FA state — answered before the second factor, so the client
// knows whether to ask for a code or send the user to enrollment.
import { serverSupabaseServiceRole } from '#supabase/server'
import { getMfaState } from '../../repositories/mfa'
import { mfaGate, roleForced } from '../../utils/mfa'

export default defineEventHandler(async (event) => {
  const { user, aal } = await authenticate(event)
  const state = await getMfaState(serverSupabaseServiceRole(event), user.id)
  return {
    aal,
    enrolled: state.enrolled,
    forced: roleForced(state.role, state.requiredRole),
    verdict: mfaGate({ aal, ...state }),
  }
})
