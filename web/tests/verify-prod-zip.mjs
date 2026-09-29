/**
 * Verify production ZIP: two real PDFs, central-dir offsets must be valid uint32.
 */
import assert from 'node:assert/strict'

const base = 'https://paperlabeler.de5.net'
const files = ['9709_s23_qp_11.pdf', '9709_s23_ms_11.pdf']
const url = `${base}/cie/__zip?files=${encodeURIComponent(files.join(','))}`

const res = await fetch(url)
console.log('zip status', res.status, res.headers.get('content-type'), res.headers.get('content-disposition'))
const buf = new Uint8Array(await res.arrayBuffer())
console.log('zip bytes', buf.byteLength)

assert.equal(buf[0], 0x50)
assert.equal(buf[1], 0x4b)

// find EOCD
let eocdAt = -1
for (let i = buf.length - 22; i >= 0; i--) {
  if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
    eocdAt = i
    break
  }
}
assert.ok(eocdAt > 0, 'EOCD not found')
const eocd = new DataView(buf.buffer, buf.byteOffset + eocdAt, 22)
const count = eocd.getUint16(10, true)
const cdOff = eocd.getUint32(16, true)
const cdSize = eocd.getUint32(12, true)
console.log('entries', count, 'cdOff', cdOff, 'cdSize', cdSize)

let p = cdOff
for (let i = 0; i < count; i++) {
  const cv = new DataView(buf.buffer, buf.byteOffset + p, 46)
  assert.equal(cv.getUint32(0, true), 0x02014b50, 'cd sig')
  const localOff = cv.getUint32(42, true)
  const csize = cv.getUint32(20, true)
  const nameLen = cv.getUint16(28, true)
  const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen))
  const lv = new DataView(buf.buffer, buf.byteOffset + localOff, 30)
  assert.equal(lv.getUint32(0, true), 0x04034b50, `local sig ${name}`)
  const localNameLen = lv.getUint16(26, true)
  const localName = new TextDecoder().decode(buf.subarray(localOff + 30, localOff + 30 + localNameLen))
  assert.equal(localName, name)
  // pdf magic at data
  const dataAt = localOff + 30 + localNameLen + lv.getUint16(28, true)
  const magic = String.fromCharCode(buf[dataAt], buf[dataAt + 1], buf[dataAt + 2], buf[dataAt + 3])
  console.log(' entry', name, 'localOff', localOff, 'csize', csize, 'magic', magic)
  assert.equal(magic, '%PDF', `payload ${name}`)
  p += 46 + nameLen
}

console.log('production zip OK')
