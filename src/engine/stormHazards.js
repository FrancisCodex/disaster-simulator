// Thunderstorms in a typhoon: lightning and tornadoes over the district.
//
// Lightning. The inner core of a mature typhoon is electrically quiet: high
// wind, little lightning. Flashes come from the convective cells of the
// outer rainbands, and in bursts from the eyewall while the storm is
// intensifying (a known precursor of rapid intensification). The flash rate
// here follows the convective rain of the bands, damped inside ~1.5 Rmax.
// About a quarter of flashes reach the ground. A cloud-to-ground strike lands
// where the electrogeometric ("rolling sphere") model puts it: the leader
// comes down vertically and connects to the first object within the
// striking distance R ≈ 45 m (the NFPA 780 / IEC 62305 radius), so towers,
// lone trees and poles take most strikes and the ground in their lee is
// shielded. A strike can set a building or tree alight (rain puts most of
// those fires out), blow a transformer or kill the lights.
//
// Tornadoes (TC tornadoes). About 90% form in the front-right quadrant
// relative to the storm's motion (340°–120°, Schultz & Cecil 2009; the
// front-left in the southern hemisphere), mostly 200–400 km from the centre in
// outer-band cells, and most around and after landfall, when land friction
// raises low-level shear. Most are EF0–EF1, short and narrow. The rate here
// gives a strong landfalling storm about ten across its whole region, which
// makes one crossing a 1 km district a rare event; a what-if setting sends
// one through anyway. Its wind is a Rankine vortex (solid-body core, 1/r
// outside) carried along with the rainband, added to the typhoon's own wind.
//
// Units: km and hours at storm scale, metres and m/s in the district.
// World axes: x east, z south. No three.js.

import { GRID, CELL } from './config.js'
import { structure, fieldAt, GUST_LAND } from './typhoonPhysics.js'
import { clamp, smoothstep } from './math.js'

export const STRIKE_R = 45 // m, striking distance of the rolling sphere
export const CG_SHARE = 0.25 // share of flashes that reach the ground
const HALF = (GRID * CELL) / 2
const DEG = Math.PI / 180

// Enhanced Fujita: 3-s gust (m/s) at the centre of each rating, core radius (m) and track length (km)
export const EF = [
  { n: 0, gust: 33, rc: 20, km: 1.5, name: 'EF0', kmh: '105–137' },
  { n: 1, gust: 44, rc: 35, km: 3, name: 'EF1', kmh: '138–177' },
  { n: 2, gust: 55, rc: 50, km: 5, name: 'EF2', kmh: '178–217' },
]
// share of TC tornadoes by rating (most are weak)
const EF_SHARE = [0.55, 0.33, 0.12]

// ------------------------------------------------------------------ lightning
/**
 * Flashes per km² per hour (all kinds) at the district from the storm field
 * f (fieldAt), intensifying: how fast the storm's peak wind is rising (m/s per hour).
 */
export function flashRate(f, intensifying = 0) {
  const x = f.r / f.rmax
  const conv = smoothstep(4, 45, f.rain)
  // the inner core is electrically quiet; the bands' cells carry the charge
  const outer = smoothstep(1.4, 3, x)
  const band = clamp((f.band - 0.6) / 2.5, 0, 1)
  // eyewall bursts while the storm deepens
  const burst = 2 * clamp(intensifying / 3, 0, 1) * Math.exp(-(((x - 1.1) / 0.35) ** 2))
  return 3 * conv * outer * (0.35 + 0.65 * band) + burst * conv
}

/**
 * Where a cloud-to-ground strike over (x0, z0) attaches (the rolling sphere):
 * the candidate whose top is reached first by a leader coming straight down,
 * i.e. the highest top + √(R² − d²). cands: [{ x, z, y (top, m), r (half-width, m), kind, ref }].
 */
export function strikePoint(x0, z0, groundY, cands, R = STRIKE_R) {
  let best = { kind: 'ground', x: x0, z: z0, y: groundY, ref: null }
  let bestReach = groundY + R
  for (const c of cands) {
    const d = Math.max(0, Math.hypot(c.x - x0, c.z - z0) - c.r)
    if (d >= R) continue
    const reach = c.y + Math.sqrt(R * R - d * d)
    if (reach > bestReach) {
      bestReach = reach
      best = c
    }
  }
  return best
}

// ------------------------------------------------------------------ tornadoes
/**
 * Tornado genesis per km² per hour near the district at τ (storm scale): the
 * quadrant, distance and landfall weights of the TC-tornado climatology.
 */
