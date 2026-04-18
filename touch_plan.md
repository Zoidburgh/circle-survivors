# Touch Controls Implementation Plan

## Goal
Make the game playable on touchscreens — browser (mobile/tablet) and eventually native app. Must not break existing keyboard/mouse controls.

## Approach
- **Pointer Events API** — unified touch/mouse/stylus, works everywhere
- **Floating virtual joystick** — appears where thumb lands (left half)
- **Dash** — double-tap left side (300ms window) + fallback button top-right
- **Auto-detect input mode** — first touch → touch mode, first keydown → keyboard mode
- **Pause button** — top-right icon (no Escape key on touch)

---

## Step 1: Prevent browser touch gestures
**Files:** `index.html`
- Add viewport meta: `user-scalable=no, maximum-scale=1`
- Add `touch-action: none` to canvas CSS
- `overflow: hidden; position: fixed` on body (iOS bounce prevention)

**Test:** Touch the canvas on Yoga — no zooming, no scrolling, no context menu. Keyboard/mouse still work. All menus still clickable with mouse.

---

## Step 2: Input mode detection
**Files:** `src/game/InputManager.ts`
- Add `inputMode` variable (`'keyboard' | 'touch'`)
- Export `getInputMode()`, `isTouchMode()`, `notifyTouchInput()`
- Existing keydown handler sets mode to `'keyboard'`

**Test:** Verify keyboard play unchanged — nothing should look or feel different.

---

## Step 3: Pointer events for UI (menus work with touch)
**Files:** `src/main.ts`
- Convert `mousedown/mouseup/mousemove` → `pointerdown/pointerup/pointermove`
- Keep `click` handler (fires from touch taps natively)
- On `pointerdown` with `pointerType === 'touch'`, call `notifyTouchInput()`

**Test:** Tap through ALL menus on touchscreen:
- Title screen: Start, Fullscreen
- Challenge select: tap a challenge card
- Pause: Resume, Restart, Menu, Fullscreen
- Death screen: Try Again, Menu
- Victory screen: Try Again, Menu
- Volume slider drag
- Mouse still works for everything

---

## Step 4: Joystick state in InputManager
**Files:** `src/game/InputManager.ts`
- Add joystick state: `origin`, `current`, `active`, `pointerId`
- Dead zone: 12px, max radius: 60px
- Export `touchJoystickStart(id, x, y)`, `touchJoystickMove(x, y)`, `touchJoystickEnd()`
- Export `getJoystickState()` for renderer
- Modify `getMovementDir()`: if joystick active AND keyboard dir is zero → return joystick direction
- Reset joystick in `clearKeys()`

**Test:** Play with keyboard — movement works exactly as before. Joystick code path only activates when touched.

---

## Step 5: Wire up touch joystick via pointer events
**Files:** `src/main.ts`
- `pointerdown` + touch + playing + left half → `setPointerCapture` + `touchJoystickStart`
- `pointermove` matching pointer ID → `touchJoystickMove`
- `pointerup/pointercancel` matching ID → `touchJoystickEnd` + `releasePointerCapture`

**Test on Yoga touchscreen:**
- Start a challenge
- Drag left half of screen — player moves in that direction
- Release — player stops
- Touch a different spot — joystick resets to new position
- Drag past edge of screen — still works (pointer capture)
- Keyboard WASD still works
- Mouse clicks on right side still work

---

## Step 6: Render the joystick overlay
**Files:** `src/render/Renderer.ts`
- New `drawTouchJoystick()` in HUD pipeline
- Only renders when `isTouchMode() && playing && joystick active`
- Outer ring: 60px radius, semi-transparent white
- Inner knob: 20px, brighter, at clamped thumb position
- 40% opacity idle → 70% while dragging

**Test:**
- Touch left side during challenge — joystick appears under thumb
- Inner knob tracks drag accurately
- Release — joystick disappears
- Keyboard play — no joystick visible
- Joystick doesn't block game view

---

## Step 7: Touch dash (double-tap + button)
**Files:** `src/game/InputManager.ts`, `src/main.ts`, `src/render/Renderer.ts`

**InputManager:**
- `triggerTouchDash()` — sets `spacePressed = true` so existing `consumeSpace()` picks it up naturally
- Reset after one tick in `flush()`

**main.ts:**
- Track `lastLeftTapTime`
- Double-tap within 300ms on left half → `triggerTouchDash()`
- Dash button region top-right (70x70px) → `triggerTouchDash()`

**Renderer:**
- Draw dash button icon (rounded rect + "DASH" label) top-right when touch mode + playing

**Test:**
- Double-tap left half quickly — player dashes ✓
- Single tap — no dash (just joystick start) ✓
- Tap dash button top-right — player dashes ✓
- Dash uses charges correctly (can't spam past 2) ✓
- Keyboard Space still triggers dash ✓
- On-beat dash still works with touch ✓

---

## Step 8: Touch pause button
**Files:** `src/render/Renderer.ts`, `src/main.ts`
- Draw pause icon (‖) top-left when touch mode + playing
- Tap region → `setPhase('paused')` + `clearKeys()`

**Test:**
- Tap pause icon — game pauses
- Tap Resume in pause menu — game resumes, touch controls work
- Keyboard Escape still pauses too

---

## Step 9: Polish — hints, transitions, edge cases
**Files:** `src/render/Renderer.ts`, `src/game/InputManager.ts`, `src/main.ts`

- Controls hint swaps to touch instructions when `isTouchMode()` (joystick graphic + "double-tap to dash")
- Joystick doesn't activate during non-playing phases (pause, dead, upgrade, shop)
- Mode switches seamlessly: touch screen → joystick appears, press key → joystick hides
- No stuck joystick on blur/pause/death
- Volume slider works with touch drag

**Test — full integration:**
1. Start with keyboard → see keyboard hints → play normally
2. Touch screen → hints swap → joystick + dash button appear
3. Press key → back to keyboard mode instantly
4. Pause/resume in both modes
5. Die → retry with touch → works
6. Win → submit name (keyboard for typing) → touch buttons work
7. Alt-tab away and back → no stuck input
8. Challenge select → scroll challenges with touch (if scrollable)

---

## Future: Native App
Once touch controls work in browser, wrapping in a native shell (Capacitor/Tauri/Electron) is straightforward since we're using standard web APIs. The touch input, Canvas2D rendering, and Web Audio all work identically in webview containers.

---

## Files Summary
| File | Changes |
|------|---------|
| `index.html` | Viewport meta, touch-action CSS |
| `src/game/InputManager.ts` | Mode detection, joystick state, touch dash |
| `src/main.ts` | Pointer events, joystick wiring, double-tap, pause button |
| `src/render/Renderer.ts` | Joystick overlay, dash button, pause icon, touch hints |
| `src/entities/Player.ts` | No changes (reads from InputManager API) |
