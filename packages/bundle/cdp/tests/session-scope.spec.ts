/**
 * plan18-session-scope: the ownership vault's law, tested against the operator
 * directive — a session drives its OWN target ids and no other, mechanically.
 */
import { describe, expect, it } from 'vitest'
import {
  CdpTargetScopeError,
  SessionTargetScope,
} from '../src/session-scope.ts'
import { OPERATOR_LAUNCH_ARGS, STEALTH_LAUNCH_ARGS, buildBrowserLaunchArgs, proxyTunnelArgs, renderLaunchFlagBlock } from '../src/launch.ts'

/** Convenience: capture the refusal code of one throwing call. */
function refusalOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof CdpTargetScopeError) return error.code
    throw error
  }
  return 'NO_REFUSAL'
}

describe('buildBrowserLaunchArgs — operatör bayrak bloğu (plan18-flags)', () => {
  it('operatör bloğu HER lansmanda çalışır', () => {
    const args = buildBrowserLaunchArgs({ userDataDir: 'C:/tmp/profil' })
    for (const flag of OPERATOR_LAUNCH_ARGS) {
      if (flag.startsWith('--disable-blink-features=')) {
        // BLOKLAR ARASI BİRLEŞİM: operatörün katkıları birleşik satırda yaşamalı.
        const line = args.find(f => f.startsWith('--disable-blink-features='))
        for (const feature of flag.slice('--disable-blink-features='.length).split(',')) {
          expect(line).toContain(feature)
        }
        continue
      }
      expect(args).toContain(flag)
    }
    expect(args).toContain('--user-data-dir=C:/tmp/profil')
    expect(args).toContain('--remote-debugging-port=0')
  })

  it('yinelenen bayraklar isme göre tekilleşir — blok asla iki katlanmaz', () => {
    const args = buildBrowserLaunchArgs({
      userDataDir: 'C:/tmp/p',
      extraArgs: ['--no-first-run', '--headless=new', '--lang=en'],
    })
    expect(args.filter(flag => flag === '--no-first-run')).toHaveLength(1)
    // ilk kazanan sırada kalır: blok --lang=tr ile gelmişti, extraArgs geçemez
    expect(args).toContain('--lang=tr')
    expect(args).not.toContain('--lang=en')
    expect(args).toContain('--headless=new')
  })

  it('renderLaunchFlagBlock modele sunulan metni üretir (prompt enjeksiyonu)', () => {
    const args = buildBrowserLaunchArgs({ userDataDir: 'C:/tmp/p' })
    const block = renderLaunchFlagBlock('C:/chrome.exe', args)
    expect(block.startsWith('LAUNCH FLAGS (prompt):')).toBe(true)
    expect(block).toContain('C:/chrome.exe')
    expect(block).toContain('  --disable-blink-features=AutomationControlled')
  })
})

describe('STEALTH_LAUNCH_ARGS — anti-tespit katmanı (plan18-stealth)', () => {
  it('stealth bloğu HER lansmanda çalışır', () => {
    const args = buildBrowserLaunchArgs({ userDataDir: 'C:/tmp/p' })
    for (const flag of STEALTH_LAUNCH_ARGS) {
      if (flag.startsWith('--disable-blink-features=')) continue
      expect(args).toContain(flag)
    }
  })

  it('blink-features BLOKLAR ARASI BİRLEŞİR — hiçbir blok diğerini yutmaz', () => {
    const args = buildBrowserLaunchArgs({ userDataDir: 'C:/tmp/p' })
    const line = args.find(flag => flag.startsWith('--disable-blink-features='))
    expect(line).toBeDefined()
    expect(line).toContain('AutomationControlled')
    expect(line).toContain('InterestCohort')
    expect(line).toContain('TopicsAPI')
    expect(args.filter(flag => flag.startsWith('--disable-blink-features='))).toHaveLength(1)
  })

  it('yasaklı bayraklar asla yerleşmez (imza listesi)', () => {
    const args = buildBrowserLaunchArgs({ userDataDir: 'C:/tmp/p', extraArgs: ['--enable-automation', '--use-gl=swiftshader', '--headless'] })
    // Bloklar temiz kalmalı…
    expect(OPERATOR_LAUNCH_ARGS).not.toContain('--enable-automation')
    expect(STEALTH_LAUNCH_ARGS.every(f => !f.includes('swiftshader') && f !== '--headless' && f !== '--incognito')).toBe(true)
    // …ve blok değerleri swiftshader'a asla geri dönmemeli (GL maskeleyicisi).
    const gl = args.find(f => f.startsWith('--use-gl='))
    expect(gl).toBe('--use-gl=desktop')
  })

  it('proxyTunnelArgs çift-dikiş ailesini kurar; sert DNS kordonu opsiyoneldir', () => {
    const soft = proxyTunnelArgs(1080)
    expect(soft).toContain('--proxy-server=socks5://127.0.0.1:1080')
    expect(soft).toContain('--proxy-bypass-list=<-loopback>')
    expect(soft.some(f => f.includes('host-resolver-rules'))).toBe(false)
    const hard = proxyTunnelArgs(9350, true)
    expect(hard.some(f => f.includes('host-resolver-rules=MAP * ~NOTFOUND'))).toBe(true)
  })
})

