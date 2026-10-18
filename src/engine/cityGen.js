import {
  GRID,
  CELL,
  CELL_GRASS,
  CELL_ROAD,
  CELL_RIVER,
  CELL_BANK,
  CELL_PARK,
  CITY_TYPES,
  BUILDING_TYPES,
  RIVER_HALF_WIDTH,
  RIVER_DEPTH,
} from './config.js'
import { Rng, makeNoise2D, smoothstep, clamp } from './math.js'
import { placeSites } from './sites.js'

const NAMES_A = ['Port', 'New', 'North', 'East', 'West', 'Lake', 'Fort', 'Mount', 'San', 'Saint', 'Glen', 'Upper', 'Lower']
const NAMES_B = ['Halden', 'Corvin', 'Ashford', 'Marrow', 'Delmar', 'Kestrel', 'Valebrook', 'Aurora', 'Linden', 'Meridian', 'Solace', 'Cresta', 'Tarin', 'Riverton', 'Oakhurst', 'Bayview']

export const idx = (i, j) => j * GRID + i
export const cellToWorld = (i) => (i + 0.5) * CELL - (GRID * CELL) / 2
export const worldToCell = (x) => Math.floor((x + (GRID * CELL) / 2) / CELL)

// 0..1: how "daytime" the city is (people at work vs at home).
export function dayness(hour) {
  const h = ((hour % 24) + 24) % 24
  if (h >= 9 && h <= 17) return 1
  if (h >= 22 || h <= 6) return 0
  if (h < 9) return (h - 6) / 3
  return 1 - (h - 17) / 5
}

export function occupancyAt(b, hour) {
  const T = BUILDING_TYPES[b.type]
  if (b.type === 'shelter') return 0
  const d = dayness(hour)
  const cap = b.area / T.m2PerPerson
  return Math.round(cap * (T.night + (T.day - T.night) * d))
}

export function residentsOf(b) {
  const T = BUILDING_TYPES[b.type]
  if (!T.residentShare) return 0
  return Math.round((b.area / T.m2PerPerson) * T.residentShare)
}

/** The side of a lot that faces a street: 0 +z, 1 +x, 2 -z, 3 -x. */
export function streetSide(city, x, y, w, d, rng) {
  const road = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID && city.cellType[idx(i, j)] === CELL_ROAD
  const len = [0, 0, 0, 0]
  for (let i = x; i < x + w; i++) {
    if (road(i, y + d)) len[0]++
    if (road(i, y - 1)) len[2]++
  }
  for (let j = y; j < y + d; j++) {
    if (road(x + w, j)) len[1]++
    if (road(x - 1, j)) len[3]++
  }
  let best = rng ? rng.int(0, 3) : 0
  for (let s = 0; s < 4; s++) if (len[s] > len[best]) best = s
  return best
}

