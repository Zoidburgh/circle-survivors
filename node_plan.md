# Plan: Shop Node + Shop Screen (Phase 1)

## Context
Building the ritual node system starting with just a shop node. Player hits 3 nodes in beat sequence to open a shop where they spend XP on upgrades. Each upgrade costs 1 XP for now. This gives us the full node→shop→purchase loop before adding spawn nodes.

## Scope — What We're Building
1. **Ritual node system** — ground nodes, beat cycling, ring collision, sequence tracking
2. **Shop node** — 3-node triangle that opens shop when completed
3. **Shop screen** — browse upgrades, spend XP to buy, exit when done
4. **NOT building yet**: spawn nodes, boss pentagons, wave system

## How Nodes Work
- 3 nodes in a triangle on the arena floor
- Each beat, one node is "active" — cycles A→B→C→A→B→C...
- Active index = `floor(getLoopPosition()) % 3`
- Player ring attack touching active node = lock it
- Can start at any node, must follow cycle after that
- Miss a beat while having progress = full reset
- Lock all 3 = shop opens

## How Shop Works (different from upgrade screen)
The existing upgrade screen is a level-up reward (free choices). The shop is a **buy screen**:
- Shows all available upgrades with XP costs
- Player clicks to purchase (spends XP)
- Can buy multiple if they have enough XP
- Click "Done" or press Escape to close
- Returns to playing phase

## New File: `src/game/RitualNodes.ts`

### Interfaces
```ts
interface RitualNode {
  x: number; y: number
  radius: number          // ~30px
  state: 'idle' | 'locked'
  lockFlash: number
}

interface RitualNodeGroup {
  id: number
  type: 'spawn' | 'shop'
  nodes: RitualNode[]
  progress: number
  startOffset: number     // which node player started at
  completed: boolean
  completionTimer: number
  spawns?: { enemyName: string; count: number }[]
}
```

### Exports
- `createNodeGroup(type, positions[])` — creates group
- `getRitualGroups()` — returns all groups
- `updateRitualNodes(dt)` — tick timers, handle completion
- `hitRitualNode(group, activeIdx)` — lock logic
- `missRitualNode(group)` — reset group
- `resetRitualNodes()` — clear all (game restart)

## New File: `src/game/ShopScreen.ts`

### Shop Screen (separate from UpgradeScreen)
- Triggered by completing a shop node group
- Shows a grid/list of ALL upgrade pool entries with costs
- Each shows: name, description, cost (1 XP), current stacks, max stacks
- Grayed out if: not enough XP, or at max stacks
- Click to buy: deducts XP, applies upgrade via `addUpgrade()` + `applyModifiers()`
- "Close Shop" button or Escape to exit
- Phase: use existing `'upgrading'` phase or add new `'shopping'` phase

### Shop Data
- Uses existing `UPGRADE_POOL` from `UpgradeDefinitions.ts`
- Each upgrade costs 1 XP (constant `SHOP_UPGRADE_COST = 1`)
- Player's XP tracked on `player.xp` (already exists)
- Buying deducts from `player.xp`

## Files to Modify

### 1. `src/utils/constants.ts`
```
RITUAL_NODE_RADIUS = 30
RITUAL_LOCK_FLASH = 0.3
RITUAL_COMPLETION_TIME = 0.5
SHOP_UPGRADE_COST = 1
```

### 2. `src/game/RitualNodes.ts` (NEW)
- All node interfaces, state, logic
- On completion: calls into ShopScreen to open shop

### 3. `src/game/ShopScreen.ts` (NEW)
- Shop UI rendering (overlay on canvas, same pattern as UpgradeScreen)
- `openShop()` — sets phase, builds item list
- `closeShop()` — returns to playing
- `updateShopScreen(dt)` — animations
- `drawShopScreen(canvas width/height)` — render items, costs, XP display
- `handleShopClick(mx, my, w, h)` — purchase logic
- `handleShopHover(mx, my, w, h)` — hover states

### 4. `src/core/GameState.ts`
- Add `'shopping'` to GamePhase type (or reuse `'upgrading'`)
- Call `resetRitualNodes()` in `resetGameState()`

### 5. `src/game/HitDetection.ts`
- In `player:beat` handler: check ritual nodes after orb collection
- Same ring collision math, reuse `sweepPositions`, `ringRadius`, `grace`

### 6. `src/core/GameManager.ts`
- Call `updateRitualNodes(dt)` in update loop
- Handle `'shopping'` phase (pause gameplay like upgrading)
- Debug key to spawn shop node group

### 7. `src/render/Renderer.ts`
- `drawRitualNodes()` — after volatile effects, before enemy rings
- Node states: idle (faint), active/flashing (bright on beat), locked (solid + particles)
- Light path: dashed line from locked node to next

### 8. `src/main.ts`
- Wire shop click/hover handlers (same as upgrade screen)
- Wire Escape key for shop close

## Visual Design
- **Shop node color**: Gold (#FFD740)
- **Idle**: faint gold ring, slow pulse
- **Active (on beat)**: bright gold flash, inner glow
- **Locked**: solid gold fill, bright border, particle burst
- **Light path**: gold dashed line with traveling dot between locked→next
- **Completion**: all flash, converge particles, shop opens

## Implementation Order

1. Constants
2. `RitualNodes.ts` — create/get/update/reset, hit/miss logic
3. `ShopScreen.ts` — open/close, draw, click handling, purchase logic
4. Wire into `GameState.ts`, `GameManager.ts`, `main.ts`
5. Hit detection in `HitDetection.ts`
6. Rendering in `Renderer.ts` — all node visual states
7. Debug key to test (e.g. 'B' spawns shop nodes)
8. Polish: particles, light paths, completion animation, sounds

## Verification
1. `npx tsc --noEmit` — clean
2. Press debug key → 3 gold nodes appear in triangle
3. Nodes flash in beat sequence
4. Ring hit on active node = locks (gold fill + particles)
5. Miss = reset (nodes go back to idle)
6. Lock all 3 = shop screen opens
7. Shop shows upgrades with costs, XP balance
8. Click to buy = XP deducted, upgrade applied
9. Close shop = back to playing
