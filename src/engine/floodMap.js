// Flood-prone land, for planning before the storm: how deep water would
// stand on every cell of the district.
//  • River flooding: the river rises to `level` metres above its banks (the
//    water surface follows the river's slope, row by row). Water spreads
//    from the channel to every cell it can reach whose ground is below that
//    surface — flood walls raise the ground they stand on, so land behind a
//    continuous wall stays dry, as long as the wall holds. This is the
//    "connected bathtub" inundation map used for quick flood-hazard maps.
//  • Rain ponding: hollows with no way out fill with rain even where the
//    river never reaches (depression filling, Barnes et al. 2014 priority
//    flood). How deep they fill is capped by how much rain can run into them.

import { GRID, CELL_RIVER } from './config.js'

// display bands (m): shallow, wading-dangerous, deadly for people, above a storey
export const DEPTH_BANDS = [
  { max: 0.3, label: '< 0.3 m', note: 'Streets wet, kerbs covered', color: [125, 211, 252] },
  { max: 0.8, label: '0.3–0.8 m', note: 'Cars float, wading is dangerous', color: [56, 152, 236] },
  { max: 1.5, label: '0.8–1.5 m', note: 'Ground floors flooded', color: [30, 90, 200] },
  { max: 3, label: '1.5–3 m', note: 'Deadly: low-rise homes fill up', color: [76, 40, 170] },
  { max: Infinity, label: '> 3 m', note: 'Above the first storey', color: [150, 20, 110] },
]
export const depthBand = (d) => DEPTH_BANDS.findIndex((b) => d < b.max)

/** Ground the water has to get over: the terrain plus any flood wall on it. */
const top = (city, k) => city.z[k] + city.levee[k]

/** Depth (m) of river water on each cell with the river `level` m above its banks. */
export function riverFloodDepth(city, level) {
  const N = GRID
  const depth = new Float32Array(N * N)
  const seen = new Uint8Array(N * N)
  const q = new Int32Array(N * N)
  let h = 0
  let t = 0
  const surface = (j) => city.bankZ[j] + level
  for (let k = 0; k < N * N; k++)
    if (city.cellType[k] === CELL_RIVER) {
      seen[k] = 1
      q[t++] = k
    }
  while (h < t) {
    const k = q[h++]
    const i = k % N
    const j = (k - i) / N
    for (let d = 0; d < 4; d++) {
      const ii = i + (d === 0 ? 1 : d === 1 ? -1 : 0)
      const jj = j + (d === 2 ? 1 : d === 3 ? -1 : 0)
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
      const kk = jj * N + ii
      if (seen[kk]) continue
      const W = surface(jj)
      if (top(city, kk) >= W) continue
      seen[kk] = 1
      depth[kk] = W - city.z[kk]
      q[t++] = kk
    }
  }
  return depth
}

/**
 * Depth (m) rain would pond to in closed hollows. maxDepth caps it: a hollow
 * only fills as far as the rain running into it allows.
 */
export function pondDepth(city, maxDepth) {
  const N = GRID
  const filled = new Float32Array(N * N)
  const done = new Uint8Array(N * N)
  // binary min-heap of cells by water level; outlets are the district's edges and the river
  const heap = []
  const push = (k, z) => {
    heap.push([z, k])
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const r = heap[0]
    const last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const rr = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return r
  }
  for (let k = 0; k < N * N; k++) {
    const i = k % N
    const j = (k - i) / N
    if (i === 0 || j === 0 || i === N - 1 || j === N - 1 || city.cellType[k] === CELL_RIVER) {
      done[k] = 1
      filled[k] = top(city, k)
      push(k, filled[k])
    }
  }
  while (heap.length) {
    const [z, k] = pop()
    const i = k % N
    const j = (k - i) / N
    for (let d = 0; d < 4; d++) {
      const ii = i + (d === 0 ? 1 : d === 1 ? -1 : 0)
      const jj = j + (d === 2 ? 1 : d === 3 ? -1 : 0)
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
      const kk = jj * N + ii
      if (done[kk]) continue
      done[kk] = 1
      filled[kk] = Math.max(top(city, kk), z)
      push(kk, filled[kk])
    }
  }
  const depth = new Float32Array(N * N)
  for (let k = 0; k < N * N; k++) {
    const d = filled[k] - top(city, k)
    if (d > 0.05) depth[k] = Math.min(d, maxDepth)
  }
  return depth
}

/**
 * The combined map: river flooding at `level`, and ponding from `rainMm` of
 * rain (local runoff concentrates ~3× into the hollows). Returns per-cell
 * depth and its source (1 river, 2 ponding), plus totals.
 */
export function floodMap(city, level, rainMm) {
  const N = GRID
  const river = riverFloodDepth(city, level)
  const pond = pondDepth(city, Math.max(0.05, (rainMm / 1000) * 3))
  const depth = new Float32Array(N * N)
  const source = new Uint8Array(N * N)
  let cells = 0
  let max = 0
  for (let k = 0; k < N * N; k++) {
    if (city.cellType[k] === CELL_RIVER) continue
    const r = river[k]
    const p = pond[k]
    const d = Math.max(r, p)
    if (d <= 0.02) continue
    depth[k] = d
    source[k] = r >= p ? 1 : 2
    if (d > 0.1) cells++
    if (d > max) max = d
  }
  return { level, depth, source, areaHa: (cells * 100) / 1e4, maxDepth: max }
}
