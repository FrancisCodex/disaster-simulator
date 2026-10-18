// The wreckage physics world (Rapier): see wreckWorker.js for the protocol.
// Kept apart from the worker so it can also be driven directly (benchmarks).

export const STEP = 1 / 60
const FREEZE_AFTER = 0.4 // s at rest before a piece joins the pile
const SLOW_AGE = 6 // s: a piece still creeping after this joins the pile...
const MAX_AGE = 20 // ...and one still moving at all after this (never one in free fall)
const LIVE_HARD = 850 // beyond this, slow pieces join the pile early
// Debris does not fly. Pushes from pieces that start overlapping (or an
// over-stiff contact) are capped at speeds a falling building can give them.
const MAX_UP = 4 // m/s upward
const MAX_SPEED = 32 // m/s (free fall from ~50 m)
const MAX_SPIN = 4 // rad/s
// a piece breaks up when it hits something this hard (m/s change of speed)
const SHATTER_DV = 5.5
const SHATTER_SIZE = 2.4 // m: smaller pieces stay whole
const MAX_GEN = 2 // pieces of pieces of pieces don't break any further

let R = null

/** The worker hands over the initialised engine. */
export function useRapier(r) {
  R = r
}

export class Core {
  constructor(gen) {
    this.gen = gen
    this.pw = new R.World({ x: 0, y: -9.81, z: 0 })
    this.pw.timestep = STEP
    this.pw.numSolverIterations = 2
    this.eq = new R.EventQueue(true)
    this.owner = new Map() // collider handle → { kind, bid, box? } | { rec, piece } | { kind: 'pile', piece }
    this.bld = new Map() // bid → [collider]
    this.mounds = new Map() // bid → collider
    this.statics = []
    this.pieces = new Map() // piece id → piece { id, col, rec, size, mass, gen }
    this.live = []
    this.ground = null
    this.minY = -1e4
    this.acc = 0
    this.room = 0 // pieces the main thread can still take (for shattering)
    this.events = []
    this.moved = new Set() // pieces whose pose must be sent
  }

  fixedBox(a, o) {
    const d = R.ColliderDesc.cuboid(a[o], a[o + 1], a[o + 2])
      .setTranslation(a[o + 3], a[o + 4], a[o + 5])
      .setRotation({ x: a[o + 6], y: a[o + 7], z: a[o + 8], w: a[o + 9] })
      .setFriction(0.8)
    return this.pw.createCollider(d)
  }

  /** Remove a fixed collider; whatever was resting on it starts falling again. */
  drop(c) {
    const o = this.owner.get(c.handle)
    this.owner.delete(c.handle)
    const t = c.translation()
    // a conservative box around it (rotations are about y, so the footprint radius bounds it)
    const h = o?.box ?? [8, 8, 8]
    this.pw.removeCollider(c, true)
    // (what lies on the ground beside it still lies on the ground)
    this.wakeIn(t.x, t.y, t.z, Math.hypot(h[0], h[2]) + 0.5, h[1] + 1.5, t.y - h[1] + 0.8)
  }

  /**
   * Frozen pile pieces within a box (centre, footprint radius, half height)
   * and centred above minY come back to life: only what was held up by the
   * thing that went, not the whole pile around it.
   */
  wakeIn(x, y, z, rxz, hy, minY = y) {
    const found = []
    this.pw.collidersWithAabbIntersectingAabb({ x, y, z }, { x: rxz, y: hy, z: rxz }, (c) => {
      const o = this.owner.get(c.handle)
      if (o?.kind === 'pile' && c.translation().y > minY) found.push(o.piece)
      return true
    })
    for (const pc of found) this.unfreeze(pc)
  }