export function tornadoDensity(s, tau, st = structure(s, tau)) {
  const [cx, cy] = s.pos(tau)
  const r = Math.hypot(cx, cy)
  if (r < 1) return 0
  // bearing of the district from the centre, measured from the direction of motion, clockwise (to the right) in the north
  const ang = Math.atan2(-cy, -cx) - Math.atan2(s.u[1], s.u[0])
  const right = (-Math.atan2(Math.sin(ang), Math.cos(ang)) * s.hemi) / DEG // degrees, + to the right of motion
  const quad = right >= -20 && right <= 120 ? 1 : 0.1
  const radial = Math.exp(-(((r - 280) / 130) ** 2)) + 0.35 * Math.exp(-(((r - 60) / 50) ** 2))
  const land = s.overLand(tau) ? 1 + 2 * Math.exp(-(tau - s.landfall) / 12) : 0.3
  const strong = smoothstep(25, 55, st.vmax)
  return 2.5e-6 * quad * radial * land * strong
}

/** Expected tornadoes within 50 km of the district and the chance one crosses it, over τ0…τ1. */
export function tornadoOutlook(s, tau0, tau1) {
  let near = 0
  let hit = 0
  for (let tau = tau0; tau <= tau1; tau += 0.25) {
    const d = tornadoDensity(s, tau)
    near += d * Math.PI * 50 * 50 * 0.25
    // a track 3 km long and ~0.1 km wide crosses a 1 km district if it starts in ~(3 + 1)·(0.1 + 1) km²
    hit += d * 4.4 * 0.25
  }
  return { near, hit: 1 - Math.exp(-hit) }
}

/** Expected cloud-to-ground strikes in the district and flashes seen within ~10 km, over τ0…τ1. */
export function lightningOutlook(s, tau0, tau1) {
  let cg = 0
  let seen = 0
  for (let tau = tau0; tau <= tau1; tau += 0.25) {
    const f = fieldAt(s, tau)
    const rate = flashRate(f, Math.max(0, s.vmax(tau + 0.5) - s.vmax(tau - 0.5)))
    cg += rate * CG_SHARE * 0.25
    seen += rate * 314 * 0.25
  }
  return { cg, seen }
}

/** Tornado wind (m/s) at (x, z) world: { vx, vz } from a vortex at (tx, tz) moving at (mx, mz). */
export function vortexWind(tor, x, z, tx, tz) {
  const dx = x - tx
  const dz = z - tz
  const r = Math.max(0.5, Math.hypot(dx, dz))
  const vt = r < tor.rc ? (tor.vrot * r) / tor.rc : (tor.vrot * tor.rc) / r
  // cyclonic: anticlockwise seen from above in the north (x east, z south → clockwise in x–z), turned 30° inward
  const s = tor.hemi
  const tx_ = (dz / r) * s
  const tz_ = (-dx / r) * s
  const c = Math.cos(30 * DEG)
  const i = Math.sin(30 * DEG)
  return { vx: tor.mx + vt * (tx_ * c - (dx / r) * i), vz: tor.mz + vt * (tz_ * c - (dz / r) * i) }
}

/**
 * The thunderstorm hazards over the district during a typhoon. Call update()
 * every simulated minute; it returns events (strikes, tornado warnings and
 * touchdowns) and keeps the live tornado, if any.
 */
export class StormHazards {
  /** ty: the TyphoonSim; mode: 'natural' | 'ef1' | 'ef2' (a what-if tornado through the city); centre: the city's centre (world m). */
  constructor(ty, { rng, mode = 'natural', centre = { x: 0, z: 0 } }) {
    this.ty = ty
    this.rng = rng
    this.mode = mode
    this.centre = centre
    this.events = []
    this.strikes = 0
    this.flashes = 0
    this.nearTornadoes = 0
    this.tornado = null
    this.tornadoes = []
    this.flags = {}
    // a what-if tornado comes when the climatology says it is likeliest
    this.forcedAt = mode === 'natural' ? null : this.pickTime()
  }

  log(text, level = 'info') {
    this.events.push({ t: this.time, text, level })
  }