describe('SessionTargetScope — sahiplik', () => {
  it('grant sahiplik kurar; sahibi kullanabilir', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'tab-new', 1)
    expect(scope.owns('sess-a', 't-1')).toBe(true)
    expect(scope.ownerOf('t-1')).toBe('sess-a')
    expect(() => scope.assert('sess-a', 't-1', 'cdp_click')).not.toThrow()
  })

  it('yabancı hedef duvardır — TARGET_OWNED_ELSEWHERE', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'tab-new', 1)
    expect(refusalOf(() => scope.assert('sess-b', 't-1', 'cdp_click'))).toBe('TARGET_OWNED_ELSEWHERE')
    expect(scope.check('sess-b', 't-1').ok).toBe(false)
  })

  it('sahipsiz hedef de duvardır — TARGET_NOT_OWNED (deny-by-default)', () => {
    const scope = new SessionTargetScope()
    expect(refusalOf(() => scope.assert('sess-a', 't-ghost', 'cdp_click'))).toBe('TARGET_NOT_OWNED')
  })

  it('grant emanet ÇALMAZ — yabancı idyi sahiplenmeye kalkanı reddeder', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'open', 1)
    expect(refusalOf(() => scope.grant('sess-b', 't-1', 'tab-new', 2))).toBe('TARGET_OWNED_ELSEWHERE')
    expect(scope.ownerOf('t-1')).toBe('sess-a')
    // aynı sahibe tekrar vermek idempotent
    expect(scope.grant('sess-a', 't-1', 'open', 3).origin).toBe('open')
  })

  it('releaseTarget / releaseSession kaydı siler', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'tab-new', 1)
    scope.grant('sess-a', 't-2', 'tab-new', 2)
    scope.releaseTarget('t-1')
    expect(refusalOf(() => scope.assert('sess-a', 't-1', 'cdp_click'))).toBe('TARGET_NOT_OWNED')
    scope.releaseSession('sess-a')
    expect(refusalOf(() => scope.assert('sess-a', 't-2', 'cdp_click'))).toBe('TARGET_NOT_OWNED')
  })
})

