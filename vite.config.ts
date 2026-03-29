import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

export default defineConfig({
  plugins: [
    {
      name: 'save-enemies',
      configureServer(server) {
        server.middlewares.use('/api/load-enemies', (_req, res) => {
          const filePath = path.resolve('data/enemies.json')
          if (fs.existsSync(filePath)) {
            res.setHeader('Content-Type', 'application/json')
            res.end(fs.readFileSync(filePath, 'utf-8'))
          } else {
            res.statusCode = 404
            res.end('{}')
          }
        })
        server.middlewares.use('/api/save-enemies', (req, res) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('Method not allowed')
            return
          }
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            const filePath = path.resolve('data/enemies.json')
            fs.mkdirSync(path.dirname(filePath), { recursive: true })
            fs.writeFileSync(filePath, body, 'utf-8')
            res.statusCode = 200
            res.end('OK')
          })
        })
      },
    },
  ],
})
