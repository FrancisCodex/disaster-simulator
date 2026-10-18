// Wreckage: the rigid pieces failing buildings break into. The quake and
// flood simulations still decide which building fails and when; this only
// takes over its motion once it does.
//
// The physics (Rapier, WASM) runs in a worker (wreckWorker.js): the terrain
// as a heightfield, every standing building's facade masses, bridges, levees
// and plinths, the rubble mounds, and the falling pieces. Pieces collide with
// all of it and with each other; one at rest is frozen into the pile. This
// side breaks buildings up (fracture.js), tells the worker what is where, and
// draws each piece through its own row of the building-state texture
// (buildingMesh.js) so it keeps its facade, windows and details. Poses come
// back a frame later; the main thread never waits for the physics.
//
// Kinetic energy lost in an impact on a standing building is reported to the
// damage model (onHitBuilding); impacts in the street go to onHitGround.
import * as THREE from 'three'
import { GRID, CELL } from './config.js'
import { fracture, splitBlock } from './fracture.js'
import { POSE } from './wreckCore.js'

// Budget: each moving piece costs the worker ~10–20 µs per step. New collapses
// break up more coarsely as the count rises; at LIVE_CAP they stay scripted.
const LIVE_SOFT = 300
const LIVE_CAP = 650
const MIN_PIECES = 8 // a collapse with less room than this stays scripted
const MAX_DT = 0.2 // physics time handed over at once (the worker catches up on it over a few messages)
// A big collapse hands the worker its pieces a batch at a time, so no single
// step stalls; until a piece is in the worker's world it falls on its own here.
const SPAWN_BATCH = 90
// between worker updates, a moving piece carries on along its last velocity for up to this long (s)
// the render clock trails the worker's by this much (s), so there are reports on both sides of it
const BUFFER = 0.03
// reports kept per moving piece
const HISTORY = 8
const G = 9.81
const DUST = new THREE.Color(0x6a645a)

const _m = new THREE.Matrix4()
const _o = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _u = new THREE.Vector3()
const _w = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _r = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _bp = new THREE.Vector3()
const _bq = new THREE.Quaternion()
const _bv = new THREE.Vector3()
const ONE = new THREE.Vector3(1, 1, 1)
const Y = new THREE.Vector3(0, 1, 0)

/** Tint (rgb, amount) with dust settled over it. */
function dusty(t, k) {
  const a = 1 - (1 - t[3]) * (1 - k)
  const f = (c, d) => (c * t[3] * (1 - k) + d * k) / a
  return [f(t[0], DUST.r), f(t[1], DUST.g), f(t[2], DUST.b), a]
}

/** Half extents, centre and rotation of a box: one record of a worker box list. */
function boxRecord(out, o, hx, hy, hz, p, q) {
  out[o] = hx
  out[o + 1] = hy
  out[o + 2] = hz
  out[o + 3] = p.x
  out[o + 4] = p.y
  out[o + 5] = p.z
  out[o + 6] = q.x
  out[o + 7] = q.y
  out[o + 8] = q.z
  out[o + 9] = q.w
}

export class Wreckage {
  constructor(world) {
    this.w = world
    this.worker = null
    this.ready = false
    this.enabled = true
    this.gen = 0
    this.cmds = []
    this.pieces = new Map() // id → { id, row, yc, wreck, p: what it looks like, gen: how often it has broken }
    this.heaps = new Map() // bid → texture row of its rubble heap
    this.wrecks = [] // per broken building: { bid, ids: Set }
    this.mounds = new Map() // bid → height
    this.nextId = 1
    this.live = 0 // moving pieces, as last reported (plus those spawned since)
    this.inflight = false
    this.acc = 0
    this.staticItems = null
    this.groundDirty = false
    this.groundT = 0
    // Smooth motion whatever the worker's pace: pieces it has not taken in yet
    // fall ballistically here (queued: not yet sent; flying: predicted until the
    // worker reports them), and moving pieces are carried along between reports.
    this.queue = [] // { payload, st: { p, q, v, w }, t0, pcs, pending }
    this.flying = new Set()
    this.interp = new Set() // pieces drawn between the worker's reports
    this.simT = 0 // the worker's clock, as of its last report
    this.renderT = 0 // the clock the wreckage is drawn at
    this.rate = 1 // the worker's pace against real time
    this.gap = 1 / 60 // simulated time between its reports
    this.lastReal = 0
    this.stats = { live: 0, frozen: 0, workerMs: 0, applyMs: 0 }
  }

  get ok() {
    return this.ready && this.enabled
  }