/** Builds a building record on lot (x,y,w,d) in cells. */
export function makeBuilding(city, rng, { type, x, y, w, d, floors, construction, facing, variant, arch, noIcon }) {
  const T = BUILDING_TYPES[type]
  const setback = { house: 3, apartment: 2.5, office: 1.8, tower: 3, industrial: 1.5, hospital: 2.5, fire: 2, school: 2.5, shelter: 2.5, civic: 2, museum: 2, library: 2, worship: 1.5, stadium: 1, landmark: 2.5 }[type] ?? 2
  let fw = w * CELL - 2 * setback - rng.float(0, type === 'house' ? 3 : 1.5)
  let fd = d * CELL - 2 * setback - rng.float(0, type === 'house' ? 3 : 1.5)
  if (type === 'house') {
    fw = Math.min(fw, 14)
    fd = Math.min(fd, 13)
  }
  if (type === 'tower') {
    fw = Math.min(fw, 38)
    fd = Math.min(fd, 38)
  }
  // slender monuments stand on a much smaller footprint than their plaza lot
  if (variant === 'clock') fw = fd = 9
  if (variant === 'needle') fw = fd = 12
  if (variant === 'arch') fd = Math.min(fd, 11)
  fw = Math.max(fw, 5)
  fd = Math.max(fd, 5)
  let zmin = Infinity
  let zmax = -Infinity
  let zsum = 0
  for (let j = y; j < y + d; j++)
    for (let i = x; i < x + w; i++) {
      const z = city.z[idx(i, j)]
      zmin = Math.min(zmin, z)
      zmax = Math.max(zmax, z)
      zsum += z
    }
  const floorH = T.floorH
  const height = floors * floorH + (type === 'house' ? 0 : 1)
  // usable floor area: a stadium is a ring of stands, monuments are mostly solid or open
  const fill = type === 'stadium' ? 0.45 : variant === 'needle' ? 0.2 : variant === 'arch' ? 0.25 : variant === 'clock' ? 0.6 : 1
  const area = fw * fd * floors * fill
  const b = {
    id: city.nextId++,
    type,
    x,
    y,
    w,
    d,
    cx: cellToWorld(x) + ((w - 1) * CELL) / 2,
    cz: cellToWorld(y) + ((d - 1) * CELL) / 2,
    fw,
    fd,
    floors,
    floorH,
    height,
    base: zmin - 0.4,
    groundZ: zsum / (w * d),
    floorZ: zmax + 0.2,
    construction,
    color: rng.pick(T.colors),
    roofColor: T.roofColors ? rng.pick(T.roofColors) : null,
    area,
    value: (area * T.costM2) / 1e6,
    elevated: 0,
    seed: rng.next(),
    removed: false,
    // which side faces the street: 0 +z, 1 +x, 2 -z, 3 -x
    facing: facing ?? streetSide(city, x, y, w, d, rng),
  }
  if (variant) b.variant = variant
  if (arch) b.arch = arch
  if (noIcon) b.noIcon = true
  b.residents = residentsOf(b)
  if (type === 'hospital') b.beds = Math.round(area / 45)
  if (type === 'shelter') b.capacity = Math.round(area / 3.5)
  return b
}

