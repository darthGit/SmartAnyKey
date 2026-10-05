// The installation's public address.
//
// Why a separate script and not a value in compose: `docker-compose.yml`
// interpolates variables at parse time, before any container starts (ADR-020,
// limit measured live), so only something inside the image can compute the
// address. Hence the `:-http://localhost:8000` default was removed from compose:
// with a non-empty default this code could not tell "the client deliberately
// set localhost" from "not set", and `localhost` is fit ONLY for host-dev —
// inside a container it is the container itself, and every gated route
// returns 500.
import { networkInterfaces } from 'node:os'

/** node:os returns family as the string 'IPv4' since Node 18, the number 4 on older ones. */
function isIpv4(addr) {
  return addr.family === 'IPv4' || addr.family === 4
}

// ponytail: bridge detection is by prefix, not a list of names. Docker spawns
// `br-<hash>` for every user-defined network; they cannot be listed up front.
function isOwnBridge(name) {
  return name === 'docker0' || name.startsWith('br-') || name.startsWith('veth')
}

/**
 * @param {{envUrl?: string, nets?: object, port?: number}} opts
 * @returns {{url: string|null, source: 'env'|'autodetect', notice: string}}
 */
export function resolvePublicAddress({ envUrl = '', nets = networkInterfaces(), port = 8000 } = {}) {
  const explicit = String(envUrl ?? '').trim()
  if (explicit) {
    return {
      url: explicit,
      source: 'env',
      notice: `SAK_PUBLIC_SUPABASE_URL set explicitly: ${explicit}`,
    }
  }

  // Own bridges go last, not out: on a machine with no "normal" NIC at all it is
  // better to name something and say so than to silently fail to start.
  const candidates = []
  const fallback = []
  for (const [nic, addrs] of Object.entries(nets ?? {})) {
    for (const a of addrs ?? []) {
      if (!isIpv4(a) || a.internal)
        continue
      ;(isOwnBridge(nic) ? fallback : candidates).push({ nic, address: a.address })
    }
  }

  const pick = candidates[0] ?? fallback[0]
  if (!pick) {
    return {
      url: null,
      source: 'autodetect',
      notice: 'no non-loopback IPv4 address found — set SAK_PUBLIC_SUPABASE_URL in docker/.env manually',
    }
  }

  const url = `http://${pick.address}:${port}`
  return {
    url,
    source: 'autodetect',
    notice: `SAK_PUBLIC_SUPABASE_URL not set → picked ${pick.address} (interface ${pick.nic}) → ${url}. `
      + 'The address must be reachable from the browser and from inside the container; if wrong, set the variable in docker/.env.',
  }
}

// Run as a script: prints the URL to stdout, the explanation to stderr, so the
// entrypoint can do `SAK_URL="$(node scripts/public-address.mjs)"`.
if (process.argv[1] && process.argv[1].endsWith('public-address.mjs')) {
  const r = resolvePublicAddress({
    envUrl: process.env.SAK_PUBLIC_SUPABASE_URL,
    port: Number(process.env.SAK_PUBLIC_SUPABASE_PORT || 8000),
  })
  console.error(`[public-address] ${r.notice}`)
  if (!r.url)
    process.exit(1)
  console.log(r.url)
}
