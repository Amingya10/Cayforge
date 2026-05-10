import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
     input: {
  main: 'homepage.html',
  studio: 'studio.html',
  tools: 'tools.html',
  demo: 'demo.html',
  contact: 'contact.html',
  terms: 'terms.html',
  privacy: 'privacy.html',
}
    }
  },
  server: {
    port: 5173
  }
})
