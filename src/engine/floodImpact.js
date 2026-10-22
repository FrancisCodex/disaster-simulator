// Human and structural impact of flooding, evaluated every few simulated
// minutes from the hydraulic state. Depth-damage curves, depth×velocity
// building failure, warning → evacuation → shelter flow, vertical evacuation
// in tall buildings and boat rescue by fire crews. On the coast, people
// drowned by seawater (the sea above their floor) count as storm-surge deaths.

import { GRID, CONSTRUCTION, BUILDING_TYPES } from './config.js'
import { occupancyAt, idx } from './cityGen.js'
import { clamp } from './math.js'

export class FloodImpact {
  /** surgeZone: on the coast, how high above mean sea level the evacuation zone reaches (m; the forecast sea level). */
  constructor(city, sim, { warning = false, startHour = 8, signal = () => 0, surgeZone = 0, rng }) {
    this.city = city
    this.sim = sim
    this.warningSystem = warning
    this.signal = signal // PAGASA wind signal in force over the city
    this.rng = rng
    this.coast = city.coast ?? null
    this.surgeZone = surgeZone
    this.warned = false
    this.warnTime = null
    this.events = []
    this.leftArea = 0
    this.rescued = 0
    this.deathsByCause = { drowning: 0, collapse: 0, evacuation: 0, roof: 0, wind: 0, surge: 0 }
    this.deathsByType = {}
    this.st = new Map()
    this.population = 0
    for (const b of city.buildings) {
      if (b.removed) continue
      const present = occupancyAt(b, startHour)
      this.population += present
      this.st.set(b.id, {
        present,
        dead: 0,
        injured: 0,
        evacuated: 0,
        dIn: 0,
        dOut: 0,
        v: 0,
        maxIn: 0,
        collapsed: false,
        offline: false,
        sea: false, // seawater got into it
      })
    }
    this.shelters = city.buildings.filter((b) => !b.removed && b.type === 'shelter')
  }

  log(text, level = 'info') {
    this.events.push({ t: this.sim.time, text, level })
  }