  /** Starts the physics worker; collapses stay scripted until it is ready (or if it fails). */
  start() {
    try {
      this.worker = new Worker(new URL('./wreckWorker.js', import.meta.url), { type: 'module' })
    } catch (e) {
      console.warn('Wreckage physics unavailable; collapses stay scripted.', e)
      return
    }
    this.worker.onmessage = (e) => this.receive(e.data)
    this.worker.onerror = (e) => {
      console.warn('Wreckage physics failed to start; collapses stay scripted.', e.message)
      this.ready = false
    }
  }

  receive(m) {
    if (m.type === 'ready') {
      this.ready = true
      if (this.w.bList) this.build()
      return
    }
    if (m.type !== 'state') return
    this.inflight = false
    if (m.failed) {
      // the engine panicked: every pile becomes a plain rubble mound, and the world starts over
      console.warn('Wreckage physics failed; piles replaced by rubble mounds.', m.failed)
      this.recover()
      return
    }
    if (m.gen !== this.gen) return
    const t0 = performance.now()
    const P = m.poses
    // how fast the worker's clock runs against the real one (below 1 when it is overloaded)
    const now = performance.now() / 1000
    if (this.lastReal) {
      const dReal = now - this.lastReal
      if (dReal > 0) this.rate += (Math.min(1.5, Math.max(0, (m.simT - this.simT) / dReal)) - this.rate) * 0.2
    }
    this.lastReal = now
    // how far apart (in simulated time) its reports come: the render clock stays that far behind
    if (m.simT > this.simT) this.gap += (m.simT - this.simT - this.gap) * 0.1
    this.simT = m.simT
    for (let o = 0; o < P.length; o += POSE) {
      const pc = this.pieces.get(P[o])
      if (!pc) continue
      // a short history of its reported poses, to draw it in between them at render time
      const h = (pc.hist ??= [])
      const snap = h.length >= HISTORY ? h.shift() : { t: 0, p: new THREE.Vector3(), q: new THREE.Quaternion() }
      snap.t = m.simT
      snap.p.set(P[o + 1], P[o + 2], P[o + 3])
      snap.q.set(P[o + 4], P[o + 5], P[o + 6], P[o + 7])
      h.push(snap)
      pc.rest = P[o + 8] * P[o + 8] + P[o + 9] * P[o + 9] + P[o + 10] * P[o + 10] <= 0.01
      this.interp.add(pc)
    }
    for (const e of m.events) {
      if (e[0] === 'hitB') this.onHitBuilding?.(e[1], e[2], e[3], e[4], e[5], e[6], e[7])
      else if (e[0] === 'hitG') this.onHitGround?.(e[1], e[2], e[3], e[4], e[5])
      else if (e[0] === 'settle') {
        this.stats.frozen++
        this.onSettle?.(e[1], e[2], e[3], e[4])
      } else if (e[0] === 'break') this.onBreak?.(e[1], e[2], e[3])
      else if (e[0] === 'gone') this.release(e[1])
      else if (e[0] === 'shatter') this.shatterPiece(e, m.simT)
    }
    // moving in the worker, plus those still waiting to be handed over
    this.live = m.live + this.queue.reduce((s, e) => s + e.pending, 0)
    this.stats.live = this.live
    this.stats.workerMs = this.stats.workerMs * 0.9 + m.ms * 0.1
    this.stats.applyMs = this.stats.applyMs * 0.9 + (performance.now() - t0) * 0.1
  }

  send(...cmd) {
    if (this.ready) this.cmds.push(cmd)
  }

  /** Draw piece pc with its centre at p, turned by q. */
  draw(pc, p, q) {
    _m.compose(p, q, ONE)
    this.w.bld.fragSet(pc.row, _m.multiply(_o.makeTranslation(0, -pc.yc, 0)).elements)
  }

  /**
   * A body for the worker, with its state at render time t0. Until the worker
   * has taken it in (it is handed over a batch at a time) its pieces fall on
   * their own: gravity and the spin they were given.
   */
  enqueue(payload, t0 = this.renderT) {
    const pcs = []
    for (const sp of payload.pieces) {
      const pc = this.pieces.get(sp.id)
      if (!pc) continue
      pc.lp = new THREE.Vector3().fromArray(sp.lp)
      pc.lq = new THREE.Quaternion().fromArray(sp.lq)
      pc.hist = []
      pcs.push(pc)
    }
    const st = { p: new THREE.Vector3().fromArray(payload.p), q: new THREE.Quaternion().fromArray(payload.q), v: new THREE.Vector3().fromArray(payload.v), w: new THREE.Vector3().fromArray(payload.w) }
    const entry = { payload, st, t0, pcs, pending: pcs.length }
    for (const pc of pcs) pc.entry = entry
    this.queue.push(entry)
    this.flying.add(entry)
  }

