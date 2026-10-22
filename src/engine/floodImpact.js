// Human and structural impact of flooding, evaluated every few simulated
// minutes from the hydraulic state. Depth-damage curves, depth×velocity
// building failure, the evacuation plan's orders → evacuation → shelters,
// vertical evacuation in tall buildings and boat rescue by fire crews. On
// the coast, people drowned by seawater (the sea above their floor) count as
// storm-surge deaths.
//
// Evacuation: an order covers a zone (the coast below the forecast sea level,
// low ground by the river, light-material homes). Of the people in it, a
// share complies — more with plain-language warnings and drills, nearly all
// under a forced evacuation — and they leave at a rate set by how fast the
// order reaches them (sirens and radios) and how practised they are. People
// whose street floods leave on their own. Shelters take people at 3.5 m²
// each (the Sphere standard) and crowd up to 1.4 m² before turning them away.

import { GRID, CONSTRUCTION, BUILDING_TYPES } from './config.js'
import { occupancyAt, idx, residentsOf } from './cityGen.js'
import { clamp } from './math.js'

const LIGHT = ['wood_old', 'urm']
const CROWD = 2.5 // a shelter crowds up to this many times its Sphere capacity
// who works or studies away from home in the day
const DAYTIME = ['office', 'tower', 'industrial', 'school', 'civic', 'museum', 'library', 'worship', 'stadium', 'landmark']