  /**
   * Simulation time (s) for a what-if tornado: drawn from the hazard while a
   * rainband is over the city (a tornado needs a storm cell overhead), in the
   * outer bands ahead of the core, and while its winds stand out above the
   * typhoon's own (in a super typhoon's eyewall an EF2 would add nothing).
   */
  pickTime() {
    const ty = this.ty
    const s = ty.storm
    const ef = EF[this.mode === 'ef2' ? 2 : 1]
    const from = ty.startH + 0.5
    // the outer bands ahead of the core, up to landfall: when TC tornadoes are reported most
    const to = Math.max(from + 1, Math.min(ty.fc.endH - 1, 1))
    const w = []
    let sum = 0
    for (let tau = from; tau <= to; tau += 0.25) {
      const f = fieldAt(s, tau)
      const d = tornadoDensity(s, tau) * smoothstep(2, 15, f.rain) * smoothstep(0, 15, ef.gust - f.wind * GUST_LAND)
      w.push([tau, d])
      sum += d
    }
    let tau
    if (sum > 0) {
      let r = this.rng.next() * sum
      for (const [t, d] of w) if ((r -= d) <= 0) {
        tau = t
        break
      }
    } else {
      // no tornado weather at all here: the busiest rainbands before the core
      let best = -1
      for (let t = from; t <= Math.min(to, 0); t += 0.25) {
        const f = fieldAt(s, t)
        const v = f.rain * smoothstep(1.4, 3, f.r / f.rmax) * smoothstep(0, 15, ef.gust - f.wind * GUST_LAND)
        if (v > best) {
          best = v
          tau = t
        }
      }
      tau ??= from + 1
    }
    return Math.max(600, (tau - ty.startH) * 3600)
  }

  /** Advance to simulation time t (s) over dt seconds. ctx: { cands(x0, z0) → strike candidates, groundAt(x, z), rain } */
  update(t, dt, ctx) {
    this.time = t
    this.gusts = null
    const ty = this.ty
    const s = ty.storm
    const tau = ty.tau(t)
    const st = structure(s, tau)
    const f = fieldAt(s, tau, 0, 0, st)
    const dvdt = s.vmax(tau + 0.5) - s.vmax(tau - 0.5)
    const rate = flashRate(f, Math.max(0, dvdt))
    this.rate = rate
    this.flashes += rate * 314 * (dt / 3600)
    // ---- cloud-to-ground strikes in the district (1 km²)
    const n = this.rng.poisson(rate * CG_SHARE * (dt / 3600))
    for (let q = 0; q < n; q++) {
      const x0 = this.rng.float(-HALF, HALF)
      const z0 = this.rng.float(-HALF, HALF)
      const hit = strikePoint(x0, z0, ctx.groundAt(x0, z0), ctx.cands(x0, z0))
      this.strikes++
      this.events.push({ t, strike: hit })
    }
    if (!this.flags.lightning && rate > 0.8) {
      this.flags.lightning = true
      this.log(`Thunderstorms in the outer rainbands: lightning every few seconds around ${ty.place}. Stay indoors and away from windows, tall trees and metal.`, 'warn')
    }
    if (!this.flags.burst && dvdt > 1.5 && f.r < 4 * f.rmax && rate > 0.3) {
      this.flags.burst = true
      this.log('A lightning burst in the eyewall: the storm is intensifying as it approaches.', 'warn')
    }

    // ---- tornadoes: reports around the region, and the rare one that crosses the city
    const dens = tornadoDensity(s, tau, st)
    if (this.rng.chance(1 - Math.exp(-dens * Math.PI * 50 * 50 * (dt / 3600)))) this.reportNear(f)
    const hitRate = dens * 4.4 * (dt / 3600)
    if (!this.tornado && !this.tornadoes.length) {
      if (this.forcedAt != null && t >= this.forcedAt) this.spawn(EF[this.mode === 'ef2' ? 2 : 1], f, t)
      else if (this.forcedAt == null && this.rng.chance(hitRate)) this.spawn(this.drawEF(), f, t)
    }
    if (this.tornado) this.advanceTornado(t, dt)
    return this.events
  }

  drawEF() {
    let r = this.rng.next()
    for (let n = 0; n < EF.length; n++) if ((r -= EF_SHARE[n]) <= 0) return EF[n]
    return EF[0]
  }

  /** A tornado reported somewhere within 50 km. */
  reportNear(f) {
    this.nearTornadoes++
    if (this.nearTornadoes > 3) return
    const d = Math.round(8 + this.rng.next() * 42)
    const ef = this.drawEF()
    const pts = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
    this.log(`Tornado reported ${d} km ${pts[Math.floor(this.rng.next() * 8)]} of the city in an outer rainband (${ef.name}). ${f.rain > 10 ? 'More cells are crossing this area.' : ''}`.trim(), 'warn')
  }

