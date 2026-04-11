# Deploying to itch.io

## Build

```
npm run build:itch
```

This runs `vite build`, inlines the JS into a single HTML file, and zips it as `bloop-bop-itch.zip` in the project root.

## Upload

1. Go to your itch.io project dashboard (Edit game)
2. Delete the old upload if present
3. Upload `bloop-bop-itch.zip`
4. Check **"This file will be played in the browser"**
5. Set embed dimensions to **960 x 540** (or enable fullscreen button)
6. Save

## Why inline?

itch.io's sandbox blocks ES module `<script type="module">` tags with a 403. The build script inlines all JS directly into `index.html` as a single `<script>` block, bypassing this restriction.

## Notes

- Enemy designs are stored in the player's browser localStorage
- Default enemies from `data/enemies.json` are bundled and load automatically on first visit
- Audio starts after the player's first click/keypress (browser autoplay policy)
- The `/api/save-enemies` endpoint only works in dev mode — on itch.io, designs persist via localStorage only