  /** Where a body falling on its own is d seconds after t0: into _bp, _bq (and its velocity into _bv). */
  ballistic(e, d) {
    const { p, q, v, w } = e.st
    _bp.copy(p).addScaledVector(v, d)
    _bp.y -= 0.5 * G * d * d
    _bv.copy(v)
    _bv.y -= G * d
    _bq.copy(q)
    const wl = w.length()
    if (wl > 1e-4) _bq.premultiply(_r.setFromAxisAngle(_u.copy(w).divideScalar(wl), wl * d))
    // it stops on the ground (the worker would have it bounce and settle)
    const g = this.w.groundAt(_bp.x, _bp.z) + 0.3
    if (_bp.y < g) {
      _bp.y = g
      _bv.set(0, 0, 0)
    }
  }

  /**
   * Redraw the moving wreckage at render time: pieces the worker reports are
   * drawn between its last two reports, pieces it has not taken in yet where
   * their fall has brought them. Either way they move every frame.
   */
  redraw() {
    const T = this.renderT
    for (const e of this.flying) {
      this.ballistic(e, Math.max(-0.3, T - e.t0))
      for (const pc of e.pcs) {
        if (pc.entry !== e) continue
        if (!this.pieces.has(pc.id)) {
          pc.entry = null
          e.pending--
          continue
        }
        // the worker's reports take over once render time has reached the first of them
        if (pc.hist?.length && T >= pc.hist[0].t) {
          pc.entry = null
          e.pending--
          continue
        }
        this.draw(pc, _w.copy(pc.lp).applyQuaternion(_bq).add(_bp), _q.copy(_bq).multiply(pc.lq))
      }
      if (e.pending <= 0) this.flying.delete(e)
    }
    for (const pc of this.interp) {
      if (pc.entry) continue
      const h = pc.hist
      if (!h?.length || !this.pieces.has(pc.id)) {
        this.interp.delete(pc)
        continue
      }
      // the reports either side of render time (older ones are no longer needed)
      while (h.length > 2 && h[1].t <= T) h.shift()
      const a = h[0]
      const b = h[1]
      if (!b || T >= b.t) {
        const last = b ?? a
        this.draw(pc, last.p, last.q)
        // at rest in the pile: nothing more to draw until it moves again
        if (pc.rest && T >= last.t) this.interp.delete(pc)
        continue
      }
      const f = T <= a.t ? 0 : (T - a.t) / Math.max(1e-6, b.t - a.t)
      this.draw(pc, _w.copy(a.p).lerp(b.p, f), _q.copy(a.q).slerp(b.q, f))
    }
  }

  /** (Re)creates the physics world for the current city (the wreckage rows were reallocated). */
  build() {
    this.queue = []
    this.flying.clear()
    this.interp.clear()
    this.simT = this.renderT = this.lastReal = 0
    this.rate = 1
    this.pieces.clear()
    this.heaps.clear()
    this.wrecks = []
    this.mounds.clear()
    this.live = 0
    if (!this.ok || !this.w.city) return
    this.gen++
    this.cmds = [['reset', this.gen]]
    this.sendGround()
    for (const b of this.w.bList) {
      const a = this.w.anim.get(b.id)
      if (!a?.rubble && !a?.broken) this.addBuilding(b)
      else if (a.heap) {
        this.setMound(b, a.heapH * 0.45, a.spread * 0.8)
        this.heap(b, a.heapH, a.spread)
      } else this.setMound(b, b.height * a.hScale, a.spread)
    }
    if (this.staticItems) this.setStatics(this.staticItems)
  }

  reset() {
    this.build()
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.ready = false
  }