  /** A tornado touches down upwind and crosses the city with its rainband. */
  spawn(ef, f, t) {
    const rng = this.rng
    // cells drift with the low-level flow (world x east, z south)
    const wx = f.dir[0]
    const wz = -f.dir[1]
    const speed = 12 + rng.next() * 6
    const L = ef.km * 1000 * (0.8 + 0.4 * rng.next())
    // a crossing point near the centre of town; the track runs L metres along the drift
    const px = clamp(this.centre.x + rng.float(-180, 180), -HALF + 80, HALF - 80)
    const pz = clamp(this.centre.z + rng.float(-180, 180), -HALF + 80, HALF - 80)
    const back = L * (0.35 + 0.3 * rng.next())
    const vtrans = speed
    this.tornado = {
      ef,
      rc: ef.rc,
      vrot: ef.gust - vtrans,
      hemi: this.ty.storm.hemi,
      mx: wx * speed,
      mz: wz * speed,
      x0: px - wx * back,
      z0: pz - wz * back,
      t0: t + 240, // the warning comes a few minutes ahead
      dur: L / speed,
      len: L,
      damaged: 0,
      warned: false,
      down: false,
    }
    this.tornadoes.push(this.tornado)
    const from = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][((Math.round((Math.atan2(-wx, wz) / (Math.PI * 2)) * 8) % 8) + 8) % 8]
    this.log(`TORNADO WARNING: a tornado has formed in a rainband ${Math.round(back / 100) / 10} km ${from} of the city centre and is heading this way at ${Math.round(speed * 3.6)} km/h. Go to an interior room on the lowest floor, away from windows.`, 'bad')
  }

  /** Where the live tornado is at time t (world m), or null before touchdown / after it lifts. */
  tornadoAt(t) {
    const T = this.tornado
    if (!T) return null
    const a = (t - T.t0) / T.dur
    if (a < 0 || a > 1) return null
    return { x: T.x0 + T.mx * (t - T.t0), z: T.z0 + T.mz * (t - T.t0), a }
  }

  advanceTornado(t, dt) {
    const T = this.tornado
    if (!T.down && t >= T.t0) {
      T.down = true
      this.log(`The tornado has touched down: ${T.ef.name}, winds of ${T.ef.kmh} km/h in a core ~${T.rc * 2} m wide.`, 'bad')
    }
    // track the strongest gust at each building over this minute, every 2 s of the vortex's passage
    const t0 = Math.max(T.t0, t - dt)
    const t1 = Math.min(T.t0 + T.dur, t)
    this.gusts = null
    if (t1 > t0) {
      const pts = []
      for (let u = t0; u <= t1; u += 2) pts.push({ x: T.x0 + T.mx * (u - T.t0), z: T.z0 + T.mz * (u - T.t0) })
      this.gusts = { T, pts }
    }
    if (t >= T.t0 + T.dur) {
      this.log(`The tornado has lifted after a ${(T.len / 1000).toFixed(1)} km track${T.damaged ? `, leaving ${T.damaged} damaged building${T.damaged > 1 ? 's' : ''} in a narrow line across the city` : ''}.`, T.damaged ? 'bad' : 'warn')
      this.tornado = null
    }
  }

  /** Strongest tornado gust over the last minute at (x, z) for something of half-width r: { g, dir: [east, north] } or null. */
  gustAt(x, z, r = 0) {
    const G = this.gusts
    if (!G) return null
    const { T, pts } = G
    let best = null
    for (const p of pts) {
      if (Math.abs(p.x - x) > 400 || Math.abs(p.z - z) > 400) continue
      // the near edge of the footprint feels it first
      const dx = x - p.x
      const dz = z - p.z
      const d = Math.hypot(dx, dz)
      const k = d > r ? (d - r) / d : 0
      const w = vortexWind(T, p.x + dx * k, p.z + dz * k, p.x, p.z)
      const g = Math.hypot(w.vx, w.vz)
      if (g > 25 && (!best || g > best.g)) best = { g, dir: [w.vx / g, -w.vz / g] }
    }
    return best
  }
}

/** What the forecast panel says about thunderstorms over the run of the simulation. */
export function hazardForecast(s, tau0, tau1) {
  const L = lightningOutlook(s, tau0, tau1)
  const T = tornadoOutlook(s, tau0 - 6, tau1 + 6)
  return { cg: L.cg, flashes: L.seen, tornadoNear: T.near, tornadoHit: T.hit }
}

