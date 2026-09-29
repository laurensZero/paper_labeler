/**
 * 启动 vite 并探测 /cie 代理与 __zip（开发中间件）。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const base = 'http://127.0.0.1:5180'
const child = spawn('npm', ['run', 'dev'], {
  cwd: 'D:/Projects/paper_labeler/web',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})
child.stdout.on('data', (d) => process.stdout.write('[vite] ' + d))
child.stderr.on('data', (d) => process.stderr.write('[vite] ' + d))

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(base + '/')
      if (r.ok) return true
    } catch {}
    await sleep(250)
  }
  return false
}

function check(name, ok, extra = '') {
  console.log(ok ? 'OK ' : 'FAIL', name, extra)
  return ok
}

try {
  const up = await waitUp()
  if (!up) throw new Error('vite not up')

  // subjects
  const s = await fetch(base + '/cie/obj/Common/Subject/combo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const st = await s.text()
  check('subjects', s.ok && st.includes('9709'), `status=${s.status} len=${st.length}`)

  // pdf HEAD
  const p = await fetch(base + '/cie/obj/Common/Fetch/redir/9709_s23_qp_11.pdf', { method: 'HEAD' })
  const disp = p.headers.get('content-disposition') || ''
  const ctype = p.headers.get('content-type') || ''
  check('pdf', p.ok && ctype.includes('pdf'), `status=${p.status} ctype=${ctype} disp=${disp}`)

  // zip
  const z = await fetch(
    base + '/cie/__zip?files=' + encodeURIComponent('9709_s23_qp_11.pdf,9709_s23_ms_11.pdf'),
  )
  const zb = await z.arrayBuffer()
  const magic = new Uint8Array(zb.slice(0, 2))
  check(
    'zip',
    z.ok && magic[0] === 0x50 && magic[1] === 0x4b,
    `status=${z.status} bytes=${zb.byteLength} ctype=${z.headers.get('content-type')}`,
  )

  // HTML fallback should NOT happen for pdf
  const notSpa = p.ok && ctype.includes('pdf')
  check('not-spa', notSpa, 'PDF must not be index.html')
} finally {
  child.kill('SIGTERM')
}
