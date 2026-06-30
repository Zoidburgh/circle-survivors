# Fake-3D Plan

How the weak-node boss gets its 3D feel on a flat Canvas2D, and how to spread that
feel to the rest of the game. No real 3D engine — just lighting, depth ordering, and
parallax tricks layered on 2D draws.

---

## 1. How the effect works today (weak-node boss)

The boss reads as 3D from **six reusable tricks**. All of them live in `src/render/Renderer.ts`
and `src/entities/Enemy.ts`.

### A. A depth value per element (`z`, −1 back … +1 front)
`nodeLocal3D(enemy, i, t)` (Enemy.ts) is the single source of truth: it returns each node's
local `{x, y, z}`. `nodeWorldPos` projects the x/y to screen; `nodeDepth` returns the z.
The 3D patterns (tumble, tiltedOrbit, carousel, orbSphere) compute a real out-of-plane `z`;
flat patterns return `z = 0` so all the depth code below is a no-op for them.

### B. Depth → size
Front elements are drawn bigger, back smaller:
```
dr = nodeR * (0.7 + 0.3 * (z + 1))   // 0.7× at back … 1.3× at front
```

### C. Depth → shading (atmospheric)
Front brighter, back dimmer + slightly transparent (kept gentle so the back doesn't gray out):
```
depthBri = 1 + 0.15 * z              // brightness multiplier
depthA   = min(1, 1 + 0.12 * z)      // alpha multiplier
```

### D. Z-sort occlusion (painter's algorithm)
Draw **back-to-front** so near elements overlap far ones. Dead nodes are forced behind live
ones via a secondary sort key:
```
order = indices.sort((p,q) => (deadFirst) || zs[p] - zs[q])
```

### E. Lit-sphere gradient (a disc → a ball)
`drawNodeBody` builds a radial gradient whose **highlight is offset toward the light**
(top-left) and falls to a dark terminator bottom-right. That single offset is what turns a
flat circle into a sphere. Same idea gives the metal pies their look in `drawNodePie`.

### F. Specular glint + bevel + cylinder shading
- **Glint:** a small bright radial spot, offset top-left, clipped to the lit surface.
- **Bevel rim:** a bright stroke (lit from above).
- **Cylinder (struts):** the highlight stroke is **offset to one edge** of the rod → it reads
  as round instead of flat (`drawNodeStruts`).

### G. Atmospheric color haze
Back nodes sink into an **enemy-colored fog** (`drawWeakNodes` haze pass) — a soft colored
veil that grows the further back the node is. Reinforces D + C with color, not just dimming.

### H. Faux-3D motion (boss-specific, do NOT generalize)
- **Tumble:** ring rotates about the horizontal axis (`y` squashes, `z` carries depth).
- **Tilted Orbit / Carousel:** fixed tilt, spinning.
- **Orb-Sphere:** Fibonacci sphere distribution + rotation.
- **World Spin:** rigid rotation of the whole formation about the vertical axis.
These are tied to the boss's "nodes orbit a body" gameplay and shouldn't move to bullets/enemies.

### The unifying principle
Everything is lit from the **same direction (top-left)**. Cohesion — one global light across
all objects — matters more than any single effect. That's the real lever for "next level."

---

## 2. Performance guardrail (read first)

Anything high-count (bullets, orbs, particles) must use **pre-rendered tinted sprites blitted
with `drawImage`**, NEVER `createRadialGradient` per-object per-frame. The engine already does
this for glows (`getGlowSprite`) — extend that pattern: bake a **glossy-ball sprite** (white,
with offset highlight + glint) once, then `drawImage` it tinted/scaled per object. Per-frame
gradients are fine only for a handful of objects (player, a few enemies), not for swarms.

---

## 3. Current state of each system (read-only audit)

| System | Flat today? | Current technique | Good target? |
|---|---|---|---|
| Player body | No | Radial gradient + beat pulse (centered highlight) | Small upgrade (offset highlight + glint) |
| Enemy bodies | No | Radial gradient per HP wedge | Small upgrade (offset highlight + glint) |
| Bullets | **Yes** | Solid circle + additive glow | **Prime** — lit sphere + glint |
| Orbs (XP/HP) | Mostly yes | Fill + glow ring | **Prime** — lit gem + glint + bob |
| Arena grid/background | **Yes** | Flat 2D grid + vignette + ripple | **Prime** — parallax layers / curved grid |
| Walls | Stylized | Multi-pass strokes (no true bevel) | Bevel (lit top / dark bottom) |
| Attack ring | Yes | Layered strokes + bloom | Leave (hitbox read) — subtle glint only |

---

## 4. Options to improve, by system

### 4.1 Bullets — glossy lit spheres *(highest impact-per-effort)*
- Lit-sphere gradient + specular glint via a **cached glossy sprite**, tinted per bullet color.
- Optional: **squash/stretch along velocity** so fast bullets read as 3D capsules in motion.
- Effort: low–moderate (must cache sprites). Impact: very high (bullets are everywhere).

### 4.2 Orbs — lit gems
- Same cached glossy sphere + glint; add a slow **bob / spin** so pickups read as shiny 3D loot.
- Effort: low. Impact: high (juice).

### 4.3 Player & enemy bodies — offset the highlight
- They already use radial gradients but the highlight is centered. **Offset it to top-left +
  add a glint**, matching the boss's light direction → they become balls lit by the same light.
- Effort: low. Impact: medium (cohesion).

### 4.4 Arena background — parallax / depth *(the "whole world feels 3D" option)*
- Add **2–3 parallax layers** (far dust/star field, the grid, a near layer) each scrolling at a
  different rate against the existing camera lead.
- Optional: **curve the grid toward a horizon** (bowl/dome) for perspective.
- Optional: **edge depth haze** (vignette already exists — extend to a colored distance fog).
- Effort: moderate. Impact: very high (global depth behind the action).

### 4.5 Walls — bevel
- Add a **lit top edge + dark bottom edge** so walls read as raised 3D slabs, not glowing lines.
- Effort: moderate. Impact: medium.

### 4.6 Attack ring — leave it
- Do NOT tilt/perspective it; it's the hitbox telegraph. A subtle edge glint is the only safe
  change. Priority: last.

---

## 5. Recommended rollout

1. **Glossy lit spheres on bullets + orbs** (cached sprites) — fastest way to see the whole
   screen jump; self-contained; establishes the gloss + light.
2. **Offset highlight + glint on player & enemies** — ties them into the same global light in
   one pass.
3. **Parallax background (2–3 layers + optional curved grid + distance haze)** — the showpiece;
   gives the world depth behind everything.
4. **Beveled walls.**
5. **Subtle ring glint** (optional).

Steps 1–2 establish a **single global light**; step 3 adds **depth behind** it. Together that's
the boss's 3D feel spread across the whole game.

---

## 6. Reuse map (where the code already lives)

- Depth math / projection: `nodeLocal3D`, `nodeWorldPos`, `nodeDepth` — `src/entities/Enemy.ts`
- Size/shading/sort: the node loop in `drawWeakNodes` — `src/render/Renderer.ts`
- Lit-sphere + chamber: `drawNodeBody` — `src/render/Renderer.ts`
- Lit disc + glint + bevel: `drawNodePie` — `src/render/Renderer.ts`
- Cylinder/bevel strut: `drawNodeStruts` — `src/render/Renderer.ts`
- Cached sprite pattern to extend for gloss: `getGlowSprite` — `src/render/Renderer.ts`

When generalizing, extract the lit-sphere + glint into a small shared helper
(`drawLitSphere(sx, sy, r, color, depthBri, depthA)`) and a `bakeGlossSprite(color)` cache so
bullets, orbs, player, and enemies all call the same code and share one light direction.
