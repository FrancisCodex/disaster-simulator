// Earthquake source physics and ground-motion prediction.
//
// Source:   seismic moment (Hanks & Kanamori 1979), radiated energy
//           (Gutenberg–Richter), rupture length/width from Wells & Coppersmith
//           (1994) for crustal faults and Strasser et al. (2010) for subduction
//           interfaces, average slip = M0 / (μ·A).
// Geometry: the rupture is a rectangle on a dipping plane. Its surface
//           projection gives Joyner–Boore distance (Rjb); depth to the plane
//           below the closest point gives rupture distance (Rrup). The city is
//           taken to be on the hanging-wall side (the worst case, and the usual
//           situation for thrusts under cities such as Northridge or Chi-Chi).
// Shaking:  shallow crustal → Boore & Atkinson (2008) PGA, with its linear +
//           nonlinear Vs30 site term; subduction interface / intraslab →
//           Youngs et al. (1997) rock PGA, with the same BA08 site term.
//           Coefficients as implemented in the OpenQuake hazard library.
// Intensity: Wald et al. (1999) PGA → Modified Mercalli intensity.
// All distances in km, accelerations in g.

import { clamp } from './math.js'

export const MECHANISMS = {
  strike: { key: 'strike', name: 'Strike-slip', short: 'SS', dip: 90, regime: 'crustal', desc: 'Blocks slide past each other sideways (San Andreas, North Anatolian).' },
  reverse: { key: 'reverse', name: 'Reverse / thrust', short: 'RS', dip: 35, regime: 'crustal', desc: 'One block is pushed up over the other (Northridge, Chi-Chi, Wenchuan).' },
  normal: { key: 'normal', name: 'Normal', short: 'NS', dip: 55, regime: 'crustal', desc: 'The crust is pulled apart and one block drops (L’Aquila, Messina).' },
  interface: { key: 'interface', name: 'Subduction megathrust', short: 'Interface', dip: 15, regime: 'interface', desc: 'The plate boundary itself ruptures under the coast (Tōhoku, Chile, Sumatra).' },
  intraslab: { key: 'intraslab', name: 'Deep intraslab', short: 'Intraslab', dip: 50, regime: 'intraslab', desc: 'Breaks inside the sinking plate, deep below the city (Puebla 2017).' },
}

export const RUPTURE_DIRS = {
  bilateral: 'Spreads both ways from the epicentre',
  toward: 'Runs from the epicentre toward the city',
  away: 'Runs from the epicentre away from the city',
}

// Vs30 (m/s) for the map's ground classes: rock, stiff soil, soft alluvium
export const SOIL_VS30 = [760, 400, 200]

const SEISMOGENIC_DEPTH = 22 // km: crustal faults rarely rupture deeper

// ------------------------------------------------------------------- source

/** Rupture dimensions and energy for an event {M, depth, mech, dip?}. */
export function sourceParams(ev) {
  const m = MECHANISMS[ev.mech] ?? MECHANISMS.strike
  const M = ev.M
  const dip = ev.dip ?? m.dip
  const sinD = Math.sin((dip * Math.PI) / 180)
  const M0 = Math.pow(10, 1.5 * M + 9.1) // N·m
  const energy = Math.pow(10, 1.5 * M + 4.8) // J radiated
  let L
  let W
  if (m.regime === 'interface') {
    L = Math.pow(10, -2.477 + 0.585 * M) // Strasser et al. 2010
    W = Math.min(Math.pow(10, -0.882 + 0.351 * M), 250)
  } else {
    L = Math.pow(10, -2.44 + 0.59 * M) // Wells & Coppersmith 1994, subsurface length, all types
    W = Math.pow(10, -1.01 + 0.32 * M)
    if (m.regime === 'crustal') W = Math.min(W, Math.max(SEISMOGENIC_DEPTH, ev.depth + 5) / sinD)
  }
  // hypocentre at mid-width, the plane can't reach above the surface
  let ztor = Math.max(0, ev.depth - (W / 2) * sinD)
  const zbot = ztor + W * sinD
  if (m.regime === 'crustal' && ev.depth <= 5) ztor = 0
  const mu = m.regime === 'crustal' ? 3.0e10 : 4.0e10 // shear modulus (Pa)
  const area = L * W // km²
  const slip = M0 / (mu * area * 1e6) // m
  return { M0, energy, tnt: energy / 4.184e12, L, W, area, slip, dip, ztor, zbot, regime: m.regime, mech: m }
}

/**
 * Fault geometry in district coordinates (km, origin at the district centre).
 * x is east and y is south (world x / z). ev.dist: epicentral distance;
 * ev.az: direction from the district to the epicentre (radians, the epicentre
 * lies at (cos az, sin az)·dist, as in the cut-away view); ev.strike: angle (deg)
 * between the fault and the line from the epicentre to the city;
 * ev.rupture: bilateral / toward / away.
 */
