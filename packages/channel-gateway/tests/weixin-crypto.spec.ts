import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptAesEcb, encryptAesEcb, parseAesKey } from '../src/adapters/weixin/crypto.ts'

describe('weixin media crypto', () => {
  it('round-trips bytes through encrypt then decrypt', () => {
    const keyB64 = randomBytes(16).toString('base64')
    const plain = Buffer.from('a weixin media payload of arbitrary length ✓', 'utf8')

    const decrypted = decryptAesEcb(encryptAesEcb(plain, keyB64), keyB64)

    expect(Buffer.from(decrypted).equals(plain)).toBe(true)
  })

  it('accepts a key given as base64 of a 32-char hex string', () => {
    const raw = randomBytes(16)
    const hexKeyB64 = Buffer.from(raw.toString('hex'), 'utf8').toString('base64')

    // Both encodings must resolve to the same 16 raw bytes.
    expect(parseAesKey(hexKeyB64).equals(raw)).toBe(true)
    expect(parseAesKey(raw.toString('base64')).equals(raw)).toBe(true)
  })

  it('returns data unchanged when it cannot be ECB ciphertext', () => {
    const keyB64 = randomBytes(16).toString('base64')
    const notABlock = Buffer.from([1, 2, 3])

    expect(Buffer.from(decryptAesEcb(notABlock, keyB64)).equals(notABlock)).toBe(true)
  })
})
