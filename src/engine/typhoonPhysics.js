// Tropical cyclone (typhoon) storm physics, evaluated at the district.
//
// A typhoon is hundreds of km across and the district is 1 km, so the storm is
// modelled analytically and only sampled at the city (like quakePhysics.js):
//
// Track:     straight line, heading + forward speed, passing the district at a
//            closest-approach distance on its left or right, at time τ = 0 h.
// Intensity: bulletin Vmax, optionally trending linearly to a forecast value;
//            after landfall the Kaplan & DeMaria (1995) inland decay.
// Pressure:  Knaff & Zehr (2007) wind–pressure relation when no pressure is given.
// Wind:      Holland (1980) profile; with a gale radius, the Holland et al. (2010)
//            outer-exponent fit. Rmax from Willoughby et al. (2006). Surface
//            inflow angle and a translation asymmetry (stronger on the right of
//            the track in the northern hemisphere, the left in the southern).
// Rain:      R-CLIPER azimuthal mean (Tuleya et al. 2007) with a rain-free eye,
//            an eyewall ring, rotating spiral rainbands and a front-left bias.
// Warnings:  PAGASA Modified Tropical Cyclone Wind Signals (2022).
// Surge:     bulk model at the coast: inverse barometer, wind setup over the
//            shelf (relaxing over its seiche time), wave setup, plus an M2 tide.
//
// Units: wind m/s as 1-minute sustained at 10 m unless named otherwise,
// distances km, time h, pressure hPa, rain mm/h, sea level m above mean sea
// level. Storm frame: x east, y north. A coastal district has its sea along the
// south edge of the grid, so its storm is turned into that frame: "north" is
// then inland, and toGeo() turns directions back for the compass.

import { clamp, smoothstep } from './math.js'

export const RHO_AIR = 1.15 // kg/m³
export const P_ENV = 1010 // hPa, West Pacific environmental pressure
export const KT = 0.514444 // m/s per knot
export const TEN_TO_ONE = 0.93 // 10-min sustained = 0.93 × 1-min at sea (WMO, Harper et al. 2010)
export const GUST_LAND = 1.35 // 3-s gust / 1-min sustained over land
export const SITE_EXPOSURE = 0.9 // open land at the coast vs the marine wind in the bulletin
const DEG = Math.PI / 180

export const kmhToMs = (v) => v / 3.6
export const msToKmh = (v) => v * 3.6
/** Bulletin wind (km/h, 10- or 1-minute average) → 1-minute m/s. */
export const toOneMin = (kmh, avg) => kmhToMs(kmh) / (avg === 10 ? TEN_TO_ONE : 1)
export const tenMinKmh = (ms) => msToKmh(ms * TEN_TO_ONE)

// ------------------------------------------------------------ classification
// PAGASA categories (10-min km/h) and Modified TCWS (in effect 23 March 2022)
export const PAGASA_CATS = [
  { min: 0, key: 'LPA', name: 'Low-pressure area' },
  { min: 39, key: 'TD', name: 'Tropical depression' },
  { min: 62, key: 'TS', name: 'Tropical storm' },
  { min: 89, key: 'STS', name: 'Severe tropical storm' },
  { min: 118, key: 'TY', name: 'Typhoon' },
  { min: 185, key: 'STY', name: 'Super typhoon' },
]
export const pagasaCat = (kmh10) => [...PAGASA_CATS].reverse().find((c) => kmh10 >= c.min)

export const SIGNALS = [
  { n: 1, kmh: 39, lead: 36, name: 'Strong winds', threat: 'Minimal to minor threat to life and property' },
  { n: 2, kmh: 62, lead: 24, name: 'Gale-force winds', threat: 'Minor to moderate threat to life and property' },
  { n: 3, kmh: 89, lead: 18, name: 'Storm-force winds', threat: 'Moderate to significant threat to life and property' },
  { n: 4, kmh: 118, lead: 12, name: 'Typhoon-force winds', threat: 'Significant to severe threat to life and property' },
  { n: 5, kmh: 185, lead: 12, name: 'Typhoon-force winds', threat: 'Extreme threat to life and property' },
]

/** Saffir–Simpson category from 1-min wind (m/s); 0 below hurricane force. */
export function saffirSimpson(ms) {
  const kmh = msToKmh(ms)
  return kmh >= 252 ? 5 : kmh >= 209 ? 4 : kmh >= 178 ? 3 : kmh >= 154 ? 2 : kmh >= 119 ? 1 : 0
}