export function generateCity(typeKey, seed) {
  const rng = new Rng(seed)
  const nz = makeNoise2D(seed * 7 + 3)
  const P = CITY_TYPES[typeKey]
  const N = GRID
  const z = new Float32Array(N * N)
  const cellType = new Uint8Array(N * N)
  const soil = new Uint8Array(N * N) // 0 rock, 1 stiff, 2 soft alluvium
  const bridge = new Uint8Array(N * N)
  const buildingAt = new Int32Array(N * N).fill(-1)
  const levee = new Float32Array(N * N)
  const roadAxis = new Uint8Array(N * N) // bit 1: runs east–west, bit 2: runs north–south
  const riverCenter = new Float32Array(N)
  const bankZ = new Float32Array(N)

  const side = rng.chance(0.5) ? 1 : -1
  const baseX = N / 2 + side * rng.float(13, 20)
  const amp = rng.float(3, 7)
  const f1 = rng.float(0.7, 1.4)
  const ph = rng.float(0, Math.PI * 2)
  for (let j = 0; j < N; j++) {
    riverCenter[j] = baseX + amp * Math.sin((j / N) * Math.PI * 2 * f1 + ph) + nz.fbm(j * 0.05, 11.3, 2) * 4
    bankZ[j] = 20 - j * CELL * 0.0015
  }
  // The town grows on the wide side of the river, close to it (as towns do).
  const cx = clamp(N / 2 - side * rng.float(6, 12), 25, 75)
  const cy = clamp(N / 2 + rng.float(-8, 8), 30, 70)

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = idx(i, j)
      const d = Math.abs(i + 0.5 - riverCenter[j])
      if (d < RIVER_HALF_WIDTH) {
        // U-shaped channel: flat-ish bed, steep banks
        const t = d / RIVER_HALF_WIDTH
        z[k] = bankZ[j] - RIVER_DEPTH * (1 - Math.pow(t, 3.2)) + nz.fbm(i * 0.3, j * 0.3, 2) * 0.4
        cellType[k] = CELL_RIVER
        soil[k] = 2
        continue
      }
      const dd = d - RIVER_HALF_WIDTH
      // floodplain → river terrace → rolling hills → ridges at the valley edges
      const floodplain = Math.max(0, dd - 1.5) * 0.07
      const terrace = smoothstep(10, 20, dd + nz.fbm(i * 0.05 + 7, j * 0.05, 2) * 6) * 3.5
      const hills = (nz.fbm(i * 0.028, j * 0.028, 5) * 16 + 7) * smoothstep(14, 55, dd)
      const ridged = (1 - Math.abs(nz.fbm(i * 0.02 + 31, j * 0.02 + 17, 4))) ** 2
      const edge = Math.max(Math.abs(i - N / 2), Math.abs(j - N / 2)) / (N / 2)
      const ridges = ridged * 22 * smoothstep(0.62, 1.0, edge) * smoothstep(20, 45, dd)
      const micro = nz.fbm(i * 0.14 + 50, j * 0.14 + 50, 2) * 0.7 * smoothstep(1, 5, dd)
      z[k] = Math.max(bankZ[j] + 0.25, bankZ[j] + 0.45 + floodplain + terrace + Math.max(-2, hills) + ridges + micro)
      if (dd < 1.3) cellType[k] = CELL_BANK
      const above = z[k] - bankZ[j]
      soil[k] = dd < 18 && above < 2.5 ? 2 : above > 14 ? 0 : 1
    }
  }

  const city = {
    type: typeKey,
    seed,
    name: `${rng.pick(NAMES_A)} ${rng.pick(NAMES_B)}`,
    N,
    z,
    cellType,
    soil,
    bridge,
    buildingAt,
    levee,
    roadAxis,
    riverCenter,
    bankZ,
    center: { i: cx, j: cy },
    buildings: [],
    trees: [],
    pumps: [],
    ponds: [],
    // special sites (civic, campus, landmark…), parks, and the surface finish of their open ground
    sites: [],
    parks: [],
    ground: new Uint8Array(N * N),
    nextId: 0,
    dredged: false,
  }

  // ------------------------------------------------------------ roads
  const S = P.roadSpacing
  const ox = Math.round(cx) % S
  const oy = Math.round(cy) % S
  const lineIdx = (v, o) => Math.floor((v - o) / S)
  const isLine = (v, o) => (((v - o) % S) + S) % S === 0
  const wideAvenue = typeKey === 'megacity'
  const isMain = (v, o) => isLine(v, o) && ((lineIdx(v, o) % 3) + 3) % 3 === 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = idx(i, j)
      const dist = Math.hypot(i - cx, j - cy)
      const rx = isLine(i, ox) || (wideAvenue && isMain(i - 1, ox))
      const ry = isLine(j, oy) || (wideAvenue && isMain(j - 1, oy))
      if (!rx && !ry) continue
      const main = (rx && (isMain(i, ox) || isMain(i - 1, ox))) || (ry && (isMain(j, oy) || isMain(j - 1, oy)))
      const inCity = dist < P.radius
      if (!(inCity || (main && dist < P.radius * 2.2))) continue
      if (cellType[k] === CELL_RIVER) {
        if (ry && !rx && (main || inCity)) {
          bridge[k] = 1
          roadAxis[k] = 1
        }
        continue
      }
      if (cellType[k] === CELL_BANK && rx && !ry) continue
      cellType[k] = CELL_ROAD
      roadAxis[k] = (ry ? 1 : 0) | (rx ? 2 : 0)
    }
  }
  // remove bridges that don't connect roads on both banks
  for (let j = 0; j < N; j++) {
    let first = -1
    let last = -1
    for (let i = 0; i < N; i++) if (bridge[idx(i, j)]) (first < 0 && (first = i), (last = i))
    if (first < 0) continue
    const l = first > 0 && cellType[idx(first - 1, j)] === CELL_ROAD
    const r = last < N - 1 && cellType[idx(last + 1, j)] === CELL_ROAD
    if (!l || !r) for (let i = first; i <= last; i++) bridge[idx(i, j)] = 0
  }
  // Each bridge spans from the first ordinary road cell on one bank to the
  // first on the other; bank cells under the deck belong to the bridge.
  // Roads that reach the river without a bridge become dead ends.
  city.bridgeSpans = []
  for (let j = 0; j < N; j++) {
    let first = -1
    let last = -1
    for (let i = 0; i < N; i++) if (bridge[idx(i, j)]) (first < 0 && (first = i), (last = i))
    if (first >= 0) {
      let i0 = first - 1
      while (i0 > 0 && cellType[idx(i0, j)] === CELL_ROAD && z[idx(i0, j)] - bankZ[j] < 0.6 && Math.abs(i0 + 0.5 - riverCenter[j]) < RIVER_HALF_WIDTH + 1.6) i0--
      let i1 = last + 1
      while (i1 < N - 1 && cellType[idx(i1, j)] === CELL_ROAD && z[idx(i1, j)] - bankZ[j] < 0.6 && Math.abs(i1 + 0.5 - riverCenter[j]) < RIVER_HALF_WIDTH + 1.6) i1++
      for (let i = i0 + 1; i < i1; i++) bridge[idx(i, j)] = 1
      city.bridgeSpans.push({ j, i0, i1, h0: z[idx(i0, j)], h1: z[idx(i1, j)] })
    }
  }
  for (let k = 0; k < N * N; k++) {
    if (cellType[k] !== CELL_ROAD || bridge[k]) continue
    const i = k % N
    const d = Math.abs(i + 0.5 - riverCenter[(k - i) / N])
    if (d < RIVER_HALF_WIDTH + 1.3) cellType[k] = CELL_BANK
  }

  // ------------------------------------------------------------ lots
  const xs = []
  const ys = []
  for (let v = 0; v < N; v++) {
    if (isLine(v, ox)) xs.push(v)
    if (isLine(v, oy)) ys.push(v)
  }
  if (xs[0] > 0) xs.unshift(xs[0] - S)
  if (ys[0] > 0) ys.unshift(ys[0] - S)
  xs.push(xs[xs.length - 1] + S)
  ys.push(ys[ys.length - 1] + S)

  const split = (start, len) => {
    const segs = []
    let p = start
    let rem = len
    while (rem > 0) {
      let s = rng.pick(P.lotSizes)
      if (s > rem) s = rem
      if (rem - s === 1 && s > 1 && rem > 2) s -= 1
      segs.push([p, s])
      p += s
      rem -= s
    }
    return segs
  }

  const lotFree = (x, y, w, d) => {
    if (x < 1 || y < 1 || x + w > N - 1 || y + d > N - 1) return false
    for (let j = y; j < y + d; j++)
      for (let i = x; i < x + w; i++) if (cellType[idx(i, j)] !== CELL_GRASS || buildingAt[idx(i, j)] >= 0) return false
    // too steep to build on without major earthworks
    let zlo = Infinity
    let zhi = -Infinity
    for (let j = y; j < y + d; j++)
      for (let i = x; i < x + w; i++) {
        zlo = Math.min(zlo, z[idx(i, j)])
        zhi = Math.max(zhi, z[idx(i, j)])
      }
    return zhi - zlo < 1.6 * Math.max(w, d)
  }

  const blocks = []
  for (let a = 0; a < xs.length - 1; a++) {
    for (let bI = 0; bI < ys.length - 1; bI++) {
      let x0 = xs[a] + 1
      let y0 = ys[bI] + 1
      if (wideAvenue && isMain(xs[a], ox)) x0++
      if (wideAvenue && isMain(ys[bI], oy)) y0++
      blocks.push({ x0, y0, w: xs[a + 1] - x0, d: ys[bI + 1] - y0 })
    }
  }

  // civic centre, museums, campuses, schools, landmarks and parks claim their sites first
  const slopeOk = (x, y, w, d) => {
    let zlo = Infinity
    let zhi = -Infinity
    for (let j = y; j < y + d; j++)
      for (let i = x; i < x + w; i++) {
        zlo = Math.min(zlo, z[idx(i, j)])
        zhi = Math.max(zhi, z[idx(i, j)])
      }
    return zhi - zlo < 1.2 * Math.max(w, d)
  }
  placeSites({ city, rng, P, blocks, cx, cy, N, idx, slopeOk, add: (spec) => addBuilding(city, rng, spec) })

  const minLot = { house: 1, apartment: 2, office: 2, tower: 3, industrial: 2 }
  for (const B of blocks) {
    for (const [lx, lw] of split(B.x0, B.w)) {
      for (const [ly, ld] of split(B.y0, B.d)) {
        if (!lotFree(lx, ly, lw, ld)) continue
        const dist = Math.hypot(lx + lw / 2 - cx, ly + ld / 2 - cy)
        const r = dist / P.radius
        const p = r < 1 ? P.fill * (1 - 0.35 * r * r) : P.outerFill * Math.exp(-(dist - P.radius) / 12)
        if (!rng.chance(p)) continue
        if (rng.chance(P.parkChance) && r < 1) {
          for (let j = ly; j < ly + ld; j++) for (let i = lx; i < lx + lw; i++) cellType[idx(i, j)] = CELL_PARK
          city.parks.push({ x: lx, y: ly, w: lw, d: ld })
          continue
        }
        const zone = r < 0.3 ? 'core' : r < 0.7 ? 'mid' : 'outer'
        let type = rng.weighted(P.zones[zone])
        const lotMin = Math.min(lw, ld)
        if (lotMin < minLot[type]) type = lotMin >= 2 && type === 'tower' ? 'office' : 'house'
        const [fmin, fmax] = P.floors[type]
        let floors = rng.int(fmin, fmax)
        if (type === 'tower' || type === 'office') floors = Math.max(fmin, Math.round(floors * (1.15 - 0.5 * r)))
        addBuilding(city, rng, { type, x: lx, y: ly, w: lw, d: ld, floors, construction: rng.weighted(P.mix[type]) })
      }
    }
  }

  // ------------------------------------------------------------ facilities
  const convert = (count, type, minSize, spread) => {
    const chosen = []
    for (let n = 0; n < count; n++) {
      let best = null
      let bestScore = -Infinity
      for (const b of city.buildings) {
        if (BUILDING_TYPES[b.type].facility || BUILDING_TYPES[b.type].landmark || b.variant || Math.min(b.w, b.d) < minSize) continue
        const dc = Math.hypot(b.x - cx, b.y - cy) / P.radius
        if (dc > 0.9) continue
        let score = rng.next() * 0.3 - dc * 0.2
        if (spread) {
          let dmin = 1e9
          for (const c of chosen) dmin = Math.min(dmin, Math.hypot(b.x - c.x, b.y - c.y))
          score += chosen.length ? Math.min(dmin, 60) / 20 : 0
        }
        if (score > bestScore) {
          bestScore = score
          best = b
        }
      }
      if (!best) break
      const [fmin, fmax] = P.floors[type]
      const nb = makeBuilding(city, rng, {
        type,
        x: best.x,
        y: best.y,
        w: best.w,
        d: best.d,
        floors: rng.int(fmin, fmax),
        construction: rng.weighted(P.mix[type]),
      })
      nb.id = best.id
      city.buildings[city.buildings.indexOf(best)] = nb
      chosen.push(nb)
    }
  }
  convert(P.hospitals, 'hospital', 3, true)
  convert(P.fireStations, 'fire', 2, true)

  // ------------------------------------------------------------ trees
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const k = idx(i, j)
      const t = cellType[k]
      if (buildingAt[k] >= 0) continue
      let p = 0
      // parks are wooded around their paths; plazas get a few planters, playing fields none
      if (t === CELL_PARK) p = [0.75, 0.06, 0, 0.05, 0.3][city.ground[k]]
      else if (t === CELL_GRASS) {
        const dist = Math.hypot(i - cx, j - cy)
        p = dist < P.radius ? P.treeDensity : P.treeDensity * 1.6 * (0.5 + 0.5 * nz.fbm(i * 0.08, j * 0.08, 2))
      } else if (t === CELL_BANK) p = 0.25
      if (rng.chance(p)) {
        const n = t === CELL_PARK ? rng.int(1, 3) : 1
        for (let q = 0; q < n; q++)
          city.trees.push({ i, j, ox: rng.float(-3.5, 3.5), oz: rng.float(-3.5, 3.5), s: rng.float(0.7, 1.3), kind: rng.chance(0.3) ? 1 : 0 })
      }
    }
  }

  city.byId = new Map(city.buildings.map((b) => [b.id, b]))
  city.urbanCells = 0
  for (let k = 0; k < N * N; k++) if (cellType[k] === CELL_ROAD || buildingAt[k] >= 0) city.urbanCells++
  return city
}

export function addBuilding(city, rng, spec) {
  const b = makeBuilding(city, rng, spec)
  city.buildings.push(b)
  if (city.byId) city.byId.set(b.id, b)
  for (let j = b.y; j < b.y + b.d; j++) for (let i = b.x; i < b.x + b.w; i++) city.buildingAt[idx(i, j)] = b.id
  return b
}

export function buildingById(city, id) {
  return city.byId.get(id) ?? null
}

export function cityStats(city, hour) {
  let residents = 0
  let present = 0
  let count = 0
  for (const b of city.buildings) {
    if (b.removed) continue
    count++
    residents += b.residents
    present += occupancyAt(b, hour)
  }
  return { residents, present, count }
}

export { CELL_ROAD, CELL_RIVER, CELL_BANK, CELL_PARK, CELL_GRASS }
