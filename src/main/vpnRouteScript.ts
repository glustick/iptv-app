/**
 * Builds the text of the tunnel's route-up and route-pre-down scripts (index.ts's
 * writeRouteScript writes this to disk and makes it executable).
 *
 * Pulled out as a pure function for a blunt reason: these are the only lines in this app that run
 * as root. A wrong one here doesn't throw anywhere the user can see it — it silently leaves the
 * provider's traffic outside the tunnel, or drops the machine's default gateway. Tested per
 * platform rather than trusted.
 *
 * The multi-address part exists because the tunnel used to route exactly ONE address — whichever
 * one `dns.lookup` happened to return at connect time. A provider behind several A records (the
 * normal shape for a CDN-fronted panel) would then have its traffic routed through the tunnel
 * only for whichever single address came back first, with the rest quietly riding the normal
 * default route. Routing every address the host currently resolves to costs a few extra lines and
 * removes that whole class of silent bypass at connect time.
 */

/** A cap, not a real-world limit: a host resolving to more than this is not a shape this app
 * should be writing a root-run script for. */
export const MAX_TUNNELED_ADDRESSES = 8

/**
 * Keeps only IPv4 literals, in order, de-duplicated, capped. Filtering matters because these
 * values are interpolated into a root-run script: anything that isn't a plain address has no
 * business being there, whatever a resolver or a future caller hands over.
 */
export function normalizeRouteIps(ips: string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const ip of ips) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) continue
    if (seen.has(ip)) continue
    seen.add(ip)
    kept.push(ip)
    if (kept.length >= MAX_TUNNELED_ADDRESSES) break
  }
  return kept
}

export interface RouteScriptOptions {
  platform: NodeJS.Platform | string
  ips: string[]
  action: 'add' | 'delete'
  /** The machine's real default gateway, captured before connecting — only used when adding
   * routes, to undo the redirect-gateway /1 split some VPN configs install. */
  originalGateway: string | null
}

/**
 * Throws on an empty address list rather than writing a script that routes nothing: connecting
 * without routing the provider is a worse outcome than failing the connect, because it looks like
 * it worked.
 */
export function buildRouteScriptText({ platform, ips, action, originalGateway }: RouteScriptOptions): string {
  const addresses = normalizeRouteIps(ips)
  if (addresses.length === 0) throw new Error('No usable addresses to route through the tunnel')

  const isWindows = platform === 'win32'
  const isMac = platform === 'darwin'
  // OpenVPN exports route_vpn_gateway into the script's environment — quoted on POSIX so a
  // gateway string can never split into extra arguments.
  const gateway = isWindows ? '%route_vpn_gateway%' : '"$route_vpn_gateway"'

  if (action === 'delete') {
    // Only this app's own narrow route needs removing here: OpenVPN's own teardown takes back
    // whatever it installed itself (including any redirect-gateway /1 routes).
    const line = isWindows
      ? (ip: string): string => `route delete ${ip} mask 255.255.255.255 >nul 2>&1\r\n`
      : isMac
        ? (ip: string): string => `/sbin/route -n delete -host ${ip} ${gateway} 2>/dev/null\n`
        : (ip: string): string => `ip route del ${ip}/32 via ${gateway} 2>/dev/null || route delete -host ${ip} gw ${gateway} 2>/dev/null\n`
    return (isWindows ? '@echo off\r\n' : '#!/bin/sh\n') + addresses.map(line).join('')
  }

  // Adding: first undo a config-level redirect-gateway if one was captured, then add this app's
  // own host route per address. The restore is written once, before any route line.
  const restore = originalGateway
    ? isWindows
      ? 'route delete 0.0.0.0 mask 128.0.0.0 >nul 2>&1\r\nroute delete 128.0.0.0 mask 128.0.0.0 >nul 2>&1\r\n' +
        `route add 0.0.0.0 mask 0.0.0.0 ${originalGateway} metric 1 >nul 2>&1\r\n`
      : isMac
        ? `route -n delete -net 0.0.0.0/1 2>/dev/null\nroute -n delete -net 128.0.0.0/1 2>/dev/null\nroute -n add default ${originalGateway} 2>/dev/null\n`
        : `ip route del 0.0.0.0/1 2>/dev/null\nip route del 128.0.0.0/1 2>/dev/null\nip route replace default via ${originalGateway} 2>/dev/null\n`
    : ''
  const line = isWindows
    ? (ip: string): string => `route add ${ip} mask 255.255.255.255 ${gateway}\r\n`
    : isMac
      ? (ip: string): string => `/sbin/route -n add -host ${ip} ${gateway}\n`
      : (ip: string): string => `ip route add ${ip}/32 via ${gateway} 2>/dev/null || route add -host ${ip} gw ${gateway}\n`

  return (isWindows ? '@echo off\r\n' : '#!/bin/sh\n') + restore + addresses.map(line).join('')
}