// --------------------------------------------------------------- empirical
/** Knaff & Zehr (2007) central-pressure deficit (hPa) from Vmax (kt), latitude and speed (kt); size S = 1 (average). */
export function knaffZehrDp(vmaxKt, lat, speedKt, S = 1) {
  const vsrm = Math.max(0, vmaxKt - 1.5 * Math.pow(Math.max(speedKt, 0), 0.63))
  const dp = -(23.286 - 0.483 * vsrm - (vsrm / 24.254) ** 2 - 12.587 * S - 0.483 * Math.abs(lat))
  return Math.max(1, dp)
}

/** Inverse of knaffZehrDp: Vmax (kt) for a pressure deficit. */
export function knaffZehrVmax(dp, lat, speedKt) {
  let lo = 10
  let hi = 220
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (knaffZehrDp(mid, lat, speedKt) < dp) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Willoughby, Darling & Rahn (2006) radius of maximum wind (km) from Vmax (m/s) and latitude. */
export const rmaxWilloughby = (vmax, lat) => clamp(46.4 * Math.exp(-0.0155 * vmax + 0.0169 * Math.abs(lat)), 8, 120)

/** Holland B from surface Vmax (m/s) and pressure deficit (hPa): Vmax² = B·Δp / (ρ·e). */
export const hollandB = (vmax, dp) => clamp((RHO_AIR * Math.E * vmax * vmax) / (dp * 100), 1, 2.5)

/** Kaplan & DeMaria (1995) inland decay: wind (m/s) t hours after landfall at v0. */
export const KDM = { vb: 26.7 * KT, alpha: 0.095 }
export const inlandDecay = (v0, t) => (v0 <= KDM.vb ? v0 : KDM.vb + (v0 - KDM.vb) * Math.exp(-KDM.alpha * t))

/** Holland 2010 shape: g = (Rm/r)^B·exp(1 − (Rm/r)^B), V = Vm·g^x. */
function hollandShape(r, rm, B) {
  const a = Math.pow(rm / Math.max(r, 0.05), B)
  return a * Math.exp(1 - a)
}

/** Outer exponent so that V(rn) = vn (Holland et al. 2010); 0.5 is the 1980 profile. */
export function fitOuterExponent(vm, rm, B, rn, vn) {
  if (!rn || rn <= rm * 1.2 || vn >= vm) return 0.5
  return clamp(Math.log(vn / vm) / Math.log(hollandShape(rn, rm, B)), 0.3, 1.0)
}

export function hollandWind(r, s) {
  let x = 0.5
  if (r > s.rmax && s.xn !== 0.5) x = clamp(0.5 + ((r - s.rmax) * (s.xn - 0.5)) / (s.rn - s.rmax), 0.3, 1.0)
  return s.vsym * Math.pow(hollandShape(r, s.rmax, s.B), x)
}

/** Tuleya et al. (2007) R-CLIPER parameters from Vmax (kt): rain in mm/h, radii in km. (Coefficients in in/day.) */
export function rcliper(vmaxKt) {
  const U = 1 + (vmaxKt - 35) / 33
  const inDay = 25.4 / 24
  return {
    T0: Math.max(0.5, (-1.1 + 3.96 * U) * inDay),
    Tm: Math.max(0.6, (-1.6 + 4.8 * U) * inDay),
    rm: Math.max(10, 64.5 - 13 * U),
    re: Math.max(60, 150 - 16 * U),
  }
}

function rcliperRate(r, p) {
  return r <= p.rm ? p.T0 + (p.Tm - p.T0) * (r / p.rm) : p.Tm * Math.exp(-(r - p.rm) / p.re)
}

// ------------------------------------------------------------------- storm
/**
 * A storm from scenario parameters:
 *   wind (km/h) + avg (10 | 1): bulletin maximum sustained wind
 *   windCA (km/h, optional): forecast wind at closest approach (same averaging)
 *   leadH: hours from the bulletin to closest approach (for windCA)
 *   pc (hPa, optional): central pressure, else Knaff–Zehr
 *   heading (deg, direction of motion, 0 = north), speed (km/h)
 *   dist (km): closest approach; side: 'right' | 'left' (district relative to the track)
 *   landfall (h relative to closest approach, null = never)
 *   rmax (km, optional), r34 (km, optional: radius of gale-force winds)
 *   lat (deg, negative = southern hemisphere), rainBoost (monsoon / terrain)
 *   coast (optional): { on, shelf: SHELVES key, facing: direction the sea lies in (deg),
 *          tide: amplitude (m), tidePhase: TIDE_PHASES key at closest approach }
 */
export function buildStorm(sc) {
  const lat = sc.lat ?? 14
  const hemi = lat < 0 ? -1 : 1
  const c = Math.max(1, sc.speed ?? 20)
  const coast = sc.coast?.on ? { shelf: 'open', facing: 180, tide: 0.5, tidePhase: 'rising', ...sc.coast } : null
  // the grid's south is the direction the sea lies in
  const rot = coast ? coast.facing - 180 : 0
  const h = ((sc.heading ?? 290) - rot) * DEG
  const u = [Math.sin(h), Math.cos(h)] // unit vector of motion (east, north)
  const rp = [u[1], -u[0]] // right-hand perpendicular
  const side = sc.side === 'left' ? -1 : 1
  const v0 = toOneMin(sc.wind, sc.avg)
  const vCA = sc.windCA != null ? toOneMin(sc.windCA, sc.avg) : v0
  const leadH = Math.max(1, sc.leadH ?? 24)
  const speedKt = c / 3.6 / KT
  const dpGiven = sc.pc != null ? Math.max(1, P_ENV - sc.pc) : null
  // pressure follows intensity; a given pressure calibrates Knaff–Zehr at the bulletin time
  const kzScale = dpGiven ? dpGiven / knaffZehrDp(v0 / KT, lat, speedKt) : 1
  const landfall = sc.landfall ?? null
  const marine = (tau) => {
    const f = clamp((tau + leadH) / leadH, 0, 1)
    return Math.max(8, v0 + (vCA - v0) * f)
  }
  const vAtLandfall = landfall != null ? marine(landfall) : 0
  const s = {
    sc,
    lat,
    hemi,
    c,
    u,
    dist: sc.dist ?? 20,
    side,
    landfall,
    rainBoost: sc.rainBoost ?? 1,
    coast,
    rot,
    rmaxGiven: sc.rmax ?? null,
    r34: sc.r34 ?? null,
    // centre position at τ (km, district at the origin)
    pos(tau) {
      return [-side * this.dist * rp[0] + c * tau * u[0], -side * this.dist * rp[1] + c * tau * u[1]]
    },
    overLand(tau) {
      return landfall != null && tau >= landfall
    },
    vmax(tau) {
      return this.overLand(tau) ? inlandDecay(vAtLandfall, tau - landfall) : marine(tau)
    },
    dp(tau) {
      return Math.max(1, kzScale * knaffZehrDp(this.vmax(tau) / KT, lat, speedKt))
    },
    pc(tau) {
      return P_ENV - this.dp(tau)
    },
  }
  return s
}

/** Storm structure at τ: symmetric Vm, B, Rmax, outer exponent. */
export function structure(s, tau) {
  const vmax = s.vmax(tau)
  const cMs = s.c / 3.6
  const vsym = Math.max(vmax - 0.55 * cMs, vmax * 0.6)
  const dp = s.dp(tau)
  const B = hollandB(vsym, dp)
  const rw = rmaxWilloughby(vmax, s.lat)
  // a given Rmax holds at the bulletin intensity and scales with Willoughby as the storm changes
  const rmax = s.rmaxGiven ? s.rmaxGiven * (rw / rmaxWilloughby(s.vmax(-(s.sc.leadH ?? 24)), s.lat)) : rw
  const st = { vmax, vsym, dp, B, rmax, xn: 0.5, rn: 0 }
  if (s.r34) {
    st.rn = s.r34
    st.xn = fitOuterExponent(vsym, rmax, B, s.r34, toOneMin(62, 10))
  }
  return st
}

/**
 * Everything the district feels at τ (h from closest approach), at (px, py) km.
 * wind: 1-min sustained (m/s) in open terrain; dir: unit vector it blows toward.
 */
export function fieldAt(s, tau, px = 0, py = 0, st = structure(s, tau)) {
  const [cx, cy] = s.pos(tau)
  const dx = px - cx
  const dy = py - cy
  const r = Math.max(0.05, Math.hypot(dx, dy))
  const rx = dx / r
  const ry = dy / r
  // cyclonic tangent (anticlockwise in the north) turned inward by the surface inflow angle
  const tx = -ry * s.hemi
  const ty = rx * s.hemi
  const beta = (s.overLand(tau) ? 35 : 22) * DEG * smoothstep(0, 1.2, r / st.rmax)
  const wx0 = tx * Math.cos(beta) - rx * Math.sin(beta)
  const wy0 = ty * Math.cos(beta) - ry * Math.sin(beta)
  const vs = hollandWind(r, st)
  const cMs = s.c / 3.6
  const k = (0.55 * cMs * vs) / st.vsym
  let wx = (wx0 * vs + k * s.u[0]) * SITE_EXPOSURE
  let wy = (wy0 * vs + k * s.u[1]) * SITE_EXPOSURE
  const wind = Math.hypot(wx, wy)
  if (wind > 0) {
    wx /= wind
    wy /= wind
  }
  const p = s.pc(tau) + st.dp * Math.exp(-Math.pow(st.rmax / r, st.B))
  // storm-relative bearing of the district, anticlockwise from the direction of motion
  const theta = Math.atan2(dy, dx) - Math.atan2(s.u[1], s.u[0])
  const rain = rainAt(s, st, tau, r, theta)
  const eye = r < st.rmax * 0.45 && eyeStrength(st.vmax) > 0.5
  return { r, wind, dir: [wx, wy], p, rain: rain.rate, mean: rain.mean, band: rain.band, eye, rmax: st.rmax, vmax: st.vmax, pc: s.pc(tau) }
}

/** 0 for a disorganised storm, 1 for a typhoon with a clear eye (1-min Vmax 28 → 40 m/s). */
const eyeStrength = (vmax) => smoothstep(28, 40, vmax)

function rainAt(s, st, tau, r, theta) {
  const p = rcliper(st.vmax / KT)
  p.rm = Math.max(p.rm, st.rmax * 1.1)
  const x = r / st.rmax
  // only typhoons have a clear eye and a ring of eyewall convection
  const org = eyeStrength(st.vmax)
  const eye = 1 - org * (0.96 - 0.96 * smoothstep(0.4, 0.9, x))
  const wall = 1 + org * 2.6 * Math.exp(-(((x - 1.15) / 0.4) ** 2))
  // more rain ahead and to the left of the motion (right in the south)
  const front = 1 + 0.3 * Math.cos(theta - (s.hemi * Math.PI) / 4)
  const mean = rcliperRate(r, p) * eye * wall * front * s.rainBoost
  // two logarithmic spiral arms (pitch ~15°), turning slowly with the storm
  const psi = s.hemi * theta + Math.log(Math.max(x, 1)) / Math.tan(15 * DEG) - 0.35 * tau
  const arm = Math.max(0, Math.cos(2 * psi)) ** 4
  const w = smoothstep(1.6, 3.2, x)
  const band = 1 - w + w * (0.4 + 3.2 * arm)
  // convective cells: a few minutes of downpour, then a lull
  const cells = 1 + 0.22 * Math.sin(tau * 9.1 + r * 0.7) * Math.sin(tau * 23.7 + theta * 3)
  return { mean, band, rate: Math.max(0, mean * band * cells) }
}

/** Mean rain (mm/h) over the upstream catchment: samples 5–28 km up the river (north of the district, inland). */
export function catchmentRain(s, tau) {
  const st = structure(s, tau)
  let sum = 0
  for (const y of [5, 12, 20, 28]) sum += fieldAt(s, tau, 0, y, st).mean
  return sum / 4
}

const POINTS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest']
/** Compass point of a direction given as (east, north). */
export const compassOf = (x, y) => POINTS[(Math.round((Math.atan2(x, y) / (Math.PI * 2)) * 16) + 16) % 16]

/** A direction in the storm's (grid) frame back in geographic axes. */
export function toGeo(s, x, y) {
  const r = (s.rot ?? 0) * DEG
  return [x * Math.cos(r) + y * Math.sin(r), -x * Math.sin(r) + y * Math.cos(r)]
}
/** Compass point of a direction in the storm's frame. */
export const geoCompass = (s, x, y) => compassOf(...toGeo(s, x, y))

// ------------------------------------------------------------ storm surge
// Bulk model of the sea level at the coast (the main terms of SLOSH, not a
// surge model): the low pressure lifts the sea (inverse barometer, ~1 cm per
// hPa); onshore wind stress drags water toward the coast and piles it up over
// the continental shelf (wind setup, τ·L / (ρw·g·h): long, shallow shelves
// and narrowing bays give the worst surges); breaking waves add wave setup at
// the shoreline. The wind setup takes the shelf's seiche time L/√(g·h) to
// build and to drain. The tide (M2, 12.42 h) adds or subtracts on top.
export const RHO_SEA = 1025 // kg/m³
const G = 9.81
export const M2_PERIOD = 12.42 // h

// L: shelf width (km), h: its mean depth (m), funnel: amplification by a
// bay that narrows toward the city, wave: share of the offshore waves that
// reach the beach (a wide shallow shelf breaks them far out)
export const SHELVES = {
  open: { key: 'open', name: 'Open coast', L: 12, h: 30, funnel: 1, wave: 1, desc: 'Deep water close to shore. Little wind setup, but the big waves break right on the beach.' },
  shelf: { key: 'shelf', name: 'Wide shallow shelf', L: 80, h: 11, funnel: 1, wave: 0.55, desc: 'Shallow sea far offshore, as off a delta or the US Gulf coast. The wind piles water up over a long fetch: the worst surges (Nargis, Katrina).' },
  bay: { key: 'bay', name: 'Funnel-shaped bay', L: 30, h: 18, funnel: 2.1, wave: 0.6, desc: 'A bay narrowing toward the city squeezes the surge higher, as San Pedro Bay did to Tacloban in Haiyan.' },
}

// hours from closest approach to the next high water
export const TIDE_PHASES = {
  high: { key: 'high', name: 'High tide', at: 0 },
  falling: { key: 'falling', name: 'Falling', at: -M2_PERIOD / 4 },
  low: { key: 'low', name: 'Low tide', at: M2_PERIOD / 2 },
  rising: { key: 'rising', name: 'Rising', at: M2_PERIOD / 4 },
}

/** Sea-surface drag coefficient: Large & Pond (1981), levelling off in hurricane winds (Powell et al. 2003). */
export const dragCd = (U) => clamp((0.49 + 0.065 * U) * 1e-3, 1.2e-3, 2.5e-3)

/** Tide (m above mean sea level) at τ. */
export const tideAt = (s, tau) => s.coast.tide * Math.cos((2 * Math.PI * (tau - (TIDE_PHASES[s.coast.tidePhase] ?? TIDE_PHASES.rising).at)) / M2_PERIOD)

/** The surge terms at τ; the wind setup is its steady value (windEq). */
export function surgeForcing(s, tau, st = structure(s, tau)) {
  const c = SHELVES[s.coast.shelf] ?? SHELVES.open
  // onshore stress (inland is the grid's north) averaged across the shelf, from the marine wind
  let stress = 0
  for (const q of [0.15, 0.5, 0.85]) {
    const f = fieldAt(s, tau, 0, -q * c.L, st)
    const U = f.wind / SITE_EXPOSURE
    stress += (RHO_AIR * dragCd(U) * U * U * f.dir[1]) / 3
  }
  const windEq = clamp((c.funnel * stress * c.L * 1000) / (RHO_SEA * G * c.h), -1.5, 12)
  // waves at the shelf edge: in a tropical cyclone Hs ≈ 0.2 × the wind (m, m/s)
  const edge = fieldAt(s, tau, 0, -c.L, st)
  const hs = (0.2 * edge.wind) / SITE_EXPOSURE
  const wave = 0.15 * hs * c.wave * clamp(edge.dir[1] + 0.2, 0, 1)
  const p = fieldAt(s, tau, 0, 0, st).p
  const pressure = ((P_ENV - p) * 100) / (RHO_SEA * G)
  return { pressure, windEq, wave, hs }
}

/** Sea level at the coast every 5 minutes: { tau, tide, pressure, wind, wave, surge, level } (m). */
export function surgeTimeline(s, from = -48, to = 36, step = 1 / 12) {
  const c = SHELVES[s.coast.shelf] ?? SHELVES.open
  const relax = (c.L * 1000) / Math.sqrt(G * c.h) / 3600
  const k = 1 - Math.exp(-step / relax)
  const out = []
  let wind = null
  for (let tau = from; tau <= to + 1e-9; tau += step) {
    const F = surgeForcing(s, tau)
    wind = wind == null ? F.windEq : wind + (F.windEq - wind) * k
    const tide = tideAt(s, tau)
    const surge = F.pressure + wind + F.wave
    out.push({ tau, tide, pressure: F.pressure, wind, wave: F.wave, hs: F.hs, surge, level: surge + tide })
  }
  return out
}

/** A surge timeline entry interpolated at τ. */
export function seaAt(tl, tau) {
  const step = tl[1].tau - tl[0].tau
  const x = clamp((tau - tl[0].tau) / step, 0, tl.length - 1.001)
  const n = Math.floor(x)
  const f = x - n
  const a = tl[n]
  const b = tl[n + 1]
  const out = {}
  for (const key of ['tide', 'pressure', 'wind', 'wave', 'surge', 'level']) out[key] = a[key] + (b[key] - a[key]) * f
  out.tau = tau
  return out
}

/** Highest PAGASA signal for a 10-min wind (km/h). */
export const signalForWind = (kmh10) => [...SIGNALS].reverse().find((g) => kmh10 >= g.kmh)?.n ?? 0

/** Closest approach of a storm at (lat, lon) moving toward heading at speed, to a city at (clat, clon). */
export function bulletinGeometry({ lat, lon, heading, speed }, { lat: clat, lon: clon }) {
  const kx = 111.32 * Math.cos(((lat + clat) / 2) * DEG)
  const ex = (lon - clon) * kx // storm relative to city, km
  const ey = (lat - clat) * 110.57
  const u = [Math.sin(heading * DEG), Math.cos(heading * DEG)]
  const along = -(ex * u[0] + ey * u[1]) // km until closest approach
  const cross = ex * u[1] - ey * u[0] // > 0: storm track passes to the right of the city → city on its left
  return { dist: Math.round(Math.abs(cross)), side: cross > 0 ? 'left' : 'right', leadH: along / Math.max(1, speed), now: Math.round(Math.hypot(ex, ey)) }
}

/**
 * The storm sampled at the district every 10 minutes, for the forecast panel,
 * warning signals and choosing when the simulation starts.
 */
export function stormTimeline(s, from = -48, to = 36, step = 1 / 6) {
  const out = []
  for (let tau = from; tau <= to + 1e-9; tau += step) {
    const f = fieldAt(s, tau)
    out.push({ tau, wind: f.wind, kmh10: tenMinKmh(f.wind), rain: f.rain, mean: f.mean, p: f.p, r: f.r, eye: f.eye })
  }
  return out
}

/** Signal in force at τ: the strongest whose threshold is forecast within its lead time. */
export function signalAt(timeline, tau) {
  let best = 0
  for (const g of SIGNALS) {
    for (const e of timeline) {
      if (e.tau < tau - 1e-9) continue
      if (e.tau > tau + g.lead) break
      if (e.kmh10 >= g.kmh) {
        best = g.n
        break
      }
    }
  }
  return best
}

/** Headline numbers for the forecast panel and the start time of the simulation. */
export function forecastSummary(s) {
  const tl = stormTimeline(s)
  let peak = tl[0]
  let pmin = tl[0]
  let total = 0
  let first = null
  let last = null
  let eyeH = 0
  for (const e of tl) {
    if (e.wind > peak.wind) peak = e
    if (e.p < pmin.p) pmin = e
    total += e.rain / 6
    if (e.eye) eyeH += 1 / 6
    if (e.rain >= 1.5 || e.kmh10 >= 39) {
      if (first == null) first = e.tau
      last = e.tau
    }
  }
  const startH = clamp((first ?? -6) - 1.5, -24, -3)
  const tc = structure(s, 0)
  let sea = null
  if (s.coast) {
    const stl = surgeTimeline(s)
    let top = stl[0]
    let surgeMax = stl[0]
    for (const e of stl) {
      if (e.tau < startH) continue
      if (e.level > top.level) top = e
      if (e.surge > surgeMax.surge) surgeMax = e
    }
    sea = { timeline: stl, peak: top.level, peakTau: top.tau, surgeAtPeak: top.surge, tideAtPeak: top.tide, surgeMax: surgeMax.surge, surgeMaxTau: surgeMax.tau, parts: { pressure: top.pressure, wind: top.wind, wave: top.wave } }
  }
  return {
    timeline: tl,
    sea,
    peakWind: peak.wind,
    peakKmh10: peak.kmh10,
    peakGust: peak.wind * GUST_LAND,
    peakTau: peak.tau,
    pmin: pmin.p,
    rainTotal: total,
    eyeH,
    signal: Math.max(0, ...tl.map((e) => signalForWind(e.kmh10))),
    startH,
    endH: last ?? 6,
    vmaxCA: tc.vmax,
    pcCA: s.pc(0),
    rmax: tc.rmax,
    B: tc.B,
    xn: tc.xn,
    category: pagasaCat(tenMinKmh(tc.vmax)),
    ss: saffirSimpson(tc.vmax),
  }
}
