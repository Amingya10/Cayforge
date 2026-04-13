import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        tools: 'tools.html',
        demo: 'demo.html'
      }
    }
  },
  server: {
    port: 5173
  }
})
input: {
  main: 'index.html',
  tools: 'tools.html',
  demo: 'demo.html',
  contact: 'contact.html'
}
