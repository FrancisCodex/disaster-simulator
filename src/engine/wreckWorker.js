// Wreckage physics, off the main thread. Owns the Rapier world: terrain
// heightfield, standing buildings, bridges and rubble mounds as fixed
// colliders, and the falling pieces of broken buildings as dynamic bodies.
// The main thread (wreckage.js) sends batched commands with each step and
// gets back the world pose of every piece that moved, plus impact events.
//
// Protocol, main → worker: { type: 'step', dt, room, cmds: [[name, ...args]] }
//   (room: how many more pieces the main thread can take, for shattering)
//   ['reset', gen]                          drop everything (new city)
//   ['ground', heights, n, size]             (n+1)² vertex heights, x-major
//   ['statics', boxes]                       Float32Array, 10 per box
//   ['bld', bid, boxes] / ['unbld', bid]     a standing building's masses
//   ['mound', bid, box | null]               a rubble mound
//   ['spawn', body]                          pieces of a broken building
//   ['remove', ids]                          forget pieces (recycled rows)
// Boxes: half extents (3), centre (3), rotation quaternion (4).
// worker → main: { type: 'state', gen, poses, events, live, ms }
//   simT: the simulated time these poses are for
//   poses: Float32Array of [id, px, py, pz, qx, qy, qz, qw, vx, vy, vz]
//   events: ['hitB', bid, joules, x, y, z, impulse x, impulse z]
//           ['hitG', x, y, z, r, joules] ['settle', x, y, z, size]
//           ['break', x, y, z] ['gone', id]
//           ['shatter', id, x, y, z, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz]
import RAPIER from '@dimforge/rapier3d-compat'
import { Core, STEP, useRapier } from './wreckCore.js'

let R = null
let core = null

self.onmessage = (e) => {
  const m = e.data
  if (m.type !== 'step' || !R) return
  const t0 = performance.now()
  let failed = null
  try {
    for (const cmd of m.cmds) {
      if (cmd[0] === 'reset') core = new Core(cmd[1])
      else core?.apply(cmd)
    }
    if (core) core.room = m.room ?? 0
    if (core && core.live.length) {
      core.acc += m.dt
      let n = 0
      // after a slow step (a big building just broke up) catch up over the next few
      // messages rather than drop the time: dropped time shows as debris hanging still
      while (core.acc >= STEP && n < 4) {
        core.step()
        core.acc -= STEP
        n++
      }
      // only a backlog of more than a fifth of a second is let go
      core.acc = Math.min(core.acc, 0.2)
    } else if (core) {
      // nothing moving: time still passes (pieces handed over next start from here)
      core.acc = 0
      core.simT += m.dt
    }
  } catch (err) {
    // the engine panicked: report it; the main thread starts over with a fresh world
    failed = String(err?.message || err)
    core = null
  }
  const poses = core ? core.poses() : new Float32Array(0)
  const events = core ? core.events.splice(0) : []
  self.postMessage({ type: 'state', gen: core?.gen ?? -1, simT: core?.simT ?? 0, poses, events, live: core?.live.length ?? 0, ms: performance.now() - t0, failed }, [poses.buffer])
}

RAPIER.init().then(() => {
  R = RAPIER
  useRapier(RAPIER)
  self.postMessage({ type: 'ready' })
})