describe('SessionTargetScope — varsayılan hedef çiti', () => {
  it('targetId yoksa kendi aktif hedefi; çifte sahiplik yok', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'tab-new', 1)
    scope.grant('sess-a', 't-2', 'tab-new', 2)
    scope.grant('sess-b', 't-foreign', 'tab-new', 3)
    expect(scope.resolveTargetId('sess-a', undefined, 'cdp_status')).toBe('t-2')
    scope.setActive('sess-a', 't-1')
    expect(scope.resolveTargetId('sess-a', undefined, 'cdp_status')).toBe('t-1')
  })

  it('açık targetId yabancıysa çözülürken PATLAR; sahipse geçer', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'tab-new', 1)
    scope.grant('sess-b', 't-2', 'tab-new', 2)
    expect(refusalOf(() => scope.resolveTargetId('sess-a', 't-2', 'cdp_click'))).toBe('TARGET_OWNED_ELSEWHERE')
    expect(scope.resolveTargetId('sess-a', 't-1', 'cdp_click')).toBe('t-1')
  })

  it('hiç hedefi olmayan sessiz varsayılan bulamaz — SCOPE_REQUIRED', () => {
    const scope = new SessionTargetScope()
    expect(refusalOf(() => scope.resolveTargetId('sess-new', undefined, 'cdp_click'))).toBe('SCOPE_REQUIRED')
  })

  it('setActive yabancı hedefi default yapamaz', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'tab-new', 1)
    scope.grant('sess-b', 't-2', 'tab-new', 2)
    expect(refusalOf(() => scope.setActive('sess-a', 't-2'))).toBe('TARGET_OWNED_ELSEWHERE')
    expect(scope.defaultTargetId('sess-a')).toBe('t-1')
  })
})

describe('SessionTargetScope — liste çiti (filterRows)', () => {
  it('yabancı satırlar hiç render edilmeden düşer', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'open', 1)
    scope.grant('sess-b', 't-2', 'open', 2)
    const rows = [
      { targetId: 't-1', url: 'a' },
      { targetId: 't-2', url: 'b' },
      { targetId: 't-ghost', url: 'c' },
    ]
    const mine = scope.filterRows('sess-a', rows, row => row.targetId)
    expect(mine).toEqual([{ targetId: 't-1', url: 'a' }])
  })
})

describe('SessionTargetScope — cdp_raw mekanik imkânsızlık duvarı', () => {
  it('hedef manipülasyon aileleri AÇIKÇA reddedilir', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'open', 1)
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Target.activateTarget', { targetId: 't-1' }, undefined))).toBe('RAW_METHOD_DENIED')
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Target.createTarget', { url: 'about:blank' }, undefined))).toBe('RAW_METHOD_DENIED')
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Target.closeTarget', { targetId: 't-1' }, undefined))).toBe('RAW_METHOD_DENIED')
  })

  it('tarayıcı-kapsamı okuma allow-list’ten geçer; diğerleri geçmez', () => {
    const scope = new SessionTargetScope()
    expect(() => scope.assertRaw('sess-a', 'Target.getTargets', {}, undefined)).not.toThrow()
    expect(refusalOf(() => scope.assertRaw('sess-a', 'SomeVendor.takeOver', {}, undefined))).toBe('RAW_METHOD_DENIED')
  })

  it('sayfa-kapsamı ham komut SAHİP hedefe gider; yabancı hedefe değil', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'open', 1)
    scope.grant('sess-b', 't-2', 'open', 2)
    expect(() => scope.assertRaw('sess-a', 'Page.navigate', { url: 'x' }, 't-1')).not.toThrow()
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Page.navigate', { url: 'x' }, 't-2'))).toBe('TARGET_OWNED_ELSEWHERE')
  })

  it('izinli okuma BİLE yabancı idyi parametresinde kaçıramaz', () => {
    const scope = new SessionTargetScope()
    scope.grant('sess-a', 't-1', 'open', 1)
    scope.grant('sess-b', 't-2', 'open', 2)
    // kendi hedefi — serbest
    expect(() => scope.assertRaw('sess-a', 'Input.dispatchMouseEvent', { type: 'mousePressed', targetId: 't-1' }, 't-1')).not.toThrow()
    // kaçak: yabancı id düz param olarak
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Input.dispatchMouseEvent', { type: 'mousePressed', destinationId: 't-2' }, 't-1'))).toBe('RAW_PARAM_DENIED')
    // kaçak: iç içe ağaçta saklanmış
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Page.captureScreenshot', { clip: { targetInfos: [{ targetId: 't-2' }] } }, 't-1'))).toBe('RAW_PARAM_DENIED')
    // hedefsiz okuma bile kaçak id taşıyamaz
    expect(refusalOf(() => scope.assertRaw('sess-a', 'Target.getTargets', { sessionId: 'sess-b-session' }, undefined))).toBe('RAW_PARAM_DENIED')
  })
})
