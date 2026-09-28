/**
 * Fixture-injected coverage of the single-instance guard's port-owner probe:
 * one platform table per OS is parsed exactly as the guard reads it in
 * production, and every unusable outcome (missing tool, unreadable owner, no
 * match) degrades to `unknown` without delaying an already-failed boot.
 */

import { describe, expect, it } from 'vitest'
import { probePortOwnerPid } from '../src/port-owner.ts'

/** A win32 `netstat -ano` dump: header, the target listener, decoy rows. */
const NETSTAT = [
  'Active Connections',
  '',
  'Proto Local Address Foreign Address State PID',
  'TCP 127.0.0.1:4011 0.0.0.0:0 LISTENING 4242',
  'TCP 127.0.0.1:4011 127.0.0.1:5100 ESTABLISHED 4242',
  'TCP 0.0.0.0:135 0.0.0.0:0 LISTENING 908',
  '',
].join('\r\n')

/** A Linux `ss -lptn` dump: decoy rows first, then the owned listener. */
const SS = [
  'Netid State Recv-Q Send-Q Local Address:Port Peer Address:PortProcess',
  'ESTAB 0 0 127.0.0.1:4011 127.0.0.1:6100',
  'LISTEN 0 4096 127.0.0.1:9999 0.0.0.0:*',
  'LISTEN 0 4096 127.0.0.1:4011 0.0.0.0:* users:("node",pid=777,fd=18)',
  '',
].join('\n')

describe('probePortOwnerPid', () => {
  it('reads the listening PID from the win32 netstat table', () => {
    const seen: { cmd: string; args: readonly string[] }[] = []
    const pid = probePortOwnerPid(4011, 'win32', (cmd, args) => {
      seen.push({ cmd, args })
      return NETSTAT
    })
    expect(pid).toBe('4242')
    expect(seen).toEqual([{ cmd: 'netstat', args: ['-ano'] }])
  })

  it('reports unknown when no win32 row listens on the port', () => {
    expect(probePortOwnerPid(4999, 'win32', () => NETSTAT)).toBe('unknown')
  })

  it('reads the listening PID from the ss table', () => {
    const seen: { cmd: string; args: readonly string[] }[] = []
    const pid = probePortOwnerPid(4011, 'linux', (cmd, args) => {
      seen.push({ cmd, args })
      return SS
    })
    expect(pid).toBe('777')
    expect(seen).toEqual([{ cmd: 'ss', args: ['-lptn'] }])
  })

  it('degrades to unknown when the owner is unreadable or the command is unusable', () => {
    const unreadableOwner = ['LISTEN 0 4096 127.0.0.1:4011 0.0.0.0:*', ''].join('\n')
    expect(probePortOwnerPid(4011, 'linux', () => unreadableOwner)).toBe('unknown')
    expect(probePortOwnerPid(4011, 'linux', () => null)).toBe('unknown')
    expect(probePortOwnerPid(4011, 'win32', () => null)).toBe('unknown')
  })
})
