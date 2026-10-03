import assert from 'node:assert/strict'
import { MusicMotion } from '../app/src/music-motion'
import { DEFAULT_MUSIC } from '../app/src/music-settings'
const motion = new MusicMotion()
let previous = { pitch: 0, roll: 0 }
for (let i = 0; i < 3600; i++) {
  const now = i / 60
  motion.receiveAudio(i < 3000 ? .15 : 0, true, now)
  if (i % 22 === 0) motion.receiveBeat({ bpm: i % 44 ? 195 : 95, confidence: 1, timestamp: 0 }, now, .04)
  if (i % 31 === 0) motion.receiveBeat({ bpm: null, confidence: 0, timestamp: 0 }, now, 0)
  const pose = motion.step(1 / 60, now, DEFAULT_MUSIC, i < 3100, false, false, 0)
  assert.ok(Math.abs(pose.pitch - previous.pitch) < .16, 'No phase reset/snap on noisy beats or lost tempo lock')
  assert.ok(Math.abs(pose.roll - previous.roll) < .03)
  assert.ok(Math.abs(pose.pitch) <= DEFAULT_MUSIC.nod * Math.PI / 180)
  previous = pose
}
assert.ok(Math.abs(previous.pitch) < .001, 'Music pose eases to rest after silence')
function intensity(amplitude: number) {
  const m = new MusicMotion(); let amount=0
  for(let i=0;i<300;i++) { m.receiveAudio(amplitude,true,i/60); amount=m.step(1/60,i/60,DEFAULT_MUSIC,true,false,false,0).intensity }
  return amount
}
assert.ok(intensity(.005) < intensity(.15) * .3, 'Quiet audio makes smaller nods')
assert.ok(intensity(0)<.001, 'Silent amplitude does not keep nodding')
console.log('Music motion passed: continuous phase under noisy beats, smooth stop, amplitude response.')
