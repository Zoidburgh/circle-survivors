// Inlines the built JS into a single HTML file and zips it for itch.io
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const distDir = resolve(root, 'dist')
const outDir = resolve(root, 'dist-single')

// Find the built JS file
const html = readFileSync(resolve(distDir, 'index.html'), 'utf-8')
const jsMatch = html.match(/src="\.\/assets\/(.+?\.js)"/)
if (!jsMatch) { console.error('Could not find JS file in index.html'); process.exit(1) }

const js = readFileSync(resolve(distDir, 'assets', jsMatch[1]), 'utf-8')

const output = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>BEATBACK</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #0D0A1A; }
canvas { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<script>${js}</script>
</body>
</html>`

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'index.html'), output)

// Zip it
execSync(`powershell "Compress-Archive -Path '${resolve(outDir, '*')}' -DestinationPath '${resolve(root, 'BEATBACK.zip')}' -Force"`)

console.log(`✓ BEATBACK.zip ready (${(js.length / 1024).toFixed(0)}KB inlined)`)
