// Post-earthquake fire: burning, burnout and spread between buildings and trees.
//
//  • Fuel: design fire loads by occupancy (Eurocode EN 1991-1-2 Annex E, MJ/m²
//    of floor) plus the combustible structure itself (timber frames, the wooden
//    floors and roofs of masonry). A compartment burns for fuel / heat-release
//    rate; the fire climbs floor by floor. It grows (t² fire), burns fully
//    developed, and dies away once ~70% of the fuel is gone — so a fire with
//    nothing left to burn goes out by itself.
//  • Radiant spread: heat flux from a burning facade reaching a neighbour
//    through the view factor of a facing rectangle; a neighbour ignites once
//    the flux exceeds its critical value (≈12.6 kW/m² for timber), sooner the
//    more it is exceeded. Wind leans the flames over downwind buildings.
//  • Firebrands: in wind, embers land downwind and can light wooden roofs and
//    trees — how urban fires jump streets (Kantō 1923, Kobe 1995).
//  • A burning building that collapses throws burning debris around it.
//  • Trees are fuel too: they catch, carry fire along streets and burn out.

import { GRID, CELL, CELL_ROAD, CELL_POND } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { clamp } from './math.js'

// design fire load density, MJ per m² of floor (EN 1991-1-2 Annex E, 80% fractile-ish)
const FIRE_LOAD = { house: 780, apartment: 780, office: 420, tower: 600, industrial: 1180, hospital: 230, fire: 300, school: 285, shelter: 300 }
// heat-release rate per m² of floor while fully developed (MW/m²)
const RHR = { industrial: 0.5 }
// combustible structure adds to the fuel (MJ/m²)
const STRUCTURE_FUEL = { wood_old: 380, wood_mod: 320, urm: 150 }
// critical heat flux for ignition (kW/m²): exposed timber vs. ignition through windows
const Q_CRIT = { wood_old: 12.6, wood_mod: 12.6, urm: 20, rc_low: 25, rc_mod: 25, rc_high: 25, steel: 25, isolated: 25 }
// chance an ember landing on the roof starts a fire
const BRAND_IGNITE = { wood_old: 0.2, wood_mod: 0.14, urm: 0.05 }
const TREE_QCRIT = 15
const isWood = (b) => b.construction === 'wood_old' || b.construction === 'wood_mod'

/** View factor from the centre-line of a W×H emitting rectangle to a point d metres away. */
export function viewFactor(W, H, d) {
  const c = Math.max(0.3, d)
  const A = W / 2 / c
  const B = H / 2 / c
  const sa = Math.sqrt(1 + A * A)
  const sb = Math.sqrt(1 + B * B)
  return (4 / (2 * Math.PI)) * ((A / sa) * Math.atan(B / sa) + (B / sb) * Math.atan(A / sb))
}

export class FireSim {
  constructor(city, rng) {
    this.city = city
    this.rng = rng
    // the day's wind: direction it blows toward (radians, x east / z south) and speed (m/s)
    this.wind = { dir: rng.float(0, Math.PI * 2), speed: Math.max(0.5, rng.normal() * 2.5 + 4) }
    // trees that stand on open ground, bucketed by cell
    this.trees = []
    this.treeCell = new Map()
    for (const t of city.trees || []) {
      const k = idx(t.i, t.j)
      if (city.buildingAt[k] >= 0 || city.cellType[k] === CELL_ROAD || city.cellType[k] === CELL_POND || city.levee[k] > 0) continue
      const tr = { t, x: cellToWorld(t.i) + t.ox, z: cellToWorld(t.j) + t.oz, fire: 0, dur: 0, burnt: false }
      this.trees.push(tr)
      let a = this.treeCell.get(k)
      if (!a) this.treeCell.set(k, (a = []))
      a.push(tr)
    }
    this.treesDirty = false
    this.treeFires = 0
    this.spreadCount = 0
    this.brandCount = 0
  }

  /** Hours a building's fire lasts, from its fuel. */
  burnDuration(b) {
    const q = (FIRE_LOAD[b.type] ?? 500) + (STRUCTURE_FUEL[b.construction] ?? 0)
    const perCompartment = q / ((RHR[b.type] ?? 0.25) * 3600)
    const climb = Math.min(4, 1 + 0.15 * (b.floors - 1)) // fire spreads up through the windows
    return perCompartment * climb * (0.75 + this.rng.next() * 0.5)
  }

  ignite(b, s) {
    s.burning = 1e-3
    s.burnDur = this.burnDuration(b)
    s.fireI = 0
  }