export function faultGeometry(ev, src = sourceParams(ev)) {
  const ex = Math.cos(ev.az) * ev.dist
  const ey = Math.sin(ev.az) * ev.dist
  // unit vector from epicentre toward the city
  const tc = ev.dist > 1e-6 ? [-ex / ev.dist, -ey / ev.dist] : [0, 1]
  const s = ((ev.strike ?? 90) * Math.PI) / 180
  // along-strike axis u, rotated off the epicentre→city line by `strike`
  const u = [tc[0] * Math.cos(s) - tc[1] * Math.sin(s), tc[0] * Math.sin(s) + tc[1] * Math.cos(s)]
  // across-strike axis v, pointing down-dip toward the city's side
  let v = [-u[1], u[0]]
  if (v[0] * tc[0] + v[1] * tc[1] < 0) v = [-v[0], -v[1]]
  const L = src.L
  const proj = src.W * Math.cos((src.dip * Math.PI) / 180)
  // hypocentre at mid-width; along strike depending on rupture direction
  let u0 = -L / 2
  let u1 = L / 2
  const toCity = u[0] * tc[0] + u[1] * tc[1] >= 0 ? 1 : -1
  if (ev.rupture === 'toward') [u0, u1] = toCity > 0 ? [-0.1 * L, 0.9 * L] : [-0.9 * L, 0.1 * L]
  else if (ev.rupture === 'away') [u0, u1] = toCity > 0 ? [-0.9 * L, 0.1 * L] : [-0.1 * L, 0.9 * L]
  return { ex, ey, u, v, u0, u1, v0: -proj / 2, v1: proj / 2, ztor: src.ztor, zbot: src.zbot }
}

/** Rjb and Rrup (km) from the fault to a site at (x, y) km. */
export function siteDistances(geo, x, y) {
  const dx = x - geo.ex
  const dy = y - geo.ey
  const a = dx * geo.u[0] + dy * geo.u[1]
  const b = dx * geo.v[0] + dy * geo.v[1]
  const da = a - clamp(a, geo.u0, geo.u1)
  const rjb = Math.hypot(da, b - clamp(b, geo.v0, geo.v1))
  // across strike the plane is the segment (v0, ztor) → (v1, zbot) in the
  // vertical cross-section; Rrup combines the along-strike offset with the
  // distance from the surface point (b, 0) to that segment
  const sx = geo.v1 - geo.v0
  const sz = geo.zbot - geo.ztor
  const t = clamp(((b - geo.v0) * sx + -geo.ztor * sz) / Math.max(1e-9, sx * sx + sz * sz), 0, 1)
  const across = Math.hypot(b - (geo.v0 + sx * t), geo.ztor + sz * t)
  return { rjb, rrup: Math.hypot(da, across) }
}

// ------------------------------------------------------------- ground motion

// Boore & Atkinson (2008), PGA row
const BA = { c1: -0.6605, c2: 0.1197, c3: -0.01151, h: 1.35, e1: -0.53804, e2: -0.5035, e3: -0.75472, e4: -0.5097, e5: 0.28805, e6: -0.10164, e7: 0, Mh: 6.75, sigma: 0.502, tau: 0.26 }
const SITE = { blin: -0.36, b1: -0.64, b2: -0.14, V1: 180, V2: 300, Vref: 760, a1: 0.03, a2: 0.09, pgaLow: 0.06 }

/** Median rock PGA (Vs30 = 760 m/s) from BA08. */
export function ba08Rock(M, rjb, mech) {
  const SS = mech === 'strike' ? 1 : 0
  const NS = mech === 'normal' ? 1 : 0
  const RS = mech === 'reverse' ? 1 : 0
  const U = SS || NS || RS ? 0 : 1
  const dm = M - BA.Mh
  const FM = BA.e1 * U + BA.e2 * SS + BA.e3 * NS + BA.e4 * RS + (dm <= 0 ? BA.e5 * dm + BA.e6 * dm * dm : BA.e7 * dm)
  const R = Math.sqrt(rjb * rjb + BA.h * BA.h)
  const FD = (BA.c1 + BA.c2 * (M - 4.5)) * Math.log(R) + BA.c3 * (R - 1)
  return Math.exp(FM + FD)
}

/** Median rock PGA from Youngs et al. (1997); hypocentral depth in km. */
export function youngsRock(M, rrup, depth, intraslab) {
  const ln = 0.2418 + 1.414 * M + -2.552 * Math.log(rrup + 1.7818 * Math.exp(0.554 * M)) + 0.00607 * depth + (intraslab ? 0.3846 : 0)
  return Math.exp(ln)
}

