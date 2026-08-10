import crypto from "crypto"
import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { isIP } from "node:net"
import type { Logger } from "../logger"
import { isWildcardHost, normalizeNetworkHost, stripIPv6Zone } from "./network-host"

const require = createRequire(import.meta.url)

type Forge = typeof import("node-forge")

function loadForge(): Forge {
  // node-forge is CJS in many installs; require keeps this compatible with our ESM output.
  return require("node-forge") as Forge
}

export interface ResolvedHttpsOptions {
  httpsOptions: { key: string | Buffer; cert: string | Buffer; ca?: string | Buffer }
  /** Path to CA certificate suitable for NODE_EXTRA_CA_CERTS. */
  caCertPath?: string
  mode: "provided" | "generated"
}

export interface ResolveHttpsOptionsArgs {
  enabled: boolean
  configDir: string
  host: string
  tlsKeyPath?: string
  tlsCertPath?: string
  tlsCaPath?: string
  tlsSANs?: string
  logger: Logger
}

const LEAF_VALIDITY_DAYS = 30
const ROTATE_IF_EXPIRES_WITHIN_DAYS = 3

const CA_VALIDITY_DAYS = 365

export function resolveHttpsOptions(args: ResolveHttpsOptionsArgs): ResolvedHttpsOptions | null {
  if (!args.enabled) {
    return null
  }

  const hasProvided = Boolean(args.tlsKeyPath && args.tlsCertPath)
  if (hasProvided) {
    const key = fs.readFileSync(args.tlsKeyPath!, "utf-8")
    const cert = fs.readFileSync(args.tlsCertPath!, "utf-8")
    const ca = args.tlsCaPath ? fs.readFileSync(args.tlsCaPath, "utf-8") : undefined
    return {
      httpsOptions: { key, cert, ca },
      caCertPath: args.tlsCaPath,
      mode: "provided",
    }
  }

  return ensureGeneratedTls(args)
}

function ensureGeneratedTls(args: ResolveHttpsOptionsArgs): ResolvedHttpsOptions {
  const tlsDir = path.join(args.configDir, "tls")
  const caKeyPath = path.join(tlsDir, "ca-key.pem")
  const caCertPath = path.join(tlsDir, "ca-cert.pem")
  const keyPath = path.join(tlsDir, "server-key.pem")
  const certPath = path.join(tlsDir, "server-cert.pem")

  fs.mkdirSync(tlsDir, { recursive: true })

  const shouldRotateLeaf = () => {
    try {
      if (!fs.existsSync(certPath)) return true
      const pem = fs.readFileSync(certPath, "utf-8")
      const certificate = new crypto.X509Certificate(pem)
      const validToMs = Date.parse(certificate.validTo)
      if (!Number.isFinite(validToMs)) return true
      const rotateAt = validToMs - ROTATE_IF_EXPIRES_WITHIN_DAYS * 24 * 60 * 60 * 1000
      return Date.now() >= rotateAt || !certificateCoversRequiredSans(certificate, args.host, args.tlsSANs)
    } catch {
      return true
    }
  }

  const shouldRotateCa = () => {
    try {
      if (!fs.existsSync(caCertPath)) return true
      const pem = fs.readFileSync(caCertPath, "utf-8")
      const x509 = new crypto.X509Certificate(pem)
      const validToMs = Date.parse(x509.validTo)
      if (!Number.isFinite(validToMs)) return true
      // CA rotates only when expired.
      return Date.now() >= validToMs
    } catch {
      return true
    }
  }

  if (shouldRotateCa() || !fs.existsSync(caKeyPath)) {
    const { caKeyPem, caCertPem } = generateCaCertificate()
    writePemFile(caKeyPath, caKeyPem, 0o600)
    writePemFile(caCertPath, caCertPem, 0o644)
    args.logger.info({ caCertPath }, "Generated self-signed CodeNomad CA certificate")
  }

  if (shouldRotateLeaf() || !fs.existsSync(keyPath)) {
    const caKeyPem = fs.readFileSync(caKeyPath, "utf-8")
    const caCertPem = fs.readFileSync(caCertPath, "utf-8")

    const { keyPem, certPem } = generateServerCertificate({
      host: args.host,
      tlsSANs: args.tlsSANs,
      caKeyPem,
      caCertPem,
    })

    writePemFile(keyPath, keyPem, 0o600)
    writePemFile(certPath, certPem, 0o644)
    args.logger.info({ certPath }, "Generated CodeNomad HTTPS certificate")
  }

  const key = fs.readFileSync(keyPath, "utf-8")
  const cert = fs.readFileSync(certPath, "utf-8")
  const ca = fs.readFileSync(caCertPath, "utf-8")

  // Present the CA as part of the chain.
  const chainedCert = `${cert.trim()}\n${ca.trim()}\n`

  return {
    httpsOptions: {
      key,
      cert: chainedCert,
    },
    caCertPath,
    mode: "generated",
  }
}

