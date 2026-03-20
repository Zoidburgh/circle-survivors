# Circle Survivors — Music System Design

## Core Concept

The battlefield IS the music. Every enemy is an instrument. Every wave is a song. Killing enemies removes notes. Spawning adds them. The player's pulse is the kick drum that holds it all together.

---

## 1. Musical Foundation

### 1.1 Scales

Pentatonic scales only — 5 notes, impossible to sound bad. Any random combination is musical.

**Minor pentatonic** (default, dark/intense):
```
C3:  C  Eb  F  G  Bb
C4:  C  Eb  F  G  Bb  (octave up)
```

**Major pentatonic** (bright, used for easy/reward waves):
```
C3:  C  D  E  G  A
C4:  C  D  E  G  A
```

Each wave picks a root note (C, D, E, F, G, A, B) and a mood (minor/major). This gives 14 possible vibes before considering octave variations.

### 1.2 Note Frequency Table (A4 = 440hz)

```
C3:  130.81    D3:  146.83    Eb3: 155.56    E3:  164.81
F3:  174.61    G3:  196.00    Ab3: 207.65    A3:  220.00
Bb3: 233.08    B3:  246.94

C4:  261.63    D4:  293.66    Eb4: 311.13    E4:  329.63
F4:  349.23    G4:  392.00    Ab4: 415.30    A4:  440.00
Bb4: 466.16    B4:  493.88

C5:  523.25    D5:  587.33    E5:  659.26    G5:  783.99
```

### 1.3 BPM Progression

BPM increases with waves. Music gets faster = game gets harder = intensity rises.

| Wave | BPM | Feel |
|---|---|---|
| 1-3 | 30 | Chill, learning |
| 4-6 | 35 | Warming up |
| 7-9 | 40 | Getting busy |
| 10-12 | 45 | Intense |
| 13-15 | 50 | Frantic |
| 16+ | 55 | Maximum |

---

## 2. Enemy → Instrument Mapping

### 2.1 Player Pulse: Kick Drum

The constant heartbeat. Always present.

```
Sound:   Low sine (60hz) + transient click (square 200hz, 10ms)
Pattern: Every beat (quarter note)
Role:    Rhythmic anchor — everything else is relative to this
```

### 2.2 Whole Note Enemy: Bass

Deep, sustained. Holds down the low end.

```
Sound:   Triangle wave, root note of scale (C3 range)
ADSR:    Attack 10ms, Decay 200ms, Sustain 0.6, Release 400ms
Pattern: Every 4 beats
Note:    Always the root — C in C minor, etc.
Role:    Harmonic foundation
```

### 2.3 Half Note Enemy: Chord Stab

Mid-range punch. Defines the harmony.

```
Sound:   2 detuned saws, filtered. Plays a dyad (two notes from scale)
ADSR:    Attack 5ms, Decay 100ms, Sustain 0.3, Release 200ms
Pattern: Every 2 beats
Note:    Random dyad from scale (e.g., C+G, Eb+Bb)
Role:    Harmonic color — different half-note enemies play different dyads
```

### 2.4 Quarter Note Enemy: Melody

The voice. Each one plays a random note from the pentatonic scale. Multiple quarter enemies = a random melody.

```
Sound:   Square wave with gentle low-pass filter
ADSR:    Attack 5ms, Decay 80ms, Sustain 0.4, Release 150ms
Pattern: Every beat
Note:    Random note from scale, assigned at spawn, stays fixed
Role:    Melody — this is what you "hear" most
```

### 2.5 Eighth Note Enemy: Hi-Hat

Rhythmic energy. Percussive, no pitch.

```
Sound:   Noise burst (white noise through bandpass filter ~8khz)
ADSR:    Attack 1ms, Decay 40ms, Sustain 0, Release 30ms
Pattern: Every half beat
Note:    None — pure percussion
Role:    Drives the rhythm forward
```

### 2.6 Sixteenth Note Enemy: Shaker

Texture. High-frequency fill.

```
Sound:   Filtered noise, very quiet, high-passed
ADSR:    Attack 1ms, Decay 20ms, Sustain 0, Release 20ms
Pattern: Every quarter beat
Note:    None — percussion
Role:    Adds density/urgency without harmonic content
```

---

## 3. Background Drone

A quiet, constant harmonic bed. Makes the enemy notes feel like they belong in a space rather than random bleeps in silence.

