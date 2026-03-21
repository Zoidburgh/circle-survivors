export interface SongPattern {
  name: string
  loopBeats: number
  patterns: {
    [typeName: string]: number[]
  }
}

// Player beats on every whole beat. Enemies fill the gaps.
// Design each enemy relative to the player pulse.

export const SONG_DEFAULT: SongPattern = {
  name: 'Default',
  loopBeats: 8,
  patterns: {
    // Player: the backbone, every beat
    'Player':  [0, 1, 2, 3, 4, 5, 6, 7],

    // Half-beat pulse for zigzag movement
    'HalfBeat': [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5],

    // Enemy 1 "Offbeat": right between every player hit — call and response
    'Offbeat': [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
  },
}
