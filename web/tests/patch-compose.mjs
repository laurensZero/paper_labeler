import fs from 'node:fs'
const path = 'D:/Projects/paper_labeler/web/src/views/CompositionView.vue'
let t = fs.readFileSync(path, 'utf8')

// 1) loadCompositions: use aggregate count (faster than loading all items)
const oldLoad = `function loadCompositions() {\r
  const { data, error } = await getSupabase()\r
    .from('compositions')\r
    .select('id,name,visibility,composition_items(id,item_type)')\r
    .order('updated_at', { ascending: false })\r
  if (error) {\r
    pageError.value = error.message\r
    return\r
  }\r
  compositions.value = ((data ?? []) as unknown as {\r
    id: string\r
    name: string\r
    visibility: string\r
    composition_items: { id: number; item_type?: string }[]\r
  }[]).map((c) => ({\r
    id: c.id,\r
    name: c.name,\r
    visibility: c.visibility,\r
    // 题数只算真题，独立空白页条目不计入\r
    item_count: (c.composition_items ?? []).filter((i) => i.item_type !== 'blank_page').length,\r
  }))\r
}`

const newLoad = `async function loadCompositions() {\r
  const { data, error } = await getSupabase()\r
    .from('compositions')\r
    .select('id,name,visibility,composition_items(count)')\r
    .order('updated_at', { ascending: false })\r
  if (error) {\r
    pageError.value = error.message\r
    return\r
  }\r
  compositions.value = ((data ?? []) as unknown as {\r
    id: string\r
    name: string\r
    visibility: string\r
    composition_items: { count: number }[] | null\r
  }[]).map((c) => ({\r
    id: c.id,\r
    name: c.name,\r
    visibility: c.visibility,\r
    item_count: c.composition_items?.[0]?.count ?? 0,\r
  }))\r
}`

if (!t.includes(oldLoad)) {
  // try LF
  const oldLoadLf = oldLoad.replace(/\r\n/g, '\n')
  const newLoadLf = newLoad.replace(/\r\n/g, '\n')
  if (t.includes(oldLoadLf)) {
    t = t.split(oldLoadLf).join(newLoadLf)
  } else {
    console.error('loadCompositions block not found')
    process.exit(1)
  }
} else {
  t = t.split(oldLoad).join(newLoad)
}

// 2) unique untitled name + faster createNewDirect
const oldDirect = `function createNewDirect() {\r
  newName.value = t('compose.untitled')\r
  await createNew()\r
}`
const newDirect = `const creating = ref(false)\r
\r
/** 未命名方案 / 未命名方案 2 / … 不重名 */\r
async function nextUntitledName(): Promise<string> {\r
  const base = t('compose.untitled')\r
  const user = auth.session?.user.id\r
  if (!user) return base\r
  const { data } = await getSupabase()\r
    .from('compositions')\r
    .select('name')\r
    .eq('owner_id', user)\r
    .like('name', base + '%')\r
  const names = new Set((data ?? []).map((x: { name: string }) => x.name))\r
  if (!names.has(base)) return base\r
  for (let i = 2; i < 500; i++) {\r
    const n = base + ' ' + i\r
    if (!names.has(n)) return n\r
  }\r
  return base + ' ' + Date.now()\r
}\r
\r
/** 空态「新建方案」：不弹列表，直接建 */\r
async function createNewDirect() {\r
  if (creating.value) return\r
  creating.value = true\r
  try {\r
    newName.value = await nextUntitledName()\r
    await createNew()\r
  } finally {\r
    creating.value = false\r
  }\r
}`

if (t.includes(oldDirect)) t = t.split(oldDirect).join(newDirect)
else if (t.includes(oldDirect.replace(/\r\n/g, '\n')))
  t = t.split(oldDirect.replace(/\r\n/g, '\n')).join(newDirect.replace(/\r\n/g, '\n'))
else {
  console.error('createNewDirect block not found')
  process.exit(1)
}

// 3) delete: optimistic, don't await full reload
const oldDel = `function deleteComposition(id: string) {\r
  const c = compositions.value.find((x) => x.id === id)\r
  if (!window.confirm(t('compose.confirmDelete', { name: c?.name ?? '' }))) return\r
  const { error } = await getSupabase().from('compositions').delete().eq('id', id)\r
  if (error) {\r
    pageError.value = error.message\r
    return\r
  }\r
  await loadCompositions()\r
  if (compId.value === id) router.push({ name: 'compose-new' })\r
}`

// The function might be async - check
let oldDel2 = oldDel
if (!t.includes(oldDel)) {
  oldDel2 = oldDel.replace(/function deleteComposition/, 'async function deleteComposition').replace(/\r\n/g, '\n')
}
const newDel = `async function deleteComposition(id: string) {\r
  const c = compositions.value.find((x) => x.id === id)\r
  if (!window.confirm(t('compose.confirmDelete', { name: c?.name ?? '' }))) return\r
  const { error } = await getSupabase().from('compositions').delete().eq('id', id)\r
  if (error) {\r
    pageError.value = error.message\r
    return\r
  }\r
  // 先本地移除，列表立刻更新；后台再刷一次\r
  compositions.value = compositions.value.filter((x) => x.id !== id)\r
  if (compId.value === id) router.push({ name: 'compose-new' })\r
  void loadCompositions()\r
}`

if (t.includes(oldDel)) t = t.split(oldDel).join(newDel)
else if (t.includes(oldDel2)) t = t.split(oldDel2).join(newDel.replace(/\r\n/g, '\n'))
else if (t.includes(newDel.replace(/async function deleteComposition/, 'function deleteComposition').replace(/\r\n/g, '\n'))) {
  // already async form
  const a = `function deleteComposition(id: string) {\n  const c = compositions.value.find((x) => x.id === id)\n  if (!window.confirm(t('compose.confirmDelete', { name: c?.name ?? '' }))) return\n  const { error } = await getSupabase().from('compositions').delete().eq('id', id)\n  if (error) {\n    pageError.value = error.message\n    return\n  }\n  await loadCompositions()\n  if (compId.value === id) router.push({ name: 'compose-new' })\n}`
  if (t.includes(a)) t = t.split(a).join(newDel.replace(/\r\n/g, '\n'))
  else {
    console.error('deleteComposition block not found')
    process.exit(1)
  }
}

fs.writeFileSync(path, t)
console.log('patched ok')