```
Sound:   2 sine waves — root + fifth of current scale
         Very low volume (0.08 gain)
         Slow LFO on volume (breathing, ~0.1hz)
Filter:  Low-pass at 400hz — warm, not bright
Always:  Playing from wave start to wave end
Change:  Root shifts when scale changes between waves
```

---

## 4. Effects Chain

```
Enemy Synth → Gain → Reverb → Master Compressor → Output
                              ↑
Background Drone → Gain ──────┘
                              ↑
Player Kick → Gain ───────────┘
```

### 4.1 Reverb

Simple convolution reverb or algorithmic reverb via delay network.

Web Audio approach: chain of delays with feedback + lowpass filter.

```
Delay 1:  37ms, feedback 0.4
Delay 2:  53ms, feedback 0.35
Delay 3:  79ms, feedback 0.3
Mix:      0.25 wet, 0.75 dry
Filter:   Low-pass 3khz on wet signal
```

This gives a small-room reverb. Cheap, effective, makes everything gel.

### 4.2 Compressor (Already Have)

```
Threshold: -12dB
Ratio:     8:1
Attack:    3ms
Release:   100ms
```

---

## 5. Wave Music Generation

When a wave starts:

1. **Pick root note** — cycle through roots or random: C, D, E, F, G, A
2. **Pick scale** — minor pentatonic (default), major for reward/easy waves
3. **Set BPM** — based on wave number
4. **Assign notes to enemies** — each enemy gets a note from the scale at spawn time
5. **Start drone** — root + fifth at new key

When an enemy spawns:
- Melodic types (Whole, Half, Quarter) get a note from the current scale
- Percussive types (Eighth, Sixteenth) don't need a note
- Note is fixed for that enemy's lifetime

When an enemy dies:
- Its note is removed from the mix
- Music thins out as you clear the wave
- Last few enemies = sparse, tension

When wave clears:
- Brief silence (0.5s)
- Drone shifts to new root for next wave

---

## 6. ADSR Envelope

Need a reusable envelope generator. Web Audio's `setTargetAtTime` and `linearRampToValueAtTime` can do this.

```typescript
interface ADSR {
  attack: number   // seconds
  decay: number    // seconds
  sustain: number  // 0-1 gain level
  release: number  // seconds
}

function playNote(freq: number, type: OscillatorType, adsr: ADSR, duration: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq

  const t = ctx.currentTime
  gain.gain.setValueAtTime(0, t)
  gain.gain.linearRampToValueAtTime(0.5, t + adsr.attack)            // Attack
  gain.gain.linearRampToValueAtTime(0.5 * adsr.sustain, t + adsr.attack + adsr.decay)  // Decay → Sustain
  gain.gain.setValueAtTime(0.5 * adsr.sustain, t + duration)         // Hold sustain
  gain.gain.linearRampToValueAtTime(0.001, t + duration + adsr.release) // Release

  osc.connect(gain)
  gain.connect(reverbInput) // → reverb → master
  osc.start(t)
  osc.stop(t + duration + adsr.release)
}
```

---

## 7. Implementation Plan

### Step 1: MusicScale.ts
- Scale definitions (minor/major pentatonic)
- Root note selection
- `getNoteForEnemy(enemyType)` → frequency
- `getScaleForWave(waveNum)` → { root, scale, bpm }

### Step 2: MusicSynth.ts
- Replace raw oscillator sounds with ADSR-envelope synths
- One synth function per enemy role (bass, chord, melody, hihat, shaker)
- Player kick drum

### Step 3: MusicDrone.ts
- Background drone (root + fifth, low volume, breathing LFO)
- Transitions between keys

### Step 4: MusicEffects.ts
- Simple delay-based reverb
- Wire into audio chain before compressor

### Step 5: Wire to EnemyTypes + Spawner
- Enemy gets a note assigned at spawn from current scale
- AudioEngine calls the right synth function based on enemy type
- Wave transitions change the scale/root/BPM

---

## 8. Open Questions

- Should the player's kill sound be a note from the scale too? (Kill = satisfying chord resolution?)
- Should dash have a musical sound? (Pitch bend? Glissando?)
- How much reverb before it muddies the gameplay audio cues?
- Can we procedurally generate chord progressions? (I-IV-V in the scale?)
- Should boss waves have hand-composed patterns instead of random?

---

*The game plays itself as music. The player is the conductor.*
