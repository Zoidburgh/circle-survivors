# Weak-Node Enemies — Implementation Plan

> **Concept:** Instead of damaging an enemy by hitting its body, you destroy **weak-nodes** that move around it. Each node has its own HP ("hit this part N times"), visibly degrades as you hit it, and **breaks** with a shatter. Break **all** nodes → the enemy dies. The body itself is **invulnerable** — the skill is *positioning your expanding ring so its circumference crosses the nodes*, which constantly move via a designer-chosen pattern.

This is a generalization of the summoner-node idea (orbit + hit), but **without the timing window** (all nodes are always hittable) and with **per-node HP + visible breaking**.

---

## Locked design decisions (v1)

1. **Body is invulnerable** — only nodes take damage. Hitting the body alone does nothing.
2. **Nodes ARE the health** — break all nodes ⇒ enemy dies. No separate body HP bar; the HP pie is replaced by the node ring.
3. **No timing window** — *all* live nodes are hittable any time the ring's circumference overlaps them (unlike summoner's one-active-per-beat node).
4. **Per-node HP** — each node tracks its own HP and degrades visibly (crack stages).
5. **Broken node = husk that STAYS in the pattern** — it keeps moving along its path but is a dead, dark, cracked, **non-hittable** husk. Live (glowing) vs dead (dark) contrast *is* the health read. On final-node break, all husks shatter together in the death animation.
6. **Elite/large-enemy tool** — gate to larger enemies for readability (designer warning, not a hard cap). Surfaced as a per-enemy-type toggle in the EnemyDesigner.

Deferred to later: two-phase "nodes gate → then hit body", node regen, husk-detach/fall-off as an alternative, multi-enemy linked nodes.

---

## Architecture — the one rule that de-risks everything

A single shared function owns a node's world position:

```ts
nodeWorldPos(enemy, i, t) → { x: number, y: number }
```

- Lives in **`src/entities/Enemy.ts`** (imported by both sim and render).
- Reads a **shared clock** via `getGameTimeMs()` (same approach the summoner nodes already use: `GameManager.ts:1592` reads `Renderer.getGameTimeMs()/2000` for the angle).
- The **movement pattern** is a `switch` inside this one function.

Because **hit detection** (sim) and **rendering** (Renderer) both call the *same* function with the *same* clock, they can never disagree about where a node is. Adding a new pattern is a few lines and touches nothing else.

---

## Data model

### Type config — `EnemyType` (`src/entities/EnemyTypes.ts`, alongside `summon?`, `volatile?`, etc.)

```ts
weakNodes?: boolean
weakNodeCount?: number        // default 3
weakNodeHp?: number           // hits to break each node, default 3
weakNodeOrbitFrac?: number    // orbit radius ÷ enemy.radius, default 1.1
weakNodeSizeFrac?: number     // node radius ÷ enemy.radius, default 0.30
weakNodePattern?: 'orbit' | 'breathe' | 'multiRadius' | 'figure8' | 'beatHop'   // default 'orbit'
weakNodeSpeed?: number        // pattern speed multiplier, default 1
weakNodeAmp?: number          // breathe / figure8 amplitude, default 0.3
```

### Runtime fields — `Enemy` (init in `createEnemy`, `src/entities/Enemy.ts:411`)

```ts
weakNodes: boolean
nodeHp: number[]        // per-node remaining HP (0 = broken husk)
nodeMaxHp: number       // for the crack-stage fraction
nodesAlive: number      // counter; reaches 0 → enemy dies
nodeFlash: number[]     // per-node hit/break FX timer (seconds)
nodeSeed: number        // random phase offset so clones desync (use index-based, NOT Math.random in render)
```

Persistence is automatic — the config lives in the enemy-type JSON (localStorage), same as every other flag.

---

## `nodeWorldPos` + movement patterns

