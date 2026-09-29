import fs from 'node:fs'
const path = 'D:/Projects/paper_labeler/web/src/lib/cieDownload.ts'
let t = fs.readFileSync(path, 'utf8')
const i = t.indexOf('// ── ZIP STORE')
if (i >= 0) t = t.slice(0, i)
if (t.includes('function downloadBlob') && !/downloadBlob\(/.test(t.replace('function downloadBlob', ''))) {
  t = t.replace(/function downloadBlob[\s\S]*?\n\}\n\n?/, '')
}
t = t.trimEnd() + '\n'
fs.writeFileSync(path, t)
console.log('len', t.length)
console.log('has downloadBlob fn', t.includes('function downloadBlob'))
console.log('has buildZip', t.includes('buildZipStore'))
console.log('---tail---')
console.log(t.slice(-250))