  sendGround() {
    const n = GRID
    const h = new Float32Array((n + 1) * (n + 1))
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) h[i * (n + 1) + j] = this.w.vertexHeight(i, j)
    this.send('ground', h, n, n * CELL)
  }

  /** The terrain moved (ground failure, landslides): rebuild the heightfield soon. */
  groundChanged() {
    this.groundDirty = true
  }

  /** Bridges, levees, pumps and plinths, as drawn by World.rebuildStatic. */
  setStatics(items) {
    this.staticItems = items
    if (!this.ok) return
    const a = new Float32Array(items.length * 10)
    items.forEach((it, k) => {
      const rz = it.rz || 0
      // the drawn box is rotated about its base centre
      _p.set(it.x - (Math.sin(rz) * it.sy) / 2, it.y + (Math.cos(rz) * it.sy) / 2, it.z)
      boxRecord(a, k * 10, it.sx / 2, it.sy / 2, it.sz / 2, _p, _q.setFromAxisAngle(_u.set(0, 0, 1), rz))
    })
    this.send('statics', a)
  }

  /** A standing building's facade masses (below `cut` rest metres) as fixed boxes. */
  addBuilding(b, cut = Infinity) {
    if (!this.ok) return
    const row = this.w.bIndex.get(b.id)
    if (row === undefined) return
    const masses = this.w.bld.shapes[row].masses
    this.w.composeFrame(b, _m)
    _m.decompose(_w, _q, _s)
    const a = new Float32Array(masses.length * 10)
    let k = 0
    for (const m of masses) {
      const h = Math.min(m.y + m.h, cut) - m.y
      if (h < 0.3) continue
      _p.set(m.x, m.y + h / 2, m.z).applyMatrix4(_m)
      boxRecord(a, k++ * 10, m.w / 2, h / 2, m.d / 2, _p, _r.setFromAxisAngle(Y, m.ry).premultiply(_q))
    }
    this.send('bld', b.id, a.subarray(0, k * 10))
  }

  removeBuilding(b) {
    this.send('unbld', b.id)
  }

  /** The rubble mound left on a building's footprint: a fixed box `h` metres high. */
  setMound(b, h, spread = 1) {
    if (!this.ok) return
    const old = this.mounds.get(b.id) ?? 0
    if (Math.abs(old - h) < 0.25 && (old > 0) === (h >= 0.2)) return
    if (h < 0.2) {
      this.mounds.delete(b.id)
      this.send('mound', b.id, null)
      return
    }
    this.mounds.set(b.id, h)
    const y = b.base + b.elevated - (this.w.anim.get(b.id)?.settle || 0)
    const a = new Float32Array(10)
    boxRecord(a, 0, (b.fw * spread) / 2, h / 2, (b.fd * spread) / 2, _p.set(b.cx, y + h / 2, b.cz), _q.identity())
    this.send('mound', b.id, a)
  }

  /** How many more pieces may start moving now (0: let the next collapse stay scripted). */
  room() {
    if (!this.ok) return 0
    const n = LIVE_CAP - this.live
    return n >= MIN_PIECES ? n : 0
  }

  /** How finely to break a building: coarser far from the camera and when many pieces are already moving. */
  lodFor(b) {
    const cam = this.w.camera.position
    const d = Math.hypot(cam.x - b.cx, cam.y - b.base, cam.z - b.cz)
    const near = d < 400 ? 1 : d < 800 ? 0.6 : 0.35
    const load = this.live / LIVE_SOFT
    return Math.max(0.15, near * Math.min(1, 1.3 - load * 0.6))
  }

  /** Spin (rad/s) that tips a falling block over the way it is moving. */
  tipping(vel) {
    const h = Math.hypot(vel[0], vel[2]) || 1
    const k = 0.25 + Math.random() * 0.3
    // ω = ŷ × direction: the top leads
    return [(vel[2] / h) * k, 0, (-vel[0] / h) * k]
  }

  /** Collision shape of a piece, centred on it. */
  shapeOf(p) {
    if (p.kind !== 'detail' || p.geo === 'box') return { kind: 'box', h: [p.w / 2, p.h / 2, p.d / 2] }
    if (p.geo === 'cyl') return { kind: 'cyl', hh: p.h / 2, r: Math.max(p.w, p.d) / 2 }
    // roofs, spires, domes: the convex hull of the drawn shape
    const src = this.w.bld.geos[p.geo]?.attributes.position.array
    if (!src) return { kind: 'box', h: [p.w / 2, p.h / 2, p.d / 2] }
    const pts = new Float32Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      pts[i] = src[i] * p.w
      pts[i + 1] = (src[i + 1] - 0.5) * p.h
      pts[i + 2] = src[i + 2] * p.d
    }
    return { kind: 'hull', pts, h: [p.w / 2, p.h / 2, p.d / 2] }
  }

  /**
   * Break building b into rigid pieces and let them fall.
   * opts: mode 'crush' | 'chunks', above / below / drop (rest metres, see
   * fracture()), frame: Matrix4 of the building as it is now (tilted,
   * toppling...), sway: { x, z, vx, vz } at the top, topple: { omega, ax, az,
   * px, py, pz } rigid rotation about a base edge, vel: [x, y, z] common
   * velocity, compound: the pieces move as one body until it hits something.
   * Returns the number of pieces.
   */
  breakBuilding(b, opts) {
    if (!this.ok) return 0
    const w = this.w
    const row = w.bIndex.get(b.id)
    if (row === undefined) return 0
    const { mode = 'crush', frame, sway, topple, vel = [0, 0, 0], compound = false } = opts
    // as fine as the camera distance and the piece budget allow
    const room = Math.max(MIN_PIECES, LIVE_CAP - this.live)
    const fr = { mode, above: opts.above ?? 0, below: opts.below ?? Infinity, drop: opts.drop ?? 0, lod: this.lodFor(b) }
    let pieces = fracture(b, w.bld.shapes[row], fr)
    while (pieces.length > room && fr.lod > 0.12) {
      fr.lod *= 0.6
      pieces = fracture(b, w.bld.shapes[row], fr)
    }
    // the smallest pieces go with the dust
    if (pieces.length > room) pieces = pieces.sort((p, q) => q.mass - p.mass).slice(0, room)
    while (w.bld.fragAvailable() < pieces.length && this.retireOldest()) {
      /* make room */
    }
    pieces = pieces.slice(0, w.bld.fragAvailable())
    if (!pieces.length) return 0
    const [tb, td] = w.bld.tintOf(row)
    const tintB = dusty(tb, 0.25)
    const tintD = dusty(td, 0.25)
    frame.decompose(_w, _q, _s)
    const bq = _q.clone()
    const H = b.height
    const wreck = { bid: b.id, ids: new Set() }
    this.wrecks.push(wreck)
    const ax = topple ? new THREE.Vector3(topple.ax, 0, topple.az).normalize() : null
    // a compound starts as one body at the base of the block it is made of
    const y0 = opts.above ?? 0
    const cbody = compound
      ? { bid: b.id, compound: true, p: _u.set(0, y0, 0).applyMatrix4(frame).toArray(), q: bq.toArray(), v: vel, w: this.tipping(vel), pieces: [] }
      : null

    for (const p of pieces) {
      const prow = w.bld.fragAlloc()
      const yc = p.y + p.h / 2
      // draw it: the piece itself in its own row, plus whatever rides on it
      if (p.kind === 'detail') w.bld.fragPart(prow, p.geo, { x: 0, y: p.y, z: 0, ry: 0, w: p.w, h: p.h, d: p.d, color: p.color })
      else w.bld.fragPart(prow, 'body', { x: 0, y: p.y, z: 0, ry: 0, w: p.w, h: p.h, d: p.d, color: p.color, fh: p.fh, style: p.style, seed: p.seed, flags: p.flags })
      const c = Math.cos(p.ry)
      const s = Math.sin(p.ry)
      for (const d of p.attached) {
        const dx = d.x - p.x
        const dz = d.z - p.z
        w.bld.fragPart(prow, d.g, { x: c * dx - s * dz, y: d.y, z: s * dx + c * dz, ry: d.ry - p.ry, w: d.w, h: d.h, d: d.d, color: d.color })
      }
      w.bld.fragTint(prow, tintB, tintD)
      const id = this.nextId++
      this.pieces.set(id, { id, row: prow, yc, wreck, p, gen: 0 })
      wreck.ids.add(id)
      const shape = this.shapeOf(p)
      const size = Math.max(p.w, p.h, p.d)
      const mass = p.mass
      _r.setFromAxisAngle(Y, p.ry)

      if (cbody) {
        // a collider of the compound, placed in the building's axes
        cbody.pieces.push({ id, shape, mass, size, gen: 0, lp: [p.x, yc - y0, p.z], lq: _r.toArray() })
        _m.compose(_p.fromArray(cbody.p), bq, ONE).multiply(_o.compose(_u.set(p.x, yc - y0, p.z), _r, ONE))
        w.bld.fragSet(prow, _m.multiply(_o.makeTranslation(0, -yc, 0)).elements, p.rough ? 4 : 0)
        continue
      }
      // where it is now: on the building's frame, displaced by the sway at its height
      const k = sway ? Math.min(1, Math.max(0, yc / Math.max(1, H))) : 0
      const sk = k * k * (3 - 2 * k)
      const pos = new THREE.Vector3(p.x, yc, p.z).applyMatrix4(frame)
      if (sway) pos.add(_u.set(sway.x * sk, 0, sway.z * sk))
      // start clear of the ground
      const g = w.groundAt(pos.x, pos.z)
      if (pos.y - p.h / 2 < g + 0.05) pos.y = g + 0.05 + p.h / 2
      const q = _r.premultiply(bq)
      // velocity of its centre
      const v = new THREE.Vector3(vel[0], vel[1], vel[2])
      if (sway) v.x += sway.vx * sk
      if (sway) v.z += sway.vz * sk
      const om = new THREE.Vector3()
      if (topple) {
        // rigid rotation about the base edge: v = ω × r
        om.copy(ax).multiplyScalar(topple.omega)
        v.add(new THREE.Vector3().crossVectors(om, _u.set(pos.x - topple.px, pos.y - topple.py, pos.z - topple.pz)))
      }
      if (p.kind === 'wall') {
        // Facade panels peel away and tip outward as the floors behind them give
        // way. They start already leaning out (hinged at their foot): a panel
        // that came down square onto the one below would stack into a free-
        // standing wall, which loose panels cannot be.
        const n = _u.set(p.nx, 0, p.nz).applyQuaternion(bq).clone()
        const axis = new THREE.Vector3().crossVectors(Y, n)
        const lean = (0.1 + Math.random() * 0.18) * (0.6 + k)
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, lean))
        pos.addScaledVector(n, (Math.sin(lean) * p.h) / 2)
        pos.y -= ((1 - Math.cos(lean)) * p.h) / 2
        om.add(axis.multiplyScalar((0.5 + Math.random() * 0.8) * (0.6 + k)))
        v.addScaledVector(n, 0.3 + Math.random() * 1.2 * (0.4 + k))
      } else if (mode === 'crush') {
        om.x += (Math.random() - 0.5) * 0.5
        om.z += (Math.random() - 0.5) * 0.5
        v.x += (Math.random() - 0.5) * 1.2
        v.z += (Math.random() - 0.5) * 1.2
      } else {
        om.x += (Math.random() - 0.5) * 0.4
        om.z += (Math.random() - 0.5) * 0.4
      }
      this.enqueue({ bid: b.id, p: pos.toArray(), q: q.toArray(), v: v.toArray(), w: om.toArray(), ccd: Math.min(p.w, p.h, p.d) < 0.8, pieces: [{ id, shape, mass, size, gen: 0, lp: [0, 0, 0], lq: [0, 0, 0, 1] }] })
      _m.compose(pos, q, ONE)
      w.bld.fragSet(prow, _m.multiply(_o.makeTranslation(0, -yc, 0)).elements, p.rough ? 4 : 0)
    }
    if (cbody) this.enqueue(cbody)
    this.live += compound ? 1 : pieces.length
    return pieces.length
  }

  /**
   * The worker reports a piece that hit something hard enough to break.
   * Concrete does not stay in neat slabs and panels: it cracks into blocks,
   * each carrying on with the velocity the piece had just before the impact.
   */
  shatterPiece(e, t0 = this.renderT) {
    const pc = this.pieces.get(e[1])
    if (!pc) return
    const bld = this.w.bld
    const [, , x, y, z, qx, qy, qz, qw, vx, vy, vz, wx, wy, wz] = e
    const p = pc.p
    const size = Math.max(p.w, p.h, p.d)
    const n = Math.max(2, Math.min(4, Math.round(size / 2), LIVE_CAP - this.live))
    const blocks = splitBlock(p.w, p.h, p.d, n)
    const [tb, td] = bld.tintOf(pc.row)
    const wreck = pc.wreck
    this.release(pc.id)
    const q = new THREE.Quaternion(qx, qy, qz, qw)
    const om = new THREE.Vector3(wx, wy, wz)
    const yc0 = p.y + p.h / 2
    const vol = p.w * p.h * p.d
    let made = 0
    for (const k of blocks) {
      const row = bld.fragAlloc()
      if (row < 0) break
      // bottom of this block in the building's storey metres, so a facade keeps its floors
      const by = yc0 + k.y - k.h / 2
      const yc = by + k.h / 2
      const kind = p.kind === 'detail' ? 'chunk' : p.kind
      // broken concrete shows its rough faces; a big piece of facade still shows its windows
      const rough = p.kind !== 'wall' || Math.min(k.w, k.d) > 0.8 || Math.max(k.w, k.h, k.d) < 1.6
      if (p.kind === 'detail') bld.fragPart(row, 'box', { x: 0, y: by, z: 0, ry: 0, w: k.w, h: k.h, d: k.d, color: p.color })
      else bld.fragPart(row, 'body', { x: 0, y: by, z: 0, ry: 0, w: k.w, h: k.h, d: k.d, color: p.color, fh: p.fh, style: p.style, seed: p.seed, flags: 0 })
      bld.fragTint(row, tb, td)
      const off = new THREE.Vector3(k.x, k.y, k.z).applyQuaternion(q)
      const pos = new THREE.Vector3(x, y, z).add(off)
      const v = new THREE.Vector3(vx, vy, vz).add(new THREE.Vector3().crossVectors(om, off))
      // the pieces spring apart a little as the block cracks
      if (off.lengthSq() > 1e-6) v.addScaledVector(off.clone().normalize(), 0.5 + Math.random())
      const w = [om.x + (Math.random() - 0.5) * 1.5, om.y + (Math.random() - 0.5) * 0.5, om.z + (Math.random() - 0.5) * 1.5]
      const id = this.nextId++
      const mass = (p.mass * k.w * k.h * k.d) / vol
      this.pieces.set(id, { id, row, yc, wreck, p: { ...p, kind, y: by, w: k.w, h: k.h, d: k.d, mass, attached: [] }, gen: pc.gen + 1 })
      wreck.ids.add(id)
      const ksize = Math.max(k.w, k.h, k.d)
      this.enqueue({ bid: wreck.bid, p: pos.toArray(), q: q.toArray(), v: v.toArray(), w, ccd: Math.min(k.w, k.h, k.d) < 0.8, pieces: [{ id, shape: { kind: 'box', h: [k.w / 2, k.h / 2, k.d / 2] }, mass, size: ksize, gen: pc.gen + 1, lp: [0, 0, 0], lq: [0, 0, 0, 1] }] }, t0)
      _m.compose(pos, q, ONE)
      bld.fragSet(row, _m.multiply(_o.makeTranslation(0, -yc, 0)).elements, rough ? 4 : 0)
      made++
    }
    this.live += made
    this.onShatter?.(x, y, z, size)
  }

  /** Every intact block of building bid's wreckage breaks up where it lies (what held it up has given way). */
  crushWreck(bid) {
    const wreck = this.wrecks.find((wr) => wr.bid === bid)
    if (!wreck) return
    const D = this.w.bld.data
    for (const id of [...wreck.ids]) {
      const pc = this.pieces.get(id)
      if (!pc || pc.gen > 0 || Math.max(pc.p.w, pc.p.h, pc.p.d) < 2.4) continue
      // over budget: the rest stay whole
      if (LIVE_CAP - this.live < 4) break
      // its pose, from the frame it is drawn with (frame = pose · T(0, −yc, 0))
      const o = pc.row * 28
      _m.set(D[o], D[o + 1], D[o + 2], D[o + 3], D[o + 4], D[o + 5], D[o + 6], D[o + 7], D[o + 8], D[o + 9], D[o + 10], D[o + 11], 0, 0, 0, 1)
      _m.multiply(_o.makeTranslation(0, pc.yc, 0)).decompose(_p, _q, _s)
      this.send('remove', [id])
      this.shatterPiece(['shatter', id, _p.x, _p.y, _p.z, _q.x, _q.y, _q.z, _q.w, 0, -1, 0, 0, 0, 0])
    }
  }

  /**
   * A rubble heap on building b's footprint (drawn only): a low mound of
   * crushed material with broken blocks and bent reinforcing bars sticking
   * out of it. h: height at the middle (m).
   */
  heap(b, h, spread = 1.1) {
    const bld = this.w.bld
    const old = this.heaps.get(b.id)
    if (old !== undefined) bld.fragRelease(old)
    this.heaps.delete(b.id)
    if (h < 0.2 || !bld.fragFree) return
    const row = bld.fragAlloc()
    if (row < 0) return
    this.heaps.set(b.id, row)
    const y0 = b.base + b.elevated - (this.w.anim.get(b.id)?.settle || 0)
    bld.fragSet(row, _m.makeTranslation(b.cx, y0, b.cz).elements, 0)
    const brow = this.w.bIndex.get(b.id)
    const [tb, td] = brow !== undefined ? bld.tintOf(brow) : [[0, 0, 0, 0], [0, 0, 0, 0]]
    bld.fragTint(row, dusty(tb, 0.45), dusty(td, 0.45))
    const rx = (b.fw * spread) / 2
    const rz = (b.fd * spread) / 2
    const own = new THREE.Color(b.color)
    const colours = [
      [0.42, 0.4, 0.37],
      [0.55, 0.53, 0.49],
      [0.3, 0.29, 0.27],
      [own.r, own.g, own.b],
    ]
    const pick = () => colours[Math.floor(Math.random() * colours.length)]
    // the crushed material: a flattened dome, lumped up here and there
    bld.fragPart(row, 'dome', { x: 0, y: -h * 0.15, z: 0, ry: 0, w: rx * 2, h: h * 1.15, d: rz * 2, color: colours[0] })
    const top = (u, v) => Math.max(0, h * 1.15 * Math.sqrt(Math.max(0, 1 - u * u - v * v)) - h * 0.15)
    for (let q = 0; q < 4; q++) {
      const u = (Math.random() - 0.5) * 1.1
      const v = (Math.random() - 0.5) * 1.1
      const s = Math.min(rx, rz) * (0.35 + Math.random() * 0.35)
      bld.fragPart(row, 'pyr', { x: u * rx, y: top(u, v) * 0.55, z: v * rz, ry: Math.random() * 3, w: s, h: h * (0.35 + Math.random() * 0.4), d: s * (0.7 + Math.random() * 0.6), color: pick() })
    }
    // broken blocks lying in and on it
    const n = Math.round(Math.min(60, Math.max(12, (b.fw * b.fd) / 18)))
    for (let q = 0; q < n; q++) {
      const r = Math.sqrt(Math.random()) * 0.95
      const a = Math.random() * Math.PI * 2
      const u = r * Math.cos(a)
      const v = r * Math.sin(a)
      const s = 0.3 + Math.random() ** 2 * 1.8
      bld.fragPart(row, 'box', { x: u * rx, y: top(u, v) - s * 0.35, z: v * rz, ry: Math.random() * 3, w: s * (0.6 + Math.random() * 0.8), h: s * (0.3 + Math.random() * 0.5), d: s * (0.6 + Math.random() * 0.8), color: pick() })
    }
    // reinforcing bars bent up out of the concrete
    for (let q = 0; q < Math.min(8, Math.round(n / 8)); q++) {
      const u = (Math.random() - 0.5) * 1.2
      const v = (Math.random() - 0.5) * 1.2
      bld.fragPart(row, 'cyl', { x: u * rx, y: top(u, v) - 0.3, z: v * rz, ry: 0, w: 0.05, h: 0.8 + Math.random() * 1.6, d: 0.05, color: [0.28, 0.17, 0.1] })
    }
  }

  /** Height of b's rubble heap above its base at world (x, z), or -1 outside it. */
  heapAt(b, h, spread, x, z) {
    const u = (x - b.cx) / ((b.fw * spread) / 2)
    const v = (z - b.cz) / ((b.fd * spread) / 2)
    const r2 = u * u + v * v
    if (r2 >= 1) return -1
    return Math.max(0, h * 1.15 * Math.sqrt(1 - r2) - h * 0.15)
  }

  /** Forget a piece and free its row. */
  release(id) {
    const pc = this.pieces.get(id)
    if (!pc) return
    this.pieces.delete(id)
    pc.wreck.ids.delete(id)
    this.interp.delete(pc)
    this.w.bld.fragRelease(pc.row)
  }

  /** Called every frame: hands the worker this frame's commands and time, unless it is still busy. */
  update(dt) {
    if (!this.ok) return
    if (this.groundDirty && this.w.realTime - this.groundT > 0.5) {
      this.groundDirty = false
      this.groundT = this.w.realTime
      this.sendGround()
    }
    this.acc = Math.min(this.acc + dt, MAX_DT)
    // The render clock runs at the worker's pace, a little behind its clock: when
    // the physics is overloaded the wreckage plays in smooth slow motion instead
    // of stopping and starting.
    this.renderT += dt * this.rate
    this.renderT += (this.simT - Math.max(BUFFER, this.gap * 1.5) - this.renderT) * Math.min(1, dt * 4)
    this.renderT = Math.min(this.renderT, this.simT)
    this.redraw()
    if (this.inflight || (!this.cmds.length && !this.live && !this.queue.length)) return
    // hand over the next batch of new bodies, from where they have fallen to by now
    let n = 0
    while (this.queue.length && n < SPAWN_BATCH) {
      const e = this.queue.shift()
      const pieces = e.payload.pieces.filter((s) => this.pieces.has(s.id))
      if (!pieces.length) {
        this.flying.delete(e)
        continue
      }
      // the worker starts it at its own clock, so hand it over as it will be then
      this.ballistic(e, this.simT - e.t0)
      this.cmds.push(['spawn', { ...e.payload, pieces, p: _bp.toArray(), q: _bq.toArray(), v: _bv.toArray(), w: e.st.w.toArray() }])
      n += pieces.length
    }
    this.inflight = true
    const cmds = this.cmds
    this.cmds = []
    const transfer = []
    for (const c of cmds) for (const x of c) if (ArrayBuffer.isView(x)) transfer.push(x.buffer)
    // the worker may break pieces up only as far as the budget and the free rows allow
    const room = Math.max(0, Math.min(LIVE_CAP - this.live, this.w.bld.fragAvailable() - 64))
    this.worker.postMessage({ type: 'step', dt: this.acc, room, cmds }, transfer.filter((b, i) => transfer.indexOf(b) === i))
    this.acc = 0
  }

  /** The worker failed: drop every piece (each pile becomes a rubble mound) and start over. */
  recover() {
    const bids = this.wrecks.map((wr) => wr.bid)
    for (const pc of this.pieces.values()) this.w.bld.fragRelease(pc.row)
    this.build()
    for (const bid of bids) this.onRetire?.(bid)
  }

  /** Out of rows: an old pile gives up its pieces (the building keeps a full rubble mound instead). */
  retireOldest() {
    if (!this.wrecks.length) return false
    // the oldest pile out of view, if there is one
    const cam = this.w.camera.position
    let k = 0
    for (let i = 0; i < Math.min(this.wrecks.length, 40); i++) {
      const b = this.w.city.byId.get(this.wrecks[i].bid)
      if (b && Math.hypot(cam.x - b.cx, cam.z - b.cz) > 600) {
        k = i
        break
      }
    }
    const wreck = this.wrecks.splice(k, 1)[0]
    const ids = [...wreck.ids]
    for (const id of ids) this.release(id)
    this.send('remove', ids)
    this.onRetire?.(wreck.bid)
    return true
  }
}
