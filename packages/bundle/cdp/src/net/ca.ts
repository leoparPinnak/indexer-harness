/**
 * @deepseek-ai/dsh-cdp/net/ca — Local Certificate Authority.
 * Generates an in-memory Root CA and on-demand X.509 v3 leaf certificates
 * with Subject Alternative Names (SAN) for HTTPS proxy interception.
 * Scoped strictly to the browser session with zero external dependencies.
 *
 * @module @deepseek-ai/dsh-cdp/net/ca
 */

import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'

/**
 * Options for configuring the {@link CertificateAuthority}.
 */
export interface CaOptions {
  /** Common Name for the generated Root Certificate Authority. */
  readonly commonName?: string | undefined
  /** Validity period in days for the Root CA; defaults to 3650 (10 years). */
  readonly validityDays?: number | undefined
}

/**
 * Generated or cached leaf certificate credentials.
 */
export interface LeafCertificate {
  /** PEM-formatted X.509 certificate. */
  readonly certPem: string
  /** PEM-formatted private key. */
  readonly keyPem: string
}

function derLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len])
  const bytes: number[] = []
  let temp = len
  while (temp > 0) {
    bytes.unshift(temp & 0xff)
    temp >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derSequence(items: readonly Buffer[]): Buffer {
  const body = Buffer.concat(items)
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body])
}

function derInteger(bufOrNum: Buffer | number): Buffer {
  if (typeof bufOrNum === 'number') {
    return Buffer.from([0x02, 0x01, bufOrNum])
  }
  let start = 0
  while (start < bufOrNum.length - 1 && bufOrNum[start] === 0) start += 1
  let slice = bufOrNum.subarray(start)
  if ((slice[0] ?? 0) & 0x80) slice = Buffer.concat([Buffer.from([0x00]), slice])
  return Buffer.concat([Buffer.from([0x02]), derLength(slice.length), slice])
}

function derBitString(buf: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x03]), derLength(buf.length + 1), Buffer.from([0x00]), buf])
}

function derOctetString(buf: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x04]), derLength(buf.length), buf])
}

function derOid(bytes: readonly number[]): Buffer {
  return Buffer.concat([Buffer.from([0x06]), derLength(bytes.length), Buffer.from(bytes)])
}

const ECDSA_WITH_SHA256 = derOid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])
const SIG_ALG = derSequence([ECDSA_WITH_SHA256])
const CN_OID = derOid([0x55, 0x04, 0x03])

function derName(cn: string): Buffer {
  const cnBytes = Buffer.from(cn, 'utf8')
  const cnVal = Buffer.concat([Buffer.from([0x0c, cnBytes.length]), cnBytes])
  const atv = derSequence([CN_OID, cnVal])
  const rdn = Buffer.concat([Buffer.from([0x31]), derLength(atv.length), atv])
  return derSequence([rdn])
}

function formatUTCTime(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'
  return Buffer.concat([Buffer.from([0x17, s.length]), Buffer.from(s, 'ascii')])
}

function derToPem(der: Buffer, label: string): string {
  const base64 = der.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64))
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/**
 * Local Certificate Authority for browser-scoped HTTPS proxy inspection.
 */
export class CertificateAuthority {
  private readonly caName: Buffer
  private readonly caPrivateKey: KeyObject
  private readonly caPublicKey: KeyObject
  private readonly rootCertDer: Buffer
  private readonly rootCertPem: string
  private readonly rootKeyPem: string
  private readonly cache = new Map<string, LeafCertificate>()