  apply(cmd) {
    switch (cmd[0]) {
      case 'ground': {
        const [, h, n, size] = cmd
        if (this.ground) {
          this.owner.delete(this.ground.handle)
          this.pw.removeCollider(this.ground, true)
        }
        let lo = Infinity
        for (const y of h) lo = Math.min(lo, y)
        this.minY = lo - 60
        this.ground = this.pw.createCollider(R.ColliderDesc.heightfield(n, n, h, { x: size, y: 1, z: size }).setFriction(0.9))
        this.owner.set(this.ground.handle, { kind: 'ground' })
        break
      }
      case 'statics': {
        // redrawn bridges and levees mostly stand where they stood: nothing on them is disturbed
        for (const c of this.statics) {
          this.owner.delete(c.handle)
          this.pw.removeCollider(c, true)
        }
        this.statics = []
        const a = cmd[1]
        for (let o = 0; o < a.length; o += 10) {
          const c = this.fixedBox(a, o)
          this.owner.set(c.handle, { kind: 'static', box: [a[o], a[o + 1], a[o + 2]] })
          this.statics.push(c)
        }
        break
      }
      case 'bld': {
        const [, bid, a] = cmd
        for (const c of this.bld.get(bid) || []) this.drop(c)
        const list = []
        for (let o = 0; o < a.length; o += 10) {
          const c = this.fixedBox(a, o)
          this.owner.set(c.handle, { kind: 'bld', bid, box: [a[o], a[o + 1], a[o + 2]], base: a[o + 4] - a[o + 1] })
          list.push(c)
        }
        this.bld.set(bid, list)
        break
      }
      case 'unbld':
        for (const c of this.bld.get(cmd[1]) || []) this.drop(c)
        this.bld.delete(cmd[1])
        break
      case 'mound': {
        const [, bid, box] = cmd
        const old = this.mounds.get(bid)
        if (old) this.drop(old)
        this.mounds.delete(bid)
        if (!box) break
        const c = this.fixedBox(box, 0)
        this.owner.set(c.handle, { kind: 'mound', bid, box: [box[0], box[1], box[2]] })
        this.mounds.set(bid, c)
        break
      }
      case 'spawn':
        this.spawn(cmd[1])
        break
      case 'remove':
        for (const id of cmd[1]) this.removePiece(id)
        break
    }
  }

  shape(s) {
    if (s.kind === 'cyl') return R.ColliderDesc.cylinder(s.hh, s.r)
    if (s.kind === 'hull') {
      const d = R.ColliderDesc.convexHull(s.pts)
      if (d) return d
    }
    return R.ColliderDesc.cuboid(s.h[0], s.h[1], s.h[2])
  }

  newRec(rb, bid, compound, v, w) {
    return { rb, bid, compound, pieces: [], mass: 1, vx: v[0], vy: v[1], vz: v[2], wx: w[0], wy: w[1], wz: w[2], still: 0, age: 0, hits: null, frozen: false, dead: false }
  }

  dynamicDesc(d, mass) {
    return d.setMass(Math.max(40, mass)).setFriction(0.8).setRestitution(0.05).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
  }

  /** body: { bid, p, q, v, w, ccd, compound, pieces: [{ id, shape, mass, lp, lq, size, gen }] } */
  spawn(body) {
    const bd = R.RigidBodyDesc.dynamic()
      .setTranslation(body.p[0], body.p[1], body.p[2])
      .setRotation({ x: body.q[0], y: body.q[1], z: body.q[2], w: body.q[3] })
      .setLinvel(body.v[0], body.v[1], body.v[2])
      .setAngvel({ x: body.w[0], y: body.w[1], z: body.w[2] })
      .setAngularDamping(0.25)
      .setLinearDamping(0.02)
    if (body.ccd) bd.setCcdEnabled(true)
    const rb = this.pw.createRigidBody(bd)
    const rec = this.newRec(rb, body.bid, !!body.compound, body.v, body.w)
    for (const p of body.pieces) {
      const d = this.dynamicDesc(this.shape(p.shape), p.mass)
        .setTranslation(p.lp[0], p.lp[1], p.lp[2])
        .setRotation({ x: p.lq[0], y: p.lq[1], z: p.lq[2], w: p.lq[3] })
      const col = this.pw.createCollider(d, rb)
      const piece = { id: p.id, col, rec, size: p.size, mass: p.mass, gen: p.gen ?? 0 }
      rec.pieces.push(piece)
      this.pieces.set(p.id, piece)
      this.owner.set(col.handle, { rec, piece })
    }
    rec.mass = rb.mass() || 1
    this.live.push(rec)
  }

  removePiece(id) {
    const pc = this.pieces.get(id)
    if (!pc) return
    this.pieces.delete(id)
    this.moved.delete(pc)
    this.owner.delete(pc.col.handle)
    const r = pc.rec
    r.pieces = r.pieces.filter((q) => q !== pc)
    if (r.rb && !r.dead) {
      this.pw.removeCollider(pc.col, true)
      if (!r.pieces.length) {
        this.pw.removeRigidBody(r.rb)
        r.rb = null
        r.dead = true
      }
    } else {
      // a pile piece: what lay on it falls
      const t = pc.col.translation()
      this.pw.removeCollider(pc.col, false)
      this.wakeIn(t.x, t.y, t.z, pc.size * 0.75 + 0.3, pc.size * 0.6 + 1)
    }
  }