  /** Fire intensity 0..1: growth (t²), fully developed, decay once 70% of the fuel is gone. */
  intensity(t, dur) {
    const tg = Math.min(0.2, dur * 0.2)
    if (t < tg) return (t / tg) ** 2
    if (t > dur * 0.7) return clamp((dur - t) / (dur * 0.3), 0, 1)
    return 1
  }

  /** Emitting area of a burning building: its facade facing the target, flames up to ~3 storeys high. */
  facade(b, s, alongX) {
    const H = s.collapsed ? 3 : Math.min(b.height, 10)
    return { W: alongX ? b.fd : b.fw, H, q0: (isWood(b) ? 80 : 60) * s.fireI }
  }

  windFactor(fx, fz, tx, tz) {
    const d = Math.hypot(tx - fx, tz - fz) || 1
    const cos = ((tx - fx) * Math.cos(this.wind.dir) + (tz - fz) * Math.sin(this.wind.dir)) / d
    return clamp(1 + 0.12 * this.wind.speed * cos, 0.4, 2.2)
  }

  /**
   * Advance every fire by dtH hours. st: building states; ext(b): suppression
   * rate (per hour) by firefighters in reach; onIgnite(b, s, how) lights a building.
   */
  step(dtH, st, ext, onIgnite) {
    const { city, rng } = this
    const burning = []
    for (const b of city.buildings) {
      const s = st.get(b.id)
      if (!s || !s.burning) continue
      s.burning += dtH
      s.fireI = this.intensity(s.burning, s.burnDur)
      if (s.burning >= s.burnDur) {
        // fuel exhausted: the fire has burnt itself out
        s.burning = 0
        s.fireI = 0
        s.burnt = true
        continue
      }
      if (rng.chance(clamp(ext(b) * dtH, 0, 1))) {
        s.burning = 0
        s.fireI = 0
        s.extinguished = true
        continue
      }
      burning.push(b)
    }
    for (const b of burning) {
      const s = st.get(b.id)
      if (s.fireI < 0.05) continue
      this.radiate(b, s, st, dtH, onIgnite)
      this.embers(b, s, st, dtH, onIgnite, 1)
    }
    this.stepTrees(dtH, st, onIgnite)
    return burning
  }

  /** Radiant heat from a burning building to the buildings and trees around it. */
  radiate(b, s, st, dtH, onIgnite) {
    const { city, rng } = this
    const R = 4 // cells searched around the footprint (≈40 m)
    const seen = new Set()
    for (let j = b.y - R; j < b.y + b.d + R; j++)
      for (let i = b.x - R; i < b.x + b.w + R; i++) {
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
        const k = idx(i, j)
        const id = city.buildingAt[k]
        if (id >= 0 && id !== b.id && !seen.has(id)) {
          seen.add(id)
          const o = city.byId.get(id)
          const os = st.get(id)
          if (o && os && !os.burning && !os.burnt) {
            const gx = Math.max(0, Math.abs(o.cx - b.cx) - (o.fw + b.fw) / 2)
            const gz = Math.max(0, Math.abs(o.cz - b.cz) - (o.fd + b.fd) / 2)
            const f = this.facade(b, s, gx >= gz)
            const q = f.q0 * viewFactor(f.W, f.H, Math.hypot(gx, gz)) * this.windFactor(b.cx, b.cz, o.cx, o.cz)
            const qcr = (Q_CRIT[o.construction] ?? 25) * (os.ds >= 3 ? 0.8 : 1) // broken windows let heat in
            if (q > qcr && rng.chance(1 - Math.exp(-3 * (q / qcr - 1) * dtH))) {
              this.spreadCount++
              onIgnite(o, os, 'radiant')
            }
          }
        }
        for (const tr of this.treeCell.get(k) || []) {
          if (tr.fire || tr.burnt) continue
          const gx = Math.max(0, Math.abs(tr.x - b.cx) - b.fw / 2)
          const gz = Math.max(0, Math.abs(tr.z - b.cz) - b.fd / 2)
          const f = this.facade(b, s, gx >= gz)
          const q = f.q0 * viewFactor(f.W, f.H, Math.hypot(gx, gz)) * this.windFactor(b.cx, b.cz, tr.x, tr.z)
          if (q > TREE_QCRIT && rng.chance(1 - Math.exp(-4 * (q / TREE_QCRIT - 1) * dtH))) this.lightTree(tr)
        }
      }
  }

