// 渲染层唯一真源在共享包 @paper/latex-render（含 .latex-body 排版 CSS）。
// 保留本文件作为转发层，视图的 import 路径不动。
export * from '@paper/latex-render'