  step() {
    const live = this.live
    // (each body's velocity before this step is the one read after the last)
    this.pw.step(this.eq)
    const touched = new Set()
    this.eq.drainCollisionEvents((h1, h2, started) => {
      if (!started) return
      const o1 = this.owner.get(h1)
      const o2 = this.owner.get(h2)
      if (o1?.rec && !(o2?.rec === o1.rec)) this.touch(o1.rec, o2, touched)
      if (o2?.rec && !(o1?.rec === o2.rec)) this.touch(o2.rec, o1, touched)
    })
    const split = []
    const shatter = []
    for (const r of touched) {
      if (r.dead) continue
      const v = r.rb.linvel()
      const dvx = r.vx - v.x
      const dvy = r.vy - v.y
      const dvz = r.vz - v.z
      const v0 = r.vx * r.vx + r.vy * r.vy + r.vz * r.vz
      // energy lost in this impact, and the impulse it delivered
      const dE = 0.5 * r.mass * (v0 - (v.x * v.x + v.y * v.y + v.z * v.z))
      const dv = Math.hypot(dvx, dvy, dvz)
      // a block falling as one piece breaks up on its first hard impact
      if (r.compound && v0 > 6) split.push(r)
      else if (dv > SHATTER_DV && r.pieces.length === 1 && this.room > 0) {
        const pc = r.pieces[0]
        if (pc.size > SHATTER_SIZE && pc.gen < MAX_GEN) {
          shatter.push(r)
          // each break-up makes up to four pieces out of one
          this.room -= 4
        }
      }
      if (dE > 2e3) {
        const t = r.rb.translation()
        const bld = r.hits.find((o) => o?.kind === 'bld' && o.bid !== r.bid)
        // the struck building absorbs about half of it; the rest goes into breaking the piece
        if (bld) this.events.push(['hitB', bld.bid, dE * 0.5, t.x, t.y, t.z, r.mass * dvx, r.mass * dvz])
        else if (r.hits.some((o) => o && !o.rec)) this.events.push(['hitG', t.x, t.y, t.z, (r.pieces[0]?.size ?? 2) * 0.5, dE])
      }
      r.hits = null
    }
    for (const r of split) this.split(r)
    for (const r of shatter) this.shatter(r)

    for (let i = live.length - 1; i >= 0; i--) {
      const r = live[i]
      let out = r.dead
      if (!out) {
        r.age += STEP
        const rb = r.rb
        let v2 = 0
        if (rb.isSleeping()) {
          r.still += STEP
          r.vx = r.vy = r.vz = 0
        } else {
          const v = rb.linvel()
          const a = rb.angvel()
          let { x: vx, y: vy, z: vz } = v
          let { x: wx, y: wy, z: wz } = a
          // no flying debris
          const sp = Math.hypot(vx, vy, vz)
          const sw = Math.hypot(wx, wy, wz)
          if (vy > MAX_UP || sp > MAX_SPEED) {
            const k = sp > MAX_SPEED ? MAX_SPEED / sp : 1
            vx *= k
            vz *= k
            vy = Math.min(vy * k, MAX_UP)
            rb.setLinvel({ x: vx, y: vy, z: vz }, true)
          }
          if (sw > MAX_SPIN) {
            const k = MAX_SPIN / sw
            wx *= k
            wy *= k
            wz *= k
            rb.setAngvel({ x: wx, y: wy, z: wz }, true)
          }
          r.vx = vx
          r.vy = vy
          r.vz = vz
          r.wx = wx
          r.wy = wy
          r.wz = wz
          v2 = vx * vx + vy * vy + vz * vz
          if (v2 < 0.5 && wx * wx + wy * wy + wz * wz < 0.4) r.still += STEP
          else r.still = 0
          for (const pc of r.pieces) this.moved.add(pc)
        }
        if (r.vy < -5 && rb.translation().y < this.minY) {
          for (const pc of [...r.pieces]) {
            this.events.push(['gone', pc.id])
            this.removePiece(pc.id)
          }
          out = true
        } else if (r.still > FREEZE_AFTER || (r.age > SLOW_AGE && v2 < 1) || (r.age > MAX_AGE && v2 < 9) || (live.length > LIVE_HARD && r.age > 3 && v2 < 2)) {
          // only ever at rest or creeping: nothing is frozen in mid-air
          this.freeze(r)
          out = true
        }
      }
      if (out) {
        live[i] = live[live.length - 1]
        live.pop()
      }
    }
  }

  touch(r, other, touched) {
    if (r.frozen || r.dead) return
    ;(r.hits ||= []).push(other)
    touched.add(r)
  }

