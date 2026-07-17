import { randomInt } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const rendererDevPort = randomInt(49152, 65536)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    root: resolve('src/renderer'),
    publicDir: resolve('resources'),
    server: { host: '127.0.0.1', port: rendererDevPort, strictPort: true },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
    plugins: [react()]
  }
})