function writePemFile(filePath: string, content: string, mode: number) {
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode })
  try {
    fs.chmodSync(filePath, mode)
  } catch {
    // best effort on platforms that ignore chmod
  }
}

function generateCaCertificate(): { caKeyPem: string; caCertPem: string } {
  const forge = loadForge()

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = crypto.randomBytes(16).toString("hex")

  const now = new Date()
  const notBefore = new Date(now.getTime() - 60_000)
  const notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter

  const attrs = [{ name: "commonName", value: "CodeNomad Local CA" }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)

  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: "subjectKeyIdentifier" },
  ])

  cert.sign(keys.privateKey, forge.md.sha256.create())

  return {
    caKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    caCertPem: forge.pki.certificateToPem(cert),
  }
}

function generateServerCertificate(args: {
  host: string
  tlsSANs?: string
  caKeyPem: string
  caCertPem: string
}): { keyPem: string; certPem: string } {
  const forge = loadForge()

  const caKey = forge.pki.privateKeyFromPem(args.caKeyPem)
  const caCert = forge.pki.certificateFromPem(args.caCertPem)

  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = crypto.randomBytes(16).toString("hex")

  const now = new Date()
  const notBefore = new Date(now.getTime() - 60_000)
  const notAfter = new Date(now.getTime() + LEAF_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter

  const commonName = pickCommonName(args.host)
  cert.setSubject([{ name: "commonName", value: commonName }])
  cert.setIssuer(caCert.subject.attributes)

  const san = buildSubjectAltNames(args.host, args.tlsSANs)

  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: san },
    { name: "subjectKeyIdentifier" },
  ])

  cert.sign(caKey, forge.md.sha256.create())

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  }
}

function pickCommonName(host: string): string {
  const normalizedHost = normalizeCertificateHost(host)
  if (!normalizedHost || isWildcardHost(normalizedHost)) {
    return "localhost"
  }
  if (normalizedHost === "127.0.0.1") {
    return "localhost"
  }
  return normalizedHost
}

function buildSubjectAltNames(host: string, tlsSANs?: string): Array<{ type: number; value?: string; ip?: string }> {
  const { dns, ips } = resolveRequiredSubjectAltNames(host, tlsSANs)
  const altNames: Array<{ type: number; value?: string; ip?: string }> = []

  // 2 = DNS, 7 = IP
  for (const name of dns) {
    altNames.push({ type: 2, value: name })
  }
  for (const ip of ips) {
    altNames.push({ type: 7, ip })
  }

  return altNames
}

function resolveRequiredSubjectAltNames(host: string, tlsSANs?: string): { dns: Set<string>; ips: Set<string> } {
  const dns = new Set<string>()
  const ips = new Set<string>()

  dns.add("localhost")
  ips.add("127.0.0.1")

  const normalizedHost = normalizeCertificateHost(host)
  if (isWildcardHost(normalizedHost) && isIP(normalizedHost) === 6) {
    ips.add("::1")
  } else if (normalizedHost) {
    if (isIP(normalizedHost)) {
      ips.add(normalizedHost)
    } else {
      dns.add(normalizedHost)
    }
  }

  for (const token of splitList(tlsSANs)) {
    const normalizedToken = normalizeCertificateHost(token)
    if (isIP(normalizedToken)) {
      ips.add(normalizedToken)
    } else if (normalizedToken) {
      dns.add(normalizedToken)
    }
  }

  return { dns, ips }
}

function normalizeCertificateHost(host: string): string {
  return normalizeNetworkHost(stripIPv6Zone(host))
}

function certificateCoversRequiredSans(certificate: crypto.X509Certificate, host: string, tlsSANs?: string): boolean {
  const { dns, ips } = resolveRequiredSubjectAltNames(host, tlsSANs)
  const existingDns = new Set(
    (certificate.subjectAltName ?? "")
      .split(/,\s*/)
      .filter((entry) => entry.startsWith("DNS:"))
      .map((entry) => entry.slice(4).toLowerCase()),
  )

  for (const name of dns) {
    if (!existingDns.has(name.toLowerCase())) return false
  }
  for (const ip of ips) {
    if (!certificate.checkIP(ip)) return false
  }
  return true
}

function splitList(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}
