/**
 * Unit tests for CertificateAuthority: Root CA generation, dynamic leaf certificate
 * signing with Subject Alternative Names (SAN), caching, and cryptographic verification.
 */

import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CertificateAuthority } from '../src/net/ca.ts'

describe('CertificateAuthority', () => {
  it('generates a valid Root CA certificate', () => {
    const ca = new CertificateAuthority({ commonName: 'Test Root CA', validityDays: 365 })
    expect(ca.caCert).toContain('-----BEGIN CERTIFICATE-----')
    expect(ca.caKey).toContain('-----BEGIN PRIVATE KEY-----')

    const rootCert = new X509Certificate(ca.caCert)
    expect(rootCert.subject).toContain('CN=Test Root CA')
    expect(rootCert.issuer).toContain('CN=Test Root CA')
    expect(ca.verify(ca.caCert)).toBe(true)
  })

  it('generates valid leaf certificates with correct SubjectAltName and issuer signature', () => {
    const ca = new CertificateAuthority()
    const leaf = ca.generateLeafCert('api.github.com')

    expect(leaf.certPem).toContain('-----BEGIN CERTIFICATE-----')
    expect(leaf.keyPem).toContain('-----BEGIN PRIVATE KEY-----')

    const leafCert = new X509Certificate(leaf.certPem)
    expect(leafCert.subject).toContain('CN=api.github.com')
    expect(leafCert.issuer).toContain('CN=DeepSeek Harness Root CA')

    // Host matching
    expect(leafCert.checkHost('api.github.com')).toBe('api.github.com')
    expect(leafCert.checkHost('other.com')).toBeUndefined()

    // Verified cryptographically by root CA
    expect(ca.verify(leaf.certPem)).toBe(true)
  })

  it('caches generated leaf certificates per hostname', () => {
    const ca = new CertificateAuthority()
    const leaf1 = ca.generateLeafCert('example.com')
    const leaf2 = ca.generateLeafCert('example.com')

    expect(leaf1.certPem).toBe(leaf2.certPem)
    expect(leaf1.keyPem).toBe(leaf2.keyPem)

    const leafOther = ca.generateLeafCert('different.com')
    expect(leafOther.certPem).not.toBe(leaf1.certPem)
  })
})