  /**
   * Initialize a new Root Certificate Authority.
   * @param options - CA configuration options.
   */
  constructor(options: CaOptions = {}) {
    const commonName = options.commonName ?? 'DeepSeek Harness Root CA'
    const validityDays = options.validityDays ?? 3650

    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.caPrivateKey = keys.privateKey
    this.caPublicKey = keys.publicKey
    this.caName = derName(commonName)

    // BasicConstraints extension (2.5.29.19) -> cA=TRUE
    const extBasicConstraintsCA = derSequence([
      derOid([0x55, 0x1d, 0x13]),
      Buffer.from([0x01, 0x01, 0xff]), // critical TRUE
      derOctetString(derSequence([Buffer.from([0x01, 0x01, 0xff])])), // cA=TRUE
    ])
    const rootExtensions = Buffer.concat([
      Buffer.from([0xa3]),
      derLength(derSequence([extBasicConstraintsCA]).length),
      derSequence([extBasicConstraintsCA]),
    ])

    const now = Date.now()
    const notBefore = new Date(now - 86_400_000)
    const notAfter = new Date(now + validityDays * 86_400_000)

    const rootTbs = derSequence([
      Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]), // v3
      derInteger(1),
      SIG_ALG,
      this.caName,
      derSequence([formatUTCTime(notBefore), formatUTCTime(notAfter)]),
      this.caName,
      Buffer.from(this.caPublicKey.export({ type: 'spki', format: 'der' })),
      rootExtensions,
    ])

    const sign = createSign('SHA256')
    sign.update(rootTbs)
    const signature = sign.sign(this.caPrivateKey)

    this.rootCertDer = derSequence([rootTbs, SIG_ALG, derBitString(signature)])
    this.rootCertPem = derToPem(this.rootCertDer, 'CERTIFICATE')
    this.rootKeyPem = this.caPrivateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  }

  /** The PEM-encoded Root CA Certificate. */
  get caCert(): string {
    return this.rootCertPem
  }

  /** The PEM-encoded Root CA Private Key. */
  get caKey(): string {
    return this.rootKeyPem
  }

  /** The DER-encoded Root CA Certificate buffer. */
  get caDer(): Buffer {
    return this.rootCertDer
  }

  /**
   * Generate or retrieve a cached leaf certificate for the specified hostname.
   * @param hostname - domain name or IP address (e.g. 'github.com' or '127.0.0.1').
   * @returns leaf certificate and private key in PEM format.
   */
  generateLeafCert(hostname: string): LeafCertificate {
    const cached = this.cache.get(hostname)
    if (cached !== undefined) return cached

    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const leafName = derName(hostname)

    // SubjectAltName extension (2.5.29.17)
    // Tag [2] for dNSName
    const hostnameBytes = Buffer.from(hostname, 'ascii')
    const sanDns = Buffer.concat([Buffer.from([0x82, hostnameBytes.length]), hostnameBytes])
    const sanExt = derSequence([
      derOid([0x55, 0x1d, 0x11]),
      derOctetString(derSequence([sanDns])),
    ])
    const leafExtensions = Buffer.concat([
      Buffer.from([0xa3]),
      derLength(derSequence([sanExt]).length),
      derSequence([sanExt]),
    ])

    const now = Date.now()
    const notBefore = new Date(now - 86_400_000)
    const notAfter = new Date(now + 365 * 86_400_000) // 1 year validity

    const leafTbs = derSequence([
      Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]), // v3
      derInteger(randomBytes(12)),
      SIG_ALG,
      this.caName, // Issuer is Root CA
      derSequence([formatUTCTime(notBefore), formatUTCTime(notAfter)]),
      leafName,
      Buffer.from(keys.publicKey.export({ type: 'spki', format: 'der' })),
      leafExtensions,
    ])

    const sign = createSign('SHA256')
    sign.update(leafTbs)
    const signature = sign.sign(this.caPrivateKey)

    const leafCertDer = derSequence([leafTbs, SIG_ALG, derBitString(signature)])
    const certPem = derToPem(leafCertDer, 'CERTIFICATE')
    const keyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

    const credential: LeafCertificate = { certPem, keyPem }
    this.cache.set(hostname, credential)
    return credential
  }

  /**
   * Verify an X.509 certificate against this Root CA.
   * @param certPem - PEM-encoded certificate to verify.
   * @returns true if signed by this CA.
   */
  verify(certPem: string): boolean {
    try {
      const cert = new X509Certificate(certPem)
      return cert.verify(this.caPublicKey)
    } catch {
      return false
    }
  }
}
