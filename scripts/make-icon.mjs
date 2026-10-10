// Generates build/icon.png (512x512 RGBA): a rounded violet gradient tile with
// a dark play triangle, matching the in-app brand mark (.brand-mark in
// styles.css). Uses only Node built-ins — the PNG is written by hand (zlib
// deflate + CRC32), no image libraries.
// Run: node scripts/make-icon.mjs
/* global Buffer, console */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const SUBSAMPLES = 3 // per axis, for anti-aliased edges

const here = dirname(fileURLToPath(import.meta.url))
const outputPath = join(here, '..', 'build', 'icon.png')

// --- PNG encoding (truecolor RGBA, 8-bit, one IDAT, filter 0) ---------------
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

// --- shapes (unit coordinates, origin top-left) ------------------------------
const HALF = 0.485 // rounded tile half-size
const RADIUS = 0.2 // tile corner radius
// Play triangle, nudged right for optical centering.
const TRIANGLE = [
  [0.38, 0.295],
  [0.38, 0.705],
  [0.755, 0.5],
]
const GRADIENT_FROM = [0xb7, 0xa3, 0xff] // #b7a3ff, matches the brand mark
const GRADIENT_TO = [0x6c, 0x4b, 0xff]
const GLYPH = [0x15, 0x12, 0x1d] // #15121d

function tileSDF(x, y) {
  const qx = Math.abs(x - 0.5) - (HALF - RADIUS)
  const qy = Math.abs(y - 0.5) - (HALF - RADIUS)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - RADIUS
}

function inTriangle(x, y) {
  const signs = []
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = TRIANGLE[i]
    const [bx, by] = TRIANGLE[(i + 1) % 3]
    signs.push((bx - ax) * (y - ay) - (by - ay) * (x - ax))
  }
  const hasNegative = signs.some(s => s < 0)
  const hasPositive = signs.some(s => s > 0)
  return !(hasNegative && hasPositive)
}

function gradient(x, y) {
  const t = Math.min(1, Math.max(0, (x + y) / 2))
  return [
    Math.round(GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t),
    Math.round(GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t),
    Math.round(GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t),
  ]
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let row = 0; row < SIZE; row++) {
  const lineStart = row * (SIZE * 4 + 1)
  raw[lineStart] = 0 // filter type: none
  for (let column = 0; column < SIZE; column++) {
    let red = 0
    let green = 0
    let blue = 0
    let alpha = 0
    const baseX = (column + 0.5) / SIZE
    const baseY = (row + 0.5) / SIZE
    const step = 1 / (SIZE * SUBSAMPLES)
    for (let sy = 0; sy < SUBSAMPLES; sy++) {
      for (let sx = 0; sx < SUBSAMPLES; sx++) {
        const x = baseX + (sx - (SUBSAMPLES - 1) / 2) * step
        const y = baseY + (sy - (SUBSAMPLES - 1) / 2) * step
        if (tileSDF(x, y) > 0) continue
        const color = inTriangle(x, y) ? GLYPH : gradient(baseX, baseY)
        red += color[0]
        green += color[1]
        blue += color[2]
        alpha += 255
      }
    }
    const samples = SUBSAMPLES * SUBSAMPLES
    const offset = lineStart + 1 + column * 4
    raw[offset] = Math.round(red / samples)
    raw[offset + 1] = Math.round(green / samples)
    raw[offset + 2] = Math.round(blue / samples)
    raw[offset + 3] = Math.round(alpha / samples)
  }
}

const header = Buffer.alloc(13)
header.writeUInt32BE(SIZE, 0)
header.writeUInt32BE(SIZE, 4)
header[8] = 8 // bit depth
header[9] = 6 // color type: RGBA
// compression, filter and interlace stay 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, png)
console.log(`Wrote ${outputPath} (${png.length} bytes)`)