```ts
// All positions are enemy-local offsets, then translated by (enemy.x, enemy.y).
function nodeWorldPos(enemy, i, t):
  n     = enemy.nodeHp.length
  base  = enemy.nodeSeed + (i / n) * TAU         // even spacing + per-enemy phase
  R     = enemy.radius * orbitFrac
  spd   = t * speed
  switch (pattern):
    'orbit':       a = base + spd;                 r = R
    'breathe':     a = base + spd;                 r = R * (1 + amp * sin(spd*1.7 + base))
    'multiRadius': a = base + spd*(0.6 + 0.5*(i%3));r = R * (0.55 + 0.45*((i*7)%5)/4)
    'figure8':     // local Lissajous, return early:
                   lx = sin(spd + base) * R
                   ly = sin(2*(spd + base)) * R * (0.6 + amp)
                   return { enemy.x + lx, enemy.y + ly }
    'beatHop':     // snap orientation each beat; still always hittable (movement only)
                   a = base + floor(globalBeat) * (TAU / n) * 0.5;  r = R
  return { enemy.x + cos(a)*r, enemy.y + sin(a)*r }
```

Pattern feel notes:
- **orbit** — baseline; ship first.
- **breathe** — orbit + radial in/out; the catch-radius keeps changing. Cheap, instantly better than flat spin.
- **multiRadius** — per-node radius + speed; cluster never holds a shape → constant re-read.
- **figure8** — hypnotic crossing Lissajous paths; the "cool" elite pattern.
- **beatHop** — formation snaps to a new orientation each beat (rhythm flavor, no timing window — the hop only *moves* nodes).

---

## Hit detection — 3 sources, all reuse the existing node test

The ring is centered on the player and **expands**, so it hits a node when `ringRadius ≈ distance(player → node)`. (`HitDetection.ts` already does exactly this for summoner nodes at lines ~172/204.)

1. **Ring pulse** (`src/game/HitDetection.ts:75–91`): if `enemy.weakNodes`, loop live nodes —
   ```
   for i in nodes where nodeHp[i] > 0:
     np = nodeWorldPos(enemy, i, t)
     nd = distance(np → ringOrigin/player)
     if abs(nd - ringRadius) < nodeR + grace: damageNode(enemy, i, dmg)
   continue   // skip body damage entirely
   ```
   A single pulse can break **several** nodes if its circumference crosses them — that's a positioning reward.

2. **Beat-dash AOE** (`src/core/GameManager.ts` ~1600, where it already tests summoner nodes): the AOE is a **filled disc**, so a containment test —
   ```
   if distance(node → blastCenter) <= shockRadius + nodeR: damageNode(...)
   ```

3. **Bolt / dash-shot detonation**: same disc-containment test at the projectile's blast point.

---

## Damage → break → death (`src/entities/Enemy.ts`)

```ts
function damageNode(enemy, i, amount):
  if nodeHp[i] <= 0: return            // already a husk
  nodeHp[i] -= amount
  nodeFlash[i] = 0.2                   // hit pop
  if nodeHp[i] <= 0:                   // newly broken
    nodesAlive--
    spawnNodeShatter(worldPos, ...)    // shard burst
    if nodesAlive <= 0:
      // route through the NORMAL death path so drops / score / audio fire identically
      killEnemyViaStandardPath(enemy)  // e.g. enemy.hp = 0; damageEnemy(enemy, 1) or shared death fn
```

**Never bypass the normal death path** (`damageEnemy` → `dying = true`, `spawnDrops`, `emit('enemy:killed')`, `Enemy.ts:1250–1294`). Loot/economy must behave exactly as a normal kill.

---

## Husk behavior (broken nodes)

- A broken node (`nodeHp[i] == 0`) **stays in its slot** and keeps moving via `nodeWorldPos` — the formation/silhouette stays coherent.
- It is **not hittable** (hit loop skips `nodeHp <= 0`).
- It renders as an **obviously dead husk**: desaturated, cracked-through, **no glow**, slightly smaller/slumped, maybe slow inert spin. The **live (glowing) vs husk (dark)** contrast must be strong — it doubles as the health read, so players don't waste pulses on husks.
- On the break frame: a **shatter pop** (shards), then it settles into the husk look.
- On enemy death (last live node breaks): **all husks shatter together** in the death animation.

---

## Rendering (`drawEnemy`, `src/render/Renderer.ts`)

- Draw the **body dimmed / "armored"** so it clearly reads as *not the target*.
- **Replace the HP pie** with the node ring (nodes are the health).
- Per node via `nodeWorldPos`:
  - **HP → crack stages.** `nodeHp / nodeMaxHp` drives radial crack lines that deepen each hit (so "hit 5×" = 5 visible stages), plus color shift and slight shrink.
  - **`nodeFlash` → hit pop** (bright flash on hit).
  - **Live = bright/glowing** (optional faint target ring); **husk = dark/cracked/no-glow**.