/** BA08 site amplification (factor) for a site of given Vs30 under rock PGA pga4nl. */
export function siteFactor(vs30, pga4nl) {
  const S = SITE
  const lin = S.blin * Math.log(vs30 / S.Vref)
  let bnl = 0
  if (vs30 <= S.V1) bnl = S.b1
  else if (vs30 <= S.V2) bnl = (S.b1 - S.b2) * (Math.log(vs30 / S.V2) / Math.log(S.V1 / S.V2)) + S.b2
  else if (vs30 < S.Vref) bnl = S.b2 * (Math.log(vs30 / S.Vref) / Math.log(S.V2 / S.Vref))
  let nl
  if (pga4nl <= S.a1) nl = bnl * Math.log(S.pgaLow / 0.1)
  else if (pga4nl <= S.a2) {
    const dx = Math.log(S.a2 / S.a1)
    const dy = bnl * Math.log(S.a2 / S.pgaLow)
    const c = (3 * dy - bnl * dx) / (dx * dx)
    const d = -(2 * dy - bnl * dx) / (dx * dx * dx)
    const q = Math.log(pga4nl / S.a1)
    nl = bnl * Math.log(S.pgaLow / 0.1) + c * q * q + d * q * q * q
  } else nl = bnl * Math.log(pga4nl / 0.1)
  return Math.exp(lin + nl)
}

/** Which ground-motion model applies, and its total log-standard deviation. */
export function gmpeFor(ev) {
  const regime = (MECHANISMS[ev.mech] ?? MECHANISMS.strike).regime
  if (regime === 'crustal') return { name: 'Boore & Atkinson (2008)', regime, sigma: Math.hypot(BA.sigma, BA.tau), tau: BA.tau, valid: [5, 8], maxDepth: 25 }
  const sig = 1.45 - 0.1 * clamp(ev.M, 0, 8) // Youngs rock sigma
  return { name: `Youngs et al. (1997), ${regime === 'interface' ? 'interface' : 'intraslab'}`, regime, sigma: sig, tau: sig * 0.45, valid: [5, 8.2], maxDepth: 230 }
}

/** Median rock PGA (g) at a site for an event, given the site's distances. */
export function rockPga(ev, d) {
  const regime = (MECHANISMS[ev.mech] ?? MECHANISMS.strike).regime
  if (regime === 'crustal') return ba08Rock(ev.M, d.rjb, ev.mech)
  return youngsRock(ev.M, d.rrup, ev.depth, regime === 'intraslab')
}

// ------------------------------------------------------------ other measures

/** Modified Mercalli intensity from PGA (Wald et al. 1999). */
export function mmiFromPga(pga) {
  const cms = Math.max(1e-3, pga * 981)
  const I = 3.66 * Math.log10(cms) - 1.66
  const low = 2.2 * Math.log10(cms) + 1
  return clamp(I < 5 ? low : I, 1, 12)
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']
const MMI_WORDS = ['', 'Not felt', 'Weak', 'Weak', 'Light', 'Moderate', 'Strong', 'Very strong', 'Severe', 'Violent', 'Extreme', 'Extreme', 'Extreme']
export const mmiLabel = (I) => `${ROMAN[Math.round(I)]} · ${MMI_WORDS[Math.round(I)]}`

/** Strong shaking duration (s): rupture time plus path spreading. */
export function shakeDuration(M, rrup = 20) {
  return Math.pow(10, 0.5 * M - 2.2) + 0.05 * rrup
}

/** Expected count of aftershocks ≥ Mmin in the first `days` (Reasenberg & Jones 1989 generic). */
export function expectedAftershocks(M, days, Mmin = Math.max(4, M - 3)) {
  const c = 0.05
  const p = 1.08
  const A = Math.pow(10, -1.67 + 0.91 * (M - Mmin))
  return { n: (A * (Math.pow(days + c, 1 - p) - Math.pow(c, 1 - p))) / (1 - p), Mmin, bath: M - 1.2 }
}

/** Everything the scenario readout shows, evaluated at the district centre. */
export function describeEvent(ev) {
  const src = sourceParams(ev)
  const geo = faultGeometry({ ...ev, az: ev.az ?? 0 }, src)
  const d = siteDistances(geo, 0, 0)
  const g = gmpeFor(ev)
  const rock = rockPga(ev, d)
  const sites = SOIL_VS30.map((vs) => rock * siteFactor(vs, rock))
  const warnings = []
  if (ev.M < g.valid[0] || ev.M > g.valid[1]) warnings.push(`M${ev.M.toFixed(1)} is outside the range the ${g.name} model was fitted to (M${g.valid[0]}–${g.valid[1]}); values are extrapolated.`)
  if (ev.depth > g.maxDepth) warnings.push(`A ${ev.depth} km deep event is beyond this model's depth range.`)
  if (g.regime === 'crustal' && ev.depth > 30) warnings.push('Crustal faults rarely break below ~25 km; consider the intraslab mechanism for deep events.')
  if (g.regime === 'interface' && ev.depth > 60) warnings.push('Megathrusts lock only to ~50–60 km depth; deeper events are intraslab.')
  if (ev.M > 9.6) warnings.push('No earthquake above M9.5 has ever been recorded; a fault long enough is not known to exist.')
  return {
    src,
    rjb: d.rjb,
    rrup: d.rrup,
    gmpe: g,
    rock,
    sites,
    sigmaFactor: Math.exp(g.sigma),
    mmi: mmiFromPga(sites[1]),
    duration: shakeDuration(ev.M, d.rrup),
    after: expectedAftershocks(ev.M, 3),
    warnings,
  }
}
