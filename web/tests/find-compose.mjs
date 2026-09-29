import fs from 'node:fs'
const t = fs.readFileSync('D:/Projects/paper_labeler/web/src/views/CompositionView.vue', 'utf8')
const keys = ['showListModal', 'function create', 'newComposition', 'createComposition', 'empty.new', 'compose.empty', 'async function']
for (const key of keys) {
  let i = 0
  let n = 0
  while ((i = t.indexOf(key, i)) >= 0 && n < 4) {
    console.log('---', key, 'at', i, '---')
    console.log(t.slice(Math.max(0, i - 60), i + 220))
    console.log()
    i++
    n++
  }
}
