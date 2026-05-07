# Designer Scene — Comprehensive Build & Test Plan

Six independently-shippable steps. After every step you run `npm run dev`, follow the **How to test** checklist, and only then do we move on. If something feels off, we stop and fix before layering.

---

## Step 1 — Bones: designer phase + empty arena

**Goal:** prove the new scene exists. Enter it, walk around in an empty arena, exit cleanly.

**Files changed**
- `src/core/GameState.ts` — add `'designer'` to `GamePhase`. Add module vars `designerReturnPhase: GamePhase` and `designerPrevArenaShape`. Export `enterDesigner(from)`, `exitDesigner()`, `getDesignerReturnPhase()`.
- `src/core/GameManager.ts` — add a top-of-`update()` branch: `if (phase === 'designer') { updateDesigner(dt); return }`. New `updateDesigner(dt)` ticks: `tickAudioHealth`, `advanceGlobalTime`, `advancePatternClock`, `Input.flush`, camera follow, `updatePlayer` (with damage suppressed via a module-local `designerSafe` flag checked at `hurtPlayer` sites). Add a render fork: `if (phase === 'designer') { Renderer.render(player, [], [], ...); return }`.
- `src/main.ts` — temp 'D' hotkey: if not in `'playing'`/`'designer'`, call `enterDesigner(getPhase())`; if in `'designer'`, call `exitDesigner()` and `setPhase(getDesignerReturnPhase())`.

**How to test**
1. `npm run dev`, open browser.
2. From title/challenge select, press **D**. Expected: arena clears to a blank rectangle (current default shape), player visible, no enemies, no HUD clutter, no spawner running, music still grooving.
3. Move with WASD. Player slides around, camera follows. No damage taken, no XP orbs, no toasts.
4. Press **D** again. Expected: returns to wherever you came from with no errors in console.
5. **Failure flags to watch:** any of these means stop and fix — console errors, music stops, HUD elements still drawn, dash charges drain weirdly, beat preset audibly resets on enter/exit.

**Definition of done:** enter/exit works from title and challenge_select, scene is genuinely empty, no console errors.

---

## Step 2 — Arena shape swap

**Goal:** designer arena reflects the challenge you're authoring.

**Files changed**
- `src/core/GameState.ts` — `enterDesigner(from)` snapshots `getArenaShape()` into `designerPrevArenaShape`, then calls `setArenaShape(getChallengeArena())`. `exitDesigner()` restores from snapshot. Both call `clampToArena(player.x, player.y, player.hitRadius)` after the switch.
- `src/game/ChallengeBuilder.ts` — modify `setChallengeArena(shape)` to also call `setArenaShape(shape)` *if* `getPhase() === 'designer'`.

