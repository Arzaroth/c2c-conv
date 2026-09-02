import { defineConfig } from 'vite'

// The client is one page. It bundles from web/ into dist/web, which is what the
// ringmaster and the bigtop serve, so the browser loads nothing from a CDN.
export default defineConfig({
  root: 'web',
  publicDir: false,
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
})
