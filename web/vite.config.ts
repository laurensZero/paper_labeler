import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { cieDevMiddleware } from './vite-cie-plugin'

export default defineConfig({
  plugins: [vue(), cieDevMiddleware()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    strictPort: false,
  },
  preview: {
    port: 5181,
  },
  build: {
    // pdf-lib 按需分包 ~1.1MB 属预期，调高阈值避免 stderr 警告
    chunkSizeWarningLimit: 2000,
  },
})
