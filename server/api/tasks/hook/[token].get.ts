// Controller: GET on a webhook URL = **405 with an explanation**.
//
// Why this file exists: people naturally paste a webhook URL into a browser to
// "check it works". The browser sends GET, the POST-only route does not match, and
// the request falls through to the SPA fallback → the user sees the app's 404 page
// and reads it as "the webhook is broken" (exactly what happened 2026-08-13). Now they
// see the endpoint is alive and waits for POST.
//
// The token is NOT checked: the response is the same for any — otherwise GET would
// become a "does this token exist" oracle without a rate limit.
export default defineEventHandler((event) => {
  setResponseStatus(event, 405)
  setResponseHeader(event, 'allow', 'POST')
  return {
    error: 'method not allowed',
    hint: 'This endpoint accepts POST with a JSON body. Optional: `idempotency-key` header (a retry will not create a second run), `?sync=1` to wait for the result.',
    example: 'curl -X POST <this-url> -H "content-type: application/json" -H "idempotency-key: <unique-id>" -d \'{"key":"value"}\'',
  }
})