  update(dtH) {
    const { city, sim, rng } = this
    const h = sim.h
    const zg = sim.zg

    // ---------------- official warning
    if (!this.warned) {
      let flooded = 0
      for (const b of city.buildings) {
        const s = this.st.get(b.id)
        if (s && s.dIn > 0.3) flooded++
      }
      const early = this.warningSystem && (this.signal() >= 3 || sim.stage > -1.8)
      const surge = this.coast && sim.seaRise > 1.5
      const late = sim.stage > -0.2 || flooded > city.buildings.length * 0.03 || surge
      if (early || late) {
        this.warned = true
        this.warnTime = sim.time
        this.log(
          early
            ? `Pre-emptive evacuation ordered under the typhoon plan: low-lying${this.coast ? ', coastal' : ''} and riverside districts are moving to shelters.`
            : surge && !flooded
              ? 'Emergency evacuation ordered: the sea is rising over the beach (late: the surge is already arriving).'
              : 'Emergency flood warning issued — evacuation ordered (late: flooding already under way).',
          'warn',
        )
      }
    }
    const zoneMargin = this.warningSystem ? 4 : 2.5

    // ---------------- shelter capacity
    const openShelters = this.shelters.filter((b) => {
      const s = this.st.get(b.id)
      return s && !s.collapsed && s.dIn < 0.3
    })

    // ---------------- rescue capacity (boats from fire stations)
    let rescueCap = 0
    for (const b of city.buildings) {
      if (b.type !== 'fire' || b.removed) continue
      const s = this.st.get(b.id)
      if (s && s.dIn < 1) rescueCap += 25 * dtH
    }

    const risky = []
    for (const b of city.buildings) {
      if (b.removed) continue
      const s = this.st.get(b.id)
      if (!s) continue
      // water at the building
      let eta = 0
      let dOut = 0
      let v = 0
      const n = b.w * b.d
      for (let j = b.y; j < b.y + b.d; j++)
        for (let i = b.x; i < b.x + b.w; i++) {
          const k = idx(i, j)
          eta += zg[k] + h[k]
          dOut += h[k]
          v += sim.velocityAt(i, j)
        }
      eta /= n
      dOut /= n
      v /= n
      const dIn = Math.max(0, eta - (b.floorZ + b.elevated))
      s.dIn = dIn
      // the sea stands above the floor: this is seawater
      if (this.coast && dIn > 0.1 && sim.seaZ > b.floorZ + b.elevated) s.sea = true
      s.dOut = dOut
      s.v = v
      if (dIn > s.maxIn) s.maxIn = dIn
      if (s.present <= 0.01 && s.collapsed) continue

      // ---- structural failure: depth × velocity (Clausen & Clark style) or buoyancy
      const C = CONSTRUCTION[b.construction]
      if (!s.collapsed && b.floors <= 3) {
        // on the beachfront, waves riding on the surge hit far harder than the current (~½√(g·d), fading inland)
        let vw = 0
        if (s.sea && dOut > 0.3) vw = 0.5 * Math.sqrt(9.81 * dOut) * Math.exp(-((this.coast.shore[b.x] - b.y - b.d) * 10) / 80)
        const dv = dOut * Math.max(v + vw, 0.3)
        const buoy = (b.construction === 'wood_old' || b.construction === 'wood_mod') && dIn > 2.6
        if (dv > C.floodDV || buoy) {
          if (rng.chance(clamp(dtH * 2, 0, 1))) {
            s.collapsed = true
            const dead = s.present * 0.35
            this.kill(b, s, dead, 'collapse')
            s.injured += s.present * 0.2
            s.present -= s.present * 0.2
            if (dead >= 1 || b.floors > 1) this.log(s.sea ? `${BUILDING_TYPES[b.type].name} smashed by storm-surge waves (${dOut.toFixed(1)} m of seawater).` : `${BUILDING_TYPES[b.type].name} swept away by floodwater (${dOut.toFixed(1)} m deep, ${v.toFixed(1)} m/s).`, 'bad')
            this.events.push({ t: sim.time, collapse: b.id })
          }
        }
      }
      if (b.type === 'hospital' && !s.offline && dIn > 0.5) {
        s.offline = true
        this.log('Hospital ground floor flooded — emergency department out of service.', 'bad')
      }
      if (s.present <= 0.01) continue

      // ---- evacuation
      let inZone = b.groundZ < city.bankZ[b.y] + zoneMargin
      // the coastal zone: below the forecast sea level under the plan; otherwise only the beachfront leaves
      if (this.coast) inZone ||= b.groundZ < this.coast.msl + (this.warningSystem ? this.surgeZone + 1 : 1.5)
      let rate = 0
      if (this.warned && inZone) rate = this.warningSystem ? 0.35 : 0.15
      // the typhoon plan also moves families out of light-material homes, wherever they are
      if (this.warned && this.warningSystem && b.type === 'house' && (b.construction === 'wood_old' || b.construction === 'urm')) rate = Math.max(rate, 0.3)
      if (dOut > 0.15) rate = Math.max(rate, 0.12)
      if (b.floors >= 4) rate *= 0.15 // vertical evacuation: people move upstairs
      if (b.type === 'shelter') rate = dIn > 0.3 ? 0.2 : 0
      if (b.type === 'hospital') rate *= 0.3
      if (rate > 0 && dOut < 1.0) {
        if (!openShelters.length) rate *= 0.6
        const moving = s.present * (1 - Math.exp(-rate * dtH))
        if (moving > 0) {
          if (dOut > 0.3) {
            // wading through moving water is the deadliest part of a flood
            const m = clamp(0.012 * dOut * (v + 0.5), 0, 0.25)
            this.kill(b, s, moving * m, 'evacuation')
          }
          const go = Math.min(moving, s.present)
          s.present -= go
          s.evacuated += go
          this.placeEvacuees(go, openShelters)
        }
      }

      // ---- people sheltering in place
      // in a home the wind has flattened there is no upper floor to climb to: water over ~0.6 m reaches people in the rubble
      const refuge = s.collapsed ? 2.2 : b.floors * b.floorH - 0.5 + (b.type === 'house' ? 1 : 0)
      const exposure = dIn - (refuge - 1.6)
      if (exposure > 0 || (dIn > 1 && v > 1.5 && b.floors <= 2)) {
        const rateD = 0.03 + 0.4 * clamp(exposure / 1.6, 0, 1)
        this.kill(b, s, s.present * (1 - Math.exp(-rateD * dtH)), 'drowning')
        risky.push({ b, s, danger: exposure })
      } else if (dIn > 0.5 && b.floors <= 2) {
        risky.push({ b, s, danger: dIn - refuge })
      }
      if (dIn > 0.3) {
        const inj = s.present * 0.003 * dtH
        s.injured += inj
      }
    }

    // ---------------- boat rescue: most endangered first
    if (rescueCap > 0 && risky.length) {
      risky.sort((a, b) => b.danger - a.danger)
      for (const r of risky) {
        if (rescueCap <= 0) break
        const n = Math.min(r.s.present, rescueCap)
        r.s.present -= n
        r.s.evacuated += n
        this.rescued += n
        rescueCap -= n
        this.placeEvacuees(n, openShelters)
      }
    }
  }

