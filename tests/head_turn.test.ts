import assert from 'node:assert/strict'
import {
  HEAD_TURN_DAMP_SPEED,
  HEAD_TURN_MAX_PITCH,
  HEAD_TURN_MAX_YAW,
  dampAngle,
  headTurnTarget,
} from '../app/src/head-turn'

// Center cursor means a neutral head.
assert.deepEqual(headTurnTarget(0, 0), { yaw: 0, pitch: 0 })

// Right cursor yaws right (+Y); the extremes land exactly on the cap.
assert.deepEqual(headTurnTarget(1, 0), { yaw: HEAD_TURN_MAX_YAW, pitch: 0 })
assert.deepEqual(headTurnTarget(-1, 0), { yaw: -HEAD_TURN_MAX_YAW, pitch: 0 })

// Up cursor pitches up (-X for a +Z-facing avatar).
assert.deepEqual(headTurnTarget(0, 1), { yaw: 0, pitch: -HEAD_TURN_MAX_PITCH })
assert.deepEqual(headTurnTarget(0, -1), { yaw: 0, pitch: HEAD_TURN_MAX_PITCH })

// Off-window cursors (the global feed reports those unclamped) park at the
// extreme instead of over-rotating.
assert.deepEqual(headTurnTarget(3, -2.5), { yaw: HEAD_TURN_MAX_YAW, pitch: HEAD_TURN_MAX_PITCH })
assert.deepEqual(headTurnTarget(NaN, Infinity), { yaw: 0, pitch: 0 })

// Damping eases toward the target and converges; zero delta holds still.
let angle = 0
for (let i = 0; i < 600; i++) angle = dampAngle(angle, HEAD_TURN_MAX_YAW, 1 / 60)
assert.ok(Math.abs(angle - HEAD_TURN_MAX_YAW) < 1e-4, 'damped glance converges')
assert.ok(angle > HEAD_TURN_MAX_YAW / 2, 'most motion happens early')
assert.equal(dampAngle(0.1, HEAD_TURN_MAX_YAW, 0), 0.1)
assert.equal(dampAngle(0.1, HEAD_TURN_MAX_YAW, -1), 0.1)

// A faster speed converges sooner (responsiveness is tunable).
const slow = dampAngle(0, HEAD_TURN_MAX_YAW, 1 / 60, 1)
const fast = dampAngle(0, HEAD_TURN_MAX_YAW, 1 / 60, HEAD_TURN_DAMP_SPEED * 4)
assert.ok(fast > slow)

// Caps stay subtle: a glance, not a stare.
assert.ok(HEAD_TURN_MAX_YAW < 0.3 && HEAD_TURN_MAX_PITCH < 0.2)

console.log('Head turn passed: cursor mapping, clamping, and damped follow.')
