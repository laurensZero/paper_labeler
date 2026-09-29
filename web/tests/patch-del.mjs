import fs from 'node:fs'
const path = 'D:/Projects/paper_labeler/web/src/views/CompositionView.vue'
let t = fs.readFileSync(path, 'utf8')

const start = t.indexOf('async function deleteComposition')
if (start < 0) {
  console.error('fn not found')
  process.exit(1)
}
// find the first line that is exactly `}` after start (function end at column 0)
const rest = t.slice(start)
const m = rest.match(/\n\}\r?\n/)
if (!m || m.index == null) {
  console.error('end not found')
  process.exit(1)
}
const end = start + m.index + m[0].length // include trailing newline after }

const replacement = `async function deleteComposition(id: string) {
  const c = compositions.value.find((x) => x.id === id)
  if (!window.confirm(t('compose.confirmDelete', { name: c?.name ?? '' }))) return

  // 先从 UI 移除（立即反馈），网络删除后台完成
  const snapshot = compositions.value
  compositions.value = compositions.value.filter((x) => x.id !== id)
  if (compId.value === id) router.push({ name: 'compose-new' })

  const { error } = await getSupabase().from('compositions').delete().eq('id', id)
  if (error) {
    compositions.value = snapshot
    pageError.value = error.message
    return
  }
}
`

t = t.slice(0, start) + replacement + t.slice(end)
fs.writeFileSync(path, t)
console.log('replaced', start, end)
console.log(t.slice(start, start + replacement.length + 20))