export class FloodImpact {
  /**
   * warning: river gauges, sirens and radios (orders spread fast); surgeWarning: plain-language surge warnings;
   * drills: practised communities; surgeZone: how high above mean sea level the coastal zone reaches (m).
   */
  constructor(city, sim, { warning = false, surgeWarning = false, drills = false, startHour = 8, signal = () => 0, surgeZone = 0, rng }) {
    this.city = city
    this.sim = sim
    this.warningSystem = warning
    this.surgeWarning = surgeWarning
    this.drills = drills
    this.signal = signal // PAGASA wind signal in force over the city
    this.rng = rng
    this.coast = city.coast ?? null
    this.surgeZone = surgeZone
    this.warned = false
    this.warnTime = null
    // the plan's evacuation orders by zone: { since (s), forced }
    this.orders = {}
    this.forced = false
    this.boatsSafe = false
    this.crowdHours = 0 // person-hours in shelters beyond their Sphere capacity
    this.events = []
    this.leftArea = 0
    this.rescued = 0
    // mangroves break the waves riding on a surge: the share of wave attack that gets through, by column
    this.waveThrough = new Float32Array(GRID).fill(1)
    if (city.mangrove)
      for (let i = 0; i < GRID; i++) {
        let w = 0
        for (let j = 0; j < GRID; j++) if (city.mangrove[idx(i, j)]) w += 10
        this.waveThrough[i] = 1 - Math.min(0.8, w / 300)
      }
    this.deathsByCause = { drowning: 0, collapse: 0, evacuation: 0, roof: 0, wind: 0, surge: 0, tornado: 0, fire: 0 }
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
        start: present,
        gone: 0, // left under an order
      })
    }
    this.shelters = city.buildings.filter((b) => !b.removed && b.type === 'shelter')
  }

  log(text, level = 'info') {
    this.events.push({ t: this.sim.time, text, level })
  }

  /** Is the city flooding (the trigger of a late, emergency evacuation)? */
  flooding() {
    let flooded = 0
    for (const b of this.city.buildings) if ((this.st.get(b.id)?.dIn ?? 0) > 0.3) flooded++
    return this.sim.stage > -0.2 || flooded > this.city.buildings.length * 0.03 || (!!this.coast && this.sim.seaRise > 1.5)
  }

  /** The zones a building is in: 'coast' (below the forecast sea level + 1 m), 'river' (low ground by the river), 'light' (light-material homes). */
  zonesOf(b) {
    const z = []
    if (this.coast && b.groundZ < this.coast.msl + this.surgeZone + 1) z.push('coast')
    if (b.groundZ < this.city.bankZ[b.y] + 3) z.push('river')
    if (b.type === 'house' && LIGHT.includes(b.construction)) z.push('light')
    return z
  }

  /** Share of a zone that complies with an order: forced moves nearly everyone; warnings people understand and drills raise it. */
  compliance(zone) {
    if (this.forced) return 0.95
    let c = zone === 'coast' ? (this.surgeWarning ? 0.85 : 0.45) : zone === 'light' ? 0.6 : 0.65
    if (this.drills) c += 0.1
    return Math.min(0.95, c)
  }

  /** How fast people leave once ordered (per hour): sirens and radios reach everyone, drilled communities move. */
  evacRate() {
    return (this.warningSystem ? 0.35 : 0.15) * (this.drills ? 1.4 : 1) * (this.forced ? 1.5 : 1)
  }

  /**
   * An evacuation order for a zone, given `head` hours ago (an order issued
   * before the simulation began has already moved people out).
   */
  order(zone, head = 0) {
    if (this.orders[zone]) return
    this.orders[zone] = { since: this.sim.time - head * 3600 }
    if (!this.warned) {
      this.warned = true
      this.warnTime = this.sim.time
    }
    if (head > 0) this.moveOut((b) => this.zonesOf(b).includes(zone), head)
  }

  /** Forced evacuation: everyone still in an ordered zone is moved. */
  force() {
    this.forced = true
    if (!this.warned) {
      this.warned = true
      this.warnTime = this.sim.time
    }
  }

  /** Move people out of the buildings that qualify, as if they'd had `hours` to go. */
  moveOut(pick, hours) {
    for (const b of this.city.buildings) {
      const s = this.st.get(b.id)
      if (!s || !pick(b) || b.type === 'shelter') continue
      const zone = this.zonesOf(b).find((z) => this.orders[z]) ?? 'river'
      const want = this.compliance(zone) * s.start - s.gone
      const go = Math.min(s.present, Math.max(0, want) * (1 - Math.exp(-this.evacRate() * hours)))
      if (go <= 0) continue
      s.present -= go
      s.evacuated += go
      s.gone += go
      this.placeEvacuees(go, this.openShelters())
    }
  }

  /** Classes and work suspended: people in offices, schools and the like go home. */
  closeSchools() {
    let moved = 0
    const homes = this.city.buildings.filter((b) => residentsOf(b) > 0)
    const room = homes.reduce((a, b) => a + residentsOf(b), 0) || 1
    for (const b of this.city.buildings) {
      if (!DAYTIME.includes(b.type)) continue
      const s = this.st.get(b.id)
      if (!s) continue
      const go = s.present * 0.9
      s.present -= go
      s.start -= go
      moved += go
    }
    // they arrive home in proportion to who lives where; some live outside the district
    for (const b of homes) {
      const s = this.st.get(b.id)
      if (!s) continue
      const add = moved * 0.6 * (residentsOf(b) / room)
      s.present += add
      s.start += add
    }
    return moved
  }

  openShelters() {
    return this.shelters.filter((b) => {
      const s = this.st.get(b.id)
      return s && !s.collapsed && s.dIn < 0.3 && !s.roofless
    })
  }

  update(dtH) {
    const { city, sim, rng } = this
    const h = sim.h
    const zg = sim.zg

    // ---------------- shelter capacity
    const openShelters = this.openShelters()
    for (const b of this.shelters) {
      const s = this.st.get(b.id)
      if (s) this.crowdHours += Math.max(0, s.present - b.capacity) * dtH
    }

    // ---------------- rescue capacity (boats from fire stations; staged at the shelters, a flooded station doesn't trap them)
    let rescueCap = 0
    for (const b of city.buildings) {
      if (b.type !== 'fire' || b.removed) continue
      const s = this.st.get(b.id)
      if (s && (this.boatsSafe || s.dIn < 1)) rescueCap += 25 * dtH
    }
    const rate = this.evacRate()

    const risky = []
    for (const b of city.buildings) {
      if (b.removed) continue
      const s = this.st.get(b.id)
      if (!s) continue
      // water at the building
      let eta = 0
      let dOut = 0
      let v = 0
      let salty = false
      const n = b.w * b.d
      for (let j = b.y; j < b.y + b.d; j++)
        for (let i = b.x; i < b.x + b.w; i++) {
          const k = idx(i, j)
          eta += zg[k] + h[k]
          dOut += h[k]
          v += sim.velocityAt(i, j)
          if (sim.salt?.[k]) salty = true
        }
      eta /= n
      dOut /= n
      v /= n
      const dIn = Math.max(0, eta - (b.floorZ + b.elevated))
      s.dIn = dIn
      // the sea has flowed in around it (FloodSim.salt): this is seawater
      if (salty && dIn > 0.1) s.sea = true
      s.dOut = dOut
      s.v = v
      if (dIn > s.maxIn) s.maxIn = dIn
      if (s.present <= 0.01 && s.collapsed) continue

      // ---- structural failure: depth × velocity (Clausen & Clark style) or buoyancy
      const C = CONSTRUCTION[b.construction]
      if (!s.collapsed && b.floors <= 3) {
        // on the beachfront, waves riding on the surge hit far harder than the current (~½√(g·d), fading inland)
        let vw = 0
        if (s.sea && dOut > 0.3) vw = 0.5 * Math.sqrt(9.81 * dOut) * Math.exp(-((this.coast.shore[b.x] - b.y - b.d) * 10) / 80) * this.waveThrough[b.x]
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

      // ---- evacuation: under an order, until the complying share has gone; on their own once the street floods
      let r = 0
      let want = 0
      for (const z of this.zonesOf(b)) {
        if (!this.orders[z]) continue
        r = rate
        want = Math.max(want, this.compliance(z) * s.start - s.gone)
      }
      if (dOut > 0.15) {
        r = Math.max(r, 0.12)
        want = Math.max(want, s.present * 0.9)
      }
      if (b.floors >= 4) r *= 0.15 // vertical evacuation: people move upstairs
      // a shelter's people move on only if it floods or loses its roof
      if (b.type === 'shelter') {
        r = dIn > 0.3 || s.roofless ? 0.4 : 0
        want = s.present
      }
      if (b.type === 'hospital') r *= 0.3
      if (r > 0 && want > 0 && dOut < 1.0) {
        if (!openShelters.length) r *= 0.6
        const moving = Math.min(s.present, want) * (1 - Math.exp(-r * dtH))
        if (moving > 0) {
          s.gone += moving
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
        // only real water against the wall counts (not a dry neighbour, or the top of a shut river gate)
        if (city.levee[kk] > 0 || sim.h[kk] < 0.05 || sim.gate?.cells.includes(kk)) continue
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

  /** Evacuees fill the shelters to their Sphere capacity first, then crowd them; the rest leave the district on their own. */
  placeEvacuees(n, shelters) {
    let rem = n
    for (const crowd of [1, CROWD])
      for (const b of shelters) {
        if (rem <= 0) break
        const s = this.st.get(b.id)
        const room = b.capacity * crowd - s.present
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
      if (s.collapsed || s.burnt) destroyed++
      // wind damage (WindDamage sets this.wind): a lost roof lets the rain in and the home is unlivable
      const w = this.wind?.st.get(b.id)
      if (s.maxIn > 0.5 || s.collapsed || s.burnt || w?.roof) displaced += b.residents
      if (s.dIn > 0.5) atRisk += s.present
      const share = Math.min(1, Math.ceil(s.maxIn / b.floorH) / b.floors)
      const windF = !w ? 0 : w.roof ? 0.3 : w.cover ? 0.1 : w.glass ? 0.04 : 0
      const f = s.collapsed || s.burnt ? 1 : Math.max(windF, Math.min(1, 0.33 * Math.sqrt(s.maxIn)) * share)
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