- Optional: a thin connector body→node so the cluster reads as one creature.
- Use **index-based** phase/seed (never `Math.random()` in the render loop) so nodes don't jitter frame to frame.

---

## Designer integration (`src/game/EnemyDesigner.ts`)

- A **"Weak Nodes" toggle** in the enemy-type editor, mirroring the `summon` / `volatile` toggles.
- When on, reveal inputs: **count**, **HP per node**, **orbit %**, **size %**, **pattern dropdown**, **speed**, **amplitude**.
- The designer's **live preview enemy** (`updatePreviewEnemy`) shows the nodes moving while you tune.
- A soft **readability warning** if the enemy radius is small.
- Persists with the enemy type automatically (type JSON).

---

## Test phases — each is placeable + test-playable in the designer

> Workflow per phase: open EnemyDesigner → enable Weak Nodes on a type → place it → **test-play** → verify.

### Phase 0 — Scaffold
Add config fields + runtime init (arrays sized to count). No behavior.
**Test:** place the enemy, test-play — spawns normally, zero errors, plays like a plain enemy.

### Phase 1 — Nodes exist, move, and are authorable
`nodeWorldPos` (orbit pattern) + **render the orbiting nodes** + a **minimal designer toggle** (on/off + count). Body still takes normal damage (temporary, so it stays killable).
**Test:** toggle Weak Nodes on, place it, test-play — see N nodes orbiting the body in the designer preview *and* in play.

### Phase 2 — The mechanic (the "is it fun?" gate)
Ring → node hit detection, `damageNode`, per-node HP, **body made invulnerable**, death when `nodesAlive == 0`.
**Test:** your ring breaks nodes one at a time; hitting the body alone does nothing; break all → it dies and drops loot normally.

### Phase 3 — Feedback
Crack/HP visuals per node, hit flash, break shatter FX, **husk** state (stays in pattern, dead/dark), armored body look, node-ring replaces HP pie, all-husks-shatter on death.
**Test:** you can read each node's remaining HP, breaks feel punchy, husks clearly read as dead (you never mis-target them).

### Phase 4 — Movement variety
Add `breathe`, `multiRadius`, `figure8`, `beatHop` to `nodeWorldPos` + the designer **pattern dropdown** + speed/amp inputs.
**Test:** switch patterns live in the preview; place + play each; confirm hits still land where the nodes *look* (guaranteed by the shared function).

### Phase 5 — Other hit sources
Beat-dash AOE + Bolt break nodes (disc-containment tests).
**Test:** beat-dash into the cluster pops multiple nodes; Bolt detonation breaks them.

### Phase 6 — Polish + guardrails
Full param tuning, small-enemy readability warning, disable conflicting flags (consume/heal/shield) for v1, **save → reload page → play from the challenge list** to confirm persistence.
**Test:** author a "feels right" weak-node enemy, save it, reload, play it — everything restores and plays correctly.

---

## Risks pre-empted

- **Sim/render desync** → single `nodeWorldPos` + shared `getGameTimeMs()` clock.
- **Death economy** → always route through the existing death path (`damageEnemy` / `spawnDrops` / `emit('enemy:killed')`).
- **Readability in a swarm** → elite/large-enemy tool; designer warning; strong live-vs-husk contrast.
- **`beatHop` vs "no timing"** → the hop only *moves* nodes; they stay hittable the whole time — no timing window.
- **Render jitter** → index-based phase/seed, no `Math.random()` in the draw loop.

---

## Touch list (files)

| File | Change |
|---|---|
| `src/entities/EnemyTypes.ts` | `weakNodes*` config fields on `EnemyType` |
| `src/entities/Enemy.ts` | runtime fields + `createEnemy` init; `nodeWorldPos`; `damageNode`; death routing |
| `src/game/HitDetection.ts` | ring → node hit loop (skip body) |
| `src/core/GameManager.ts` | beat-dash + bolt → node hit loops |
| `src/render/Renderer.ts` | node/husk rendering, crack stages, break FX, armored body, node-ring HP |
| `src/game/EnemyDesigner.ts` | Weak Nodes toggle + params + live preview |