  /** Embers carried downwind. scale > 1 for the burning debris of a collapse. */
  embers(b, s, st, dtH, onIgnite, scale) {
    const { rng, wind } = this
    if (wind.speed < 2 && scale <= 1) return
    const rate = s.fireI * (isWood(b) ? 6 : 2) * (wind.speed / 5) ** 1.5 * Math.sqrt((b.fw * b.fd) / 100) * scale
    const n = rng.poisson(rate * dtH)
    for (let q = 0; q < n; q++) {
      const dist = 5 + -Math.log(1 - rng.next()) * 6 * Math.max(1.5, wind.speed)
      const ang = wind.dir + rng.normal() * 0.35
      this.land(b.cx + Math.cos(ang) * dist, b.cz + Math.sin(ang) * dist, st, onIgnite, 1)
    }
  }

  /** A burning ember or piece of debris lands at (x, z). */
  land(x, z, st, onIgnite, boost) {
    const { city, rng } = this
    this.brandCount++
    const HALF = (GRID * CELL) / 2
    if (Math.abs(x) >= HALF || Math.abs(z) >= HALF) return
    const k = idx(Math.floor((x + HALF) / CELL), Math.floor((z + HALF) / CELL))
    const id = city.buildingAt[k]
    if (id >= 0) {
      const o = city.byId.get(id)
      const os = st.get(id)
      if (o && os && !os.burning && !os.burnt) {
        const p = (BRAND_IGNITE[o.construction] ?? 0.02) * (os.ds >= 3 ? 1.5 : 1) * boost
        if (rng.chance(clamp(p, 0, 0.9))) onIgnite(o, os, 'embers')
      }
    }
    for (const tr of this.treeCell.get(k) || []) if (!tr.fire && !tr.burnt && Math.hypot(tr.x - x, tr.z - z) < 4 && rng.chance(0.12 * boost)) this.lightTree(tr)
  }

  /** A burning building came down: burning debris is flung around (and downwind of) it. */
  collapseBrands(b, st, onIgnite) {
    const { rng, wind } = this
    const n = 8 + b.floors * 2
    const r = 5 + b.height * 0.6
    for (let q = 0; q < n; q++) {
      const ang = rng.next() < 0.5 ? rng.float(0, Math.PI * 2) : wind.dir + rng.normal() * 0.6
      const d = Math.max(b.fw, b.fd) / 2 + rng.next() * r
      this.land(b.cx + Math.cos(ang) * d, b.cz + Math.sin(ang) * d, st, onIgnite, 2)
    }
  }

  lightTree(tr) {
    tr.fire = 1e-3
    tr.dur = 0.25 + this.rng.next() * 0.3
    this.treeFires++
    this.treesDirty = true
  }

  /** Trees burn quickly, light their neighbours and nearby wooden houses, then burn out. */
  stepTrees(dtH, st, onIgnite) {
    const { city, rng } = this
    for (const tr of this.trees) {
      if (!tr.fire) continue
      tr.fire += dtH
      const I = this.intensity(tr.fire, tr.dur)
      tr.I = I
      if (tr.fire >= tr.dur) {
        tr.fire = 0
        tr.I = 0
        tr.burnt = true
        tr.t.burnt = true
        this.treesDirty = true
        continue
      }
      if (I < 0.3) continue
      const ci = Math.floor((tr.x + (GRID * CELL) / 2) / CELL)
      const cj = Math.floor((tr.z + (GRID * CELL) / 2) / CELL)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (let i = ci - 1; i <= ci + 1; i++) {
          if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
          const k = idx(i, j)
          for (const o of this.treeCell.get(k) || []) {
            if (o.fire || o.burnt) continue
            const q = 50 * I * viewFactor(5, 8, Math.hypot(o.x - tr.x, o.z - tr.z) - 2.5) * this.windFactor(tr.x, tr.z, o.x, o.z)
            if (q > TREE_QCRIT && rng.chance(1 - Math.exp(-4 * (q / TREE_QCRIT - 1) * dtH))) this.lightTree(o)
          }
          const id = city.buildingAt[k]
          const b = id >= 0 ? city.byId.get(id) : null
          const s = b && st.get(id)
          if (!b || !s || s.burning || s.burnt) continue
          const gap = Math.hypot(Math.max(0, Math.abs(tr.x - b.cx) - b.fw / 2), Math.max(0, Math.abs(tr.z - b.cz) - b.fd / 2)) - 2
          const q = 50 * I * viewFactor(5, 8, gap) * this.windFactor(tr.x, tr.z, b.cx, b.cz)
          const qcr = (Q_CRIT[b.construction] ?? 25) * (s.ds >= 3 ? 0.8 : 1)
          if (q > qcr && rng.chance(1 - Math.exp(-3 * (q / qcr - 1) * dtH))) onIgnite(b, s, 'tree')
        }
    }
  }

  burningTrees() {
    return this.trees.filter((tr) => tr.fire > 0)
  }
}
