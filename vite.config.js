import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// `base: './'` keeps the build portable so it can be dropped on any static host
// (GitHub Pages, Netlify, itch.io, a USB stick...).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})
