import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const backendTarget = 'http://127.0.0.1:8000'

const apiPaths = [
  '/data', '/papers', '/upload_pdf', '/upload_pdfs', '/answer_papers',
  '/questions', '/sections', '/section_defs', '/section_groups',
  '/section_stats', '/random_by_sections', '/stats', '/export', '/maintenance',
  '/admin', '/cie_import', '/health',
]

const proxy = Object.fromEntries(
  apiPaths.map((p) => [p, { target: backendTarget, changeOrigin: true }]),
)

export default defineConfig({
  plugins: [vue()],
  base: '/ui/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
