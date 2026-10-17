// Road network analysis shared by the road renderer and the traffic model.
// Every road cell is classified as a two-way street, one half of a divided
// avenue (one-way, two lanes), a junction, a bend or a dead end. Junction
// cells that touch belong to one intersection and share one signal phase.
import { GRID, CELL_ROAD } from './config.js'
import { idx } from './cityGen.js'

export const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]
export const STREET = 0
export const AVENUE = 1
export const JUNCTION = 2
export const BEND = 3
export const END = 4

const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1)

export function analyzeRoads(city) {
  const N = GRID
  const road = new Uint8Array(N * N)
  for (let k = 0; k < N * N; k++) road[k] = city.cellType[k] === CELL_ROAD || city.bridge[k] ? 1 : 0
  const axisOf = (k) => {
    let a = city.roadAxis ? city.roadAxis[k] : 0
    if (city.bridge[k]) a = a || 1
    return a
  }
  const nb = new Uint8Array(N * N) // road neighbours
  const kind = new Uint8Array(N * N)
  const axis = new Uint8Array(N * N) // 1 east–west, 2 north–south
  const twin = new Int8Array(N * N).fill(-1) // direction of the other half of an avenue
  const oneway = new Int8Array(N * N).fill(-1)
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const k = idx(i, j)
      if (!road[k]) continue
      let m = 0
      DIRS.forEach(([dx, dz], d) => {
        const ii = i + dx
        const jj = j + dz
        if (ii >= 0 && jj >= 0 && ii < N && jj < N && road[idx(ii, jj)]) m |= 1 << d
      })
      nb[k] = m
      let a = axisOf(k)
      if (!a) a = m & 0b0101 ? 1 : 2 // older maps: infer from neighbours
      axis[k] = a
    }
  for (let k = 0; k < N * N; k++) {
    if (!road[k]) continue
    const m = nb[k]
    const i = k % N
    const j = (k - i) / N
    if (axis[k] === 3) {
      kind[k] = popcount(m) >= 3 ? JUNCTION : popcount(m) === 2 && !((m & 0b0101) === 0b0101 || (m & 0b1010) === 0b1010) ? BEND : popcount(m) <= 1 ? END : STREET
      if (kind[k] === STREET) axis[k] = m & 0b0101 ? 1 : 2
      continue
    }
    // a parallel road cell right beside this one makes it half of an avenue
    const side = axis[k] === 1 ? [1, 3] : [0, 2]
    for (const d of side) {
      const ii = i + DIRS[d][0]
      const jj = j + DIRS[d][1]
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
      const kk = idx(ii, jj)
      if (road[kk] && axis[kk] === axis[k]) twin[k] = d
    }
    const along = axis[k] === 1 ? m & 0b0101 : m & 0b1010
    if (twin[k] >= 0) {
      kind[k] = AVENUE
      // traffic keeps right: the half on the right of a direction carries it
      if (axis[k] === 1) oneway[k] = twin[k] === 3 ? 0 : 2
      else oneway[k] = twin[k] === 0 ? 1 : 3
    } else kind[k] = popcount(along) <= 1 ? END : STREET
  }
  const isJ = (k) => kind[k] === JUNCTION || kind[k] === BEND
  // second pass: an avenue crossing a street creates junction cells that only
  // have the avenue on one axis; keep them as junctions
  const accepts = (k, d) => {
    if (!road[k]) return false
    if (isJ(k)) return true
    if (kind[k] === AVENUE) return oneway[k] === d
    return axis[k] === 1 ? d % 2 === 0 : d % 2 === 1
  }
  const carOut = new Uint8Array(N * N)
  for (let k = 0; k < N * N; k++) {
    if (!road[k]) continue
    const i = k % N
    const j = (k - i) / N
    for (let d = 0; d < 4; d++) {
      if (!(nb[k] & (1 << d))) continue
      const kk = idx(i + DIRS[d][0], j + DIRS[d][1])
      let ok
      if (isJ(k)) ok = accepts(kk, d)
      else if (kind[k] === AVENUE) ok = d === oneway[k] && accepts(kk, d)
      else ok = (axis[k] === 1 ? d % 2 === 0 : d % 2 === 1) && accepts(kk, d)
      if (ok) carOut[k] |= 1 << d
    }
  }
  // pedestrians walk along streets and through junctions in either direction
  const walkOut = new Uint8Array(N * N)
  for (let k = 0; k < N * N; k++) {
    if (!road[k]) continue
    walkOut[k] = isJ(k) ? nb[k] : nb[k] & (axis[k] === 1 ? 0b0101 : 0b1010)
  }
  // junction clusters share a signal phase
  const cluster = new Int32Array(N * N).fill(-1)
  let nc = 0
  for (let k = 0; k < N * N; k++) {
    if (kind[k] !== JUNCTION || cluster[k] >= 0) continue
    const q = [k]
    cluster[k] = nc
    while (q.length) {
      const c = q.pop()
      const ci = c % N
      const cj = (c - ci) / N
      for (const [dx, dz] of DIRS) {
        const ii = ci + dx
        const jj = cj + dz
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
        const kk = idx(ii, jj)
        if (kind[kk] === JUNCTION && cluster[kk] < 0) {
          cluster[kk] = nc
          q.push(kk)
        }
      }
    }
    nc++
  }
  /** Is there a sidewalk on `side` (+1 right / -1 left) of travel direction d in cell k? */
  const hasWalk = (k, d, side) => {
    const i = k % N
    const j = (k - i) / N
    const rx = -DIRS[d][1] * side
    const rz = DIRS[d][0] * side
    const ii = i + rx
    const jj = j + rz
    if (ii < 0 || jj < 0 || ii >= N || jj >= N) return true
    return !road[idx(ii, jj)]
  }
  return { road, nb, kind, axis, twin, oneway, carOut, walkOut, cluster, isJ, hasWalk }
}