  /** A compound block hit something: each of its pieces carries on as a body of its own. */
  split(r) {
    if (r.dead) return
    const t = r.rb.translation()
    const com = r.rb.worldCom()
    for (const pc of r.pieces) {
      const ct = pc.col.translation()
      const cq = pc.col.rotation()
      // velocity of this piece just before the impact: v + ω × r, plus a little scatter
      const rx = ct.x - com.x
      const ry = ct.y - com.y
      const rz = ct.z - com.z
      const vx = r.vx + (r.wy * rz - r.wz * ry) + (Math.random() - 0.5) * 2
      const vy = r.vy + (r.wz * rx - r.wx * rz)
      const vz = r.vz + (r.wx * ry - r.wy * rx) + (Math.random() - 0.5) * 2
      const rb = this.pw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(ct.x, ct.y, ct.z).setRotation(cq).setLinvel(vx, vy, vz).setAngvel({ x: r.wx, y: r.wy, z: r.wz }).setAngularDamping(0.25))
      const d = this.dynamicDesc(new R.ColliderDesc(pc.col.shape), pc.mass)
      this.owner.delete(pc.col.handle)
      const nr = this.newRec(rb, r.bid, false, [vx, vy, vz], [r.wx, r.wy, r.wz])
      nr.pieces.push(pc)
      nr.age = r.age
      pc.col = this.pw.createCollider(d, rb)
      pc.rec = nr
      nr.mass = rb.mass() || 1
      this.owner.set(pc.col.handle, { rec: nr, piece: pc })
      this.live.push(nr)
      this.moved.add(pc)
    }
    r.pieces = []
    r.dead = true
    this.pw.removeRigidBody(r.rb)
    r.rb = null
    this.events.push(['break', t.x, t.y, t.z])
  }

  /**
   * A piece hit something hard enough to break: the main thread cuts it into
   * smaller pieces (it knows what the piece looks like) and spawns them where
   * it was, with the velocity it had just before the impact.
   */
  shatter(r) {
    const pc = r.pieces[0]
    const t = pc.col.translation()
    const q = pc.col.rotation()
    this.events.push(['shatter', pc.id, t.x, t.y, t.z, q.x, q.y, q.z, q.w, r.vx * 0.6, Math.min(r.vy * 0.3, 1), r.vz * 0.6, r.wx, r.wy, r.wz])
    this.removePiece(pc.id)
  }

  /**
   * At rest: part of the pile now. The body is replaced by plain fixed
   * colliders where its pieces lie (a fixed *body* would keep its contact
   * pairs alive and cost time every step).
   */
  freeze(r) {
    r.frozen = true
    const t = r.rb.translation()
    let size = 0
    for (const pc of r.pieces) {
      const c = pc.col
      const ct = c.translation()
      const d = new R.ColliderDesc(c.shape).setTranslation(ct.x, ct.y, ct.z).setRotation(c.rotation()).setFriction(0.8)
      this.owner.delete(c.handle)
      pc.col = this.pw.createCollider(d)
      pc.rec = r
      this.owner.set(pc.col.handle, { kind: 'pile', bid: r.bid, piece: pc })
      this.moved.add(pc)
      size = Math.max(size, pc.size)
    }
    this.pw.removeRigidBody(r.rb)
    r.rb = null
    this.events.push(['settle', t.x, t.y, t.z, size])
  }

  /** What it rested on is gone: a pile piece falls again. */
  unfreeze(pc) {
    const c = pc.col
    const ct = c.translation()
    const cq = c.rotation()
    const rb = this.pw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(ct.x, ct.y, ct.z).setRotation(cq).setAngularDamping(0.25).setLinearDamping(0.02))
    const d = this.dynamicDesc(new R.ColliderDesc(c.shape), pc.mass)
    this.owner.delete(c.handle)
    this.pw.removeCollider(c, false)
    const old = pc.rec
    if (old) old.pieces = old.pieces.filter((q) => q !== pc)
    const nr = this.newRec(rb, old?.bid ?? -1, false, [0, 0, 0], [0, 0, 0])
    nr.pieces.push(pc)
    pc.col = this.pw.createCollider(d, rb)
    pc.rec = nr
    nr.mass = rb.mass() || 1
    this.owner.set(pc.col.handle, { rec: nr, piece: pc })
    this.live.push(nr)
    // and whatever was resting on it falls too
    this.wakeIn(ct.x, ct.y, ct.z, pc.size * 0.75 + 0.3, pc.size * 0.6 + 1)
  }

  poses() {
    const out = new Float32Array(this.moved.size * 8)
    let o = 0
    for (const pc of this.moved) {
      const t = pc.col.translation()
      const q = pc.col.rotation()
      out[o++] = pc.id
      out[o++] = t.x
      out[o++] = t.y
      out[o++] = t.z
      out[o++] = q.x
      out[o++] = q.y
      out[o++] = q.z
      out[o++] = q.w
    }
    this.moved.clear()
    return out
  }
}
