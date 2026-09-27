/**
 * AES-128-ECB, the cipher iLink uses for media on its CDN: a download is
 * encrypted bytes this decrypts, an upload is bytes this encrypts. ECB with
 * PKCS7 padding matches the reference iLink client; the gateway only moves the
 * bytes, it does not choose the scheme.
 * @module @wowyuarm/dsh-channel-gateway/weixin/crypto
 */

import { createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * Recover the 16-byte key from the two encodings iLink hands out: base64 of the
 * raw 16 bytes (images), or base64 of a 32-char hex string (voice, file,
 * video). Anything else is not a key this cipher can use.
 */
export function parseAesKey(keyB64: string): Buffer {
  const decoded = Buffer.from(keyB64, 'base64')
  if (decoded.length === 16) return decoded
  const ascii = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex')
  throw new Error(`aes key must decode to 16 raw bytes or a 32-char hex string, got ${String(decoded.length)} bytes`)
}

/**
 * Decrypt CDN media. Data that is not a whole number of blocks cannot be ECB
 * ciphertext, so it is returned untouched; otherwise the PKCS7 padding is
 * removed only when it is valid, matching the reference client's tolerance for
 * media that was stored without it.
 */
export function decryptAesEcb(data: Buffer, keyB64: string): Buffer {
  if (data.length === 0 || data.length % 16 !== 0) return data
  const decipher = createDecipheriv('aes-128-ecb', parseAesKey(keyB64), null)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return pkcs7UnpadSafe(decrypted)
}

/** Encrypt bytes for CDN upload; Node applies PKCS7 padding to the block size. */
export function encryptAesEcb(data: Buffer, keyB64: string): Buffer {
  const cipher = createCipheriv('aes-128-ecb', parseAesKey(keyB64), null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function pkcs7UnpadSafe(data: Buffer): Buffer {
  if (data.length === 0 || data.length % 16 !== 0) return data
  const padLen = data[data.length - 1] ?? 0
  if (padLen < 1 || padLen > 16) return data
  const padding = data.subarray(data.length - padLen)
  if (!padding.every(byte => byte === padLen)) return data
  return data.subarray(0, data.length - padLen)
}