  /** Levees fail when water reaches their crest (overtopping erodes the back slope). */
  updateLevees(dtH) {
    const { city, sim, rng } = this
    const N = GRID
    let breached = false
    if (!this.leveeCells) {
      this.leveeCells = []
      for (let k = 0; k < N * N; k++) if (city.levee[k] > 0) this.leveeCells.push(k)
    }
    for (const k of this.leveeCells) {
      if (city.levee[k] <= 0) continue
      const crest = sim.zg[k]
      const i = k % N
      const j = (k - i) / N
      let eta = -Infinity
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di
        const jj = j + dj
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
        const kk = jj * N + ii
        if (city.levee[kk] > 0) continue
        eta = Math.max(eta, sim.zg[kk] + sim.h[kk])
      }
      if (eta < crest - 0.3) continue
      const p = eta > crest ? 0.12 : 0.015
      if (rng.chance(clamp(p * dtH, 0, 1))) {
        city.levee[k] = 0
        sim.zg[k] = city.z[k]
        breached = true
      }
    }
    if (breached) {
      this.leveeDirty = true
      if (!this.lastBreachLog || sim.time - this.lastBreachLog > 1800) {
        this.lastBreachLog = sim.time
        this.log('Levee breach! Water is pouring through a failed section of flood wall.', 'bad')
      }
    }
  }

  placeEvacuees(n, shelters) {
    let rem = n
    for (const b of shelters) {
      if (rem <= 0) break
      const s = this.st.get(b.id)
      const room = b.capacity - s.present
      if (room <= 0) continue
      const take = Math.min(room, rem)
      s.present += take
      rem -= take
    }
    this.leftArea += rem
  }

  kill(b, s, n, cause) {
    n = Math.min(n, s.present)
    if (n <= 0) return
    s.present -= n
    s.dead += n
    s.injured += n * 0.4
    if (s.sea && (cause === 'drowning' || cause === 'collapse' || cause === 'evacuation')) cause = 'surge'
    this.deathsByCause[cause] += n
    this.deathsByType[b.type] = (this.deathsByType[b.type] || 0) + n
  }

  totals() {
    let dead = 0
    let injured = 0
    let flooded = 0
    let destroyed = 0
    let loss = 0
    let displaced = 0
    let atRisk = 0
    for (const b of this.city.buildings) {
      const s = this.st.get(b.id)
      if (!s) continue
      dead += s.dead
      injured += s.injured
      if (s.maxIn > 0.3) flooded++
      if (s.collapsed) destroyed++
      // wind damage (WindDamage sets this.wind): a lost roof lets the rain in and the home is unlivable
      const w = this.wind?.st.get(b.id)
      if (s.maxIn > 0.5 || s.collapsed || w?.roof) displaced += b.residents
      if (s.dIn > 0.5) atRisk += s.present
      const share = Math.min(1, Math.ceil(s.maxIn / b.floorH) / b.floors)
      const windF = !w ? 0 : w.roof ? 0.3 : w.cover ? 0.1 : w.glass ? 0.04 : 0
      const f = s.collapsed ? 1 : Math.max(windF, Math.min(1, 0.33 * Math.sqrt(s.maxIn)) * share)
      loss += b.value * f
    }
    for (let k = 0; k < GRID * GRID; k++) if (this.city.levee[k] > 0 && this.sim.maxH[k] > 0.3) loss += 0.02
    return { dead, injured, flooded, destroyed, loss, displaced, atRisk, evacuated: this.leftArea + this.shelteredCount(), rescued: this.rescued }
  }

  shelteredCount() {
    let n = 0
    for (const b of this.shelters) n += this.st.get(b.id)?.present ?? 0
    return n
  }
}