**How to test**
1. Press **D** to enter designer. Expected: arena renders in whatever shape `getChallengeArena()` returned (default `'circle'`).
2. Open the panel (it'll already be wired in step 3 — for now temporarily call `setChallengeArena('hex')` from the console: `import("./src/game/ChallengeBuilder.ts").then(m => m.setChallengeArena("hex"))`). Expected: arena outline morphs to hex live, player gets clamped inside if outside.
3. Try each shape: `'rect'`, `'circle'`, `'hex'`, `'pill'`, `'cross'`. All visually update.
4. Press **D** to exit. Expected: arena reverts to what it was before you entered.
5. **Failure flags:** player stuck outside arena, ring attack visuals leak past arena bounds, shape doesn't update live.

**Definition of done:** all 5 shapes render correctly in designer, player always stays inside, exit restores prior shape.

---

## Step 3 — Workshop panel opens with designer

**Goal:** the existing `EnemyDesigner.ts` panel becomes the entry/control surface for the scene.

**Files changed**
- `src/game/EnemyDesigner.ts` — modify `toggleDesigner()`: if opening and `getPhase() !== 'playing'`, also call `enterDesigner(getPhase())`. If closing and `getPhase() === 'designer'`, call `exitDesigner()` + `setPhase(getDesignerReturnPhase())`. (When opened mid-play, panel still acts as overlay only — no scene swap.)
- `src/main.ts` — wire the existing keyboard shortcut that opens the designer (currently 'O' / button) so it routes through the new `toggleDesigner` path. Remove the temp 'D' hotkey from step 1 once the panel-driven entry works.

**How to test**
1. From title screen, open the Workshop panel via its existing button/key. Expected: panel appears AND scene is now `'designer'` (empty arena, walk around).
2. Expand the **Enemies** section. Click an enemy in the list. Expected: `previewEnemy` animates in the panel (rings pulse, color matches). The arena stays empty.
3. Expand the **Challenges** section. Pick a challenge. Click `Place` for some enemy type. Expected: clicking on the arena drops a placement ghost (existing behavior). Ghost renders correctly in the empty scene.
4. Switch arena shape via the Challenges section dropdown. Expected: arena morphs live (step 2 wiring kicks in).
5. Close the panel. Expected: scene exits designer, returns to title.
6. **Same flow but starting from challenge_select instead of title** — should work identically and return to challenge_select on close.
7. **Failure flags:** opening panel mid-play accidentally swaps scenes, closing doesn't restore phase, preview enemy doesn't animate, place ghosts vanish.

**Definition of done:** panel is the entry/exit point, both Enemy and Challenge sections work in the empty arena, mid-play overlay behavior unchanged.

---

## Step 4 — Spawn-test ephemeral enemies

**Goal:** drop live enemies into the designer scene to feel them. Mix multiple types to see interactions.

**Files changed**
- `src/entities/Enemy.ts` — add `designerEphemeral?: boolean` field.
- `src/game/EnemyDesigner.ts` — in the enemy list rendering (~line 632 area), add `Spawn 1` / `Spawn N` buttons per row. Add a fixed top strip in the panel: a horizontal row of small `+1` chips, one per enemy type, always visible. Add a `Clear test enemies` button.
- `src/core/GameManager.ts` — `updateDesigner(dt)` now also iterates `getEnemies()` filtered by `designerEphemeral === true` and runs `updateEnemy()` + separation pass on those. Damage to player still suppressed via `designerSafe` flag. Render fork passes the ephemeral list to `Renderer.render`.
- Spawn helper: drops at cursor world position (mouse → world via `getCamera()`, mirroring `ChallengeBuilder.placeEnemy`). Marks each new `Enemy` with `designerEphemeral = true`.
- Clear: `getEnemies().splice(0, getEnemies().length, ...getEnemies().filter(e => !e.designerEphemeral))`.

**How to test**
1. Enter designer, expand **Enemies** section, select "Splitter" (or whatever type).
2. Hover the arena, click `Spawn 3` on Splitter's row. Expected: 3 Splitters appear at cursor, immediately start moving toward player. They do NOT damage you.
3. Without leaving the Splitter form, click `+1` on Tank in the always-visible top strip. Expected: 1 Tank joins the Splitters in the arena.
4. Walk around, dash through them. Ring attack damages them on pulse. They die and play their death animation. No damage to player. No XP orbs spawned (or if they do, they're inert — verify).
5. Tweak a stat on Splitter (e.g. radius), click `Clear test enemies`, click `Spawn 3` again. Expected: new Splitters reflect the new stat. Old ones gone.
6. Close panel. Expected: ephemeral enemies cleared automatically on `exitDesigner()`. Returning to designer shows empty arena.
7. **Failure flags:** player takes damage, ephemeral enemies persist after exit, XP orbs accumulate, stat tweaks don't apply to newly-spawned enemies (means we're caching the type).

**Definition of done:** mix-and-match spawning works for interaction testing, no damage leakage, clear/exit both purge ephemerals.

---

## Step 5 — Test Play round-trip

**Goal:** while authoring a challenge, hit a button to play it for real, cancel back to designer with placements intact.

**Files changed**
- `src/main.ts` — new `launchTestPlay(virtualCh: Challenge)` parallel to `launchChallenge()`. Differences: skips intro toasts, skips leaderboard, sets `let inDesignerTestPlay = true` (module-local in main or GameState).
- `src/game/EnemyDesigner.ts` — `▶ Test Play` button in the Challenges section. Click handler builds a transient `Challenge` from current `placingEnemies` + `challengeArena` + `challengeName`, calls `launchTestPlay(virtualCh)`.
- `src/core/GameManager.ts` — at every existing `setPhase('challenge_select')` exit point on death/victory (search for `completeRun`, `setPhase('entering_name')`, victory branch ~line 1762), guard with `if (inDesignerTestPlay) { inDesignerTestPlay = false; clearEphemerals(); resetGameState(); setPhase('designer'); setArenaShape(getChallengeArena()); return }`.
- Escape key handler in `main.ts` — if `inDesignerTestPlay`, route to designer return path instead of menu.
- `src/core/GameState.ts` — either fork `resetGameState(targetPhase: GamePhase = 'playing')` or have callers `setPhase('designer')` immediately after.

**How to test**
1. Enter designer, place ~5 enemies for a fresh challenge, set arena to `'hex'`, name it "TestPlay Check".
2. Click **▶ Test Play**. Expected: scene becomes real `'playing'`, the 5 enemies are live and aggressive, you take damage, ring attack works for real, music kicks in.
3. Press **Escape**. Expected: instantly back in designer scene, hex arena restored, all 5 placements still visible as ghosts in the same spots, name still "TestPlay Check". You did NOT save.
4. Move one placement, click Test Play again. Expected: the moved placement is reflected.
5. In Test Play, instead of Escape, **die**. Expected: same return path — back to designer, no death screen, no leaderboard prompt, placements intact.
6. In Test Play, **kill all enemies**. Expected: same return path — no victory fanfare/leaderboard, back to designer.
7. Close panel, reload page. Expected: "TestPlay Check" is NOT in the saved challenges list (Test Play doesn't persist).
8. Now click `Save Challenge`, then Test Play, then Escape. Reload. Expected: "TestPlay Check" IS saved and Test Play still works the same.
9. **Failure flags:** placements lost after round-trip, leaderboard appears, victory fanfare fires, music doesn't reset cleanly, ephemeral enemies from a prior designer session leak into Test Play.

**Definition of done:** round-trip is lossless for edit state, all three exit paths (Escape/death/victory) route to designer, save semantics are explicit.

---

## Step 6 — Polish

**Goal:** stop the rough edges from biting once you're using this daily.

**Files changed**
- `src/main.ts` — add `'designer'` to `window.blur` / `visibilitychange` handlers (~lines 657, 667) so designer also pauses audio when you tab away.
- `src/main.ts` — guard `Audio.switchBeat(0)` calls in `launchChallenge` so they don't fire when transitioning out of designer.
- `src/main.ts` — debug spawn keys ('v','b','9','0', enemy hotkeys ~298–392): gate with `getPhase() !== 'designer'` (or wire them to spawn ephemerals — pick one, recommend gating off to keep designer clean).
- Title screen — add "Designer" button next to "Play" / "Challenges" so you can enter from cold without going through the panel hotkey.
- `src/game/EnemyDesigner.ts` — clarify button labels in the Challenges section: `▶ Test Play` (ephemeral), `Save Challenge` (persist only), `Save & Play` (persist then launch as a real challenge that returns to challenge_select).

**How to test**
1. Enter designer, tab away to another window for 5 sec, tab back. Expected: audio paused while away, resumed cleanly. No audio glitch on resume.
2. Open Workshop from challenge_select while a beat preset is mid-playing. Close. Expected: beat preset hasn't reset.
3. In designer, mash debug spawn keys ('v', 'b', '9'). Expected: nothing happens (or they spawn ephemerals if we wired that — match your decision).
4. From title, click **Designer** button. Expected: enters designer with empty arena, panel auto-opens, returns to title on close.
5. Test all three challenge buttons:
   - `▶ Test Play` → ephemeral, returns to designer, no save.
   - `Save Challenge` → saved, no scene change.
   - `Save & Play` → saved, plays as real challenge, returns to **challenge_select** on exit.
6. **Failure flags:** audio glitches, beat preset resets unexpectedly, debug keys cause chaos in designer, label confusion between the three save/play buttons.

**Definition of done:** no rough edges noticeable in normal use, all three persistence/play modes are obvious from the labels.

---

## Working agreement

After each step:
1. Mark the task in_progress when starting, completed when done.
2. Stop and tell the user exactly what to test.
3. User runs through the **How to test** checklist in the browser.
4. Only when the user says "good" do we move to the next step.
5. If anything in the **Failure flags** fires, fix before moving on — no piling on.
