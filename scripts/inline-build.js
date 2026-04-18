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
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="mobile-web-app-capable" content="yes" />
<title>BEATBACK</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100dvh; overflow: hidden; background: #0D0A1A; position: fixed; top: 0; left: 0; }
canvas { display: block; width: 100%; height: 100%; touch-action: none; }
</style>
</head>
<body>
<canvas id="game"></canvas>
<input id="name-input" type="text" maxlength="16" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" inputmode="text" style="position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px;">
<script>${js}</script>
</body>
</html>`

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'index.html'), output)

// Zip it
execSync(`powershell "Compress-Archive -Path '${resolve(outDir, '*')}' -DestinationPath '${resolve(root, 'BEATBACK.zip')}' -Force"`)

console.log(`✓ BEATBACK.zip ready (${(js.length / 1024).toFixed(0)}KB inlined)`)
