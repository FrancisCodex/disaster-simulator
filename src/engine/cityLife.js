// City life: traffic (lanes, car-following, working traffic signals),
// pedestrians on the sidewalks who cross at crosswalks on a green, street
// lights — and how they all react to a disaster.
//  • Earthquake: drivers brake, people run away from buildings to open ground,
//    falling debris crushes cars (some catch fire) and strikes pedestrians.
//  • Flood: cars stall, then float off with the current; people head indoors
//    or to high ground; anyone caught in deep moving water is swept away.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GRID, CELL, CELL_ROAD, CELL_RIVER, CELL_POND, CELL_PARK } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { clamp } from './math.js'
import { vehicleGeometry, vehicleMaterial, VEHICLE_TYPES, VEHICLE_LENGTH, personGeometry, personMaterial } from './assets.js'
import { KERB } from './roads.js'

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]
const right = (d) => [-DIRS[d][1], DIRS[d][0]]
const dirOf = (x, z) => (x > 0.5 ? 0 : z > 0.5 ? 1 : x < -0.5 ? 2 : 3)
const CAR_COLORS = ['#f2f2f0', '#f2f2f0', '#e9e9e6', '#1c1d20', '#1c1d20', '#9aa0a6', '#6b7178', '#b3261e', '#1f4e8c', '#2f5d3a', '#d8c9a3', '#8a5a2b', '#3b4a5c']
const SHIRTS = ['#c0392b', '#2c3e50', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad', '#ecf0f1', '#e67e22', '#34495e', '#95a5a6', '#d35400', '#16a085', '#f5f0e6']
const PANTS = ['#2b2f3a', '#1f2a44', '#3d3a36', '#5b5248', '#20232a', '#4a5a6a', '#6b5a45', '#cfc6b4']
const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#a86b4a', '#7a4b33', '#5a3825']
const HAIR = ['#1b1512', '#2f2119', '#5a3c22', '#8a6a3b', '#b8a07a', '#6e6e6e']
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _s = new THREE.Vector3()
const _p = new THREE.Vector3()
const _c = new THREE.Color()
const HALF = (GRID * CELL) / 2
const LANE = 2.3 // lane offset from the road centre line
const WALK = 4.1 // sidewalk path offset from the road centre line

function lightsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: { value: 0 }, uScale: { value: 900 } },
    vertexShader: `attribute vec3 aCol; attribute float aSize; varying vec3 vCol; uniform float uScale;
      void main(){ vCol = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uNight; varying vec3 vCol;
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = exp(-r * r * 4.0) * uNight; if (a < 0.01) discard; gl_FragColor = vec4(vCol * a, 1.0);
      #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length)]

export class CityLife {
  constructor(scene, world) {
    this.scene = scene
    this.world = world
    this.group = new THREE.Group()
    scene.add(this.group)
    this.vehicleGeos = Object.fromEntries(VEHICLE_TYPES.map((t) => [t, vehicleGeometry(t)]))
    this.personGeo = personGeometry()
    this.stats = { pedDead: 0, carDead: 0, carsCrushed: 0, swept: 0 }
    this.time = 0
  }

  dispose() {
    for (const c of [...this.group.children]) {
      this.group.remove(c)
      if (!Object.values(this.vehicleGeos).includes(c.geometry) && c.geometry !== this.personGeo) c.geometry?.dispose()
      c.material?.dispose?.()
    }
  }

  build(city, hour = 12, rng = Math.random) {
    this.dispose()
    this.city = city
    this.stats = { pedDead: 0, carDead: 0, carsCrushed: 0, swept: 0 }
    const N = GRID
    const road = new Uint8Array(N * N)
    for (let k = 0; k < N * N; k++) road[k] = city.cellType[k] === CELL_ROAD || city.bridge[k] ? 1 : 0
    this.road = road
    this.blocked = new Uint8Array(N * N)
    const nbr = new Uint8Array(N * N)
    const inter = new Uint8Array(N * N)
    const roadCells = []
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = idx(i, j)
        if (!road[k]) continue
        let m = 0
        let c = 0
        DIRS.forEach(([dx, dz], d) => {
          const ii = i + dx
          const jj = j + dz
          if (ii >= 0 && jj >= 0 && ii < N && jj < N && road[idx(ii, jj)]) {
            m |= 1 << d
            c++
          }
        })
        nbr[k] = m
        if (c >= 3) inter[k] = 1
        if (c >= 1) roadCells.push(k)
      }
    this.nbr = nbr
    this.inter = inter
    this.signalOffset = new Float32Array(N * N)
    for (let k = 0; k < N * N; k++) if (inter[k]) this.signalOffset[k] = rng() * 30

    const base = { rural: [40, 110], metropolis: [230, 560], megacity: [440, 1150] }[city.type]
    // fewer people out late at night, rush-hour peaks in the morning and evening
    const h = ((hour % 24) + 24) % 24
    const activity = h < 5 ? 0.15 : h < 7 ? 0.45 : h < 10 ? 1 : h < 16 ? 0.85 : h < 20 ? 1 : h < 23 ? 0.5 : 0.25
    const counts = [Math.round(base[0] * Math.max(0.3, activity)), Math.round(base[1] * activity)]

    // ---------------- vehicles
    this.cars = []
    const mix = city.type === 'rural' ? { sedan: 0.3, hatch: 0.2, suv: 0.3, van: 0.12, truck: 0.08 } : { sedan: 0.36, hatch: 0.22, suv: 0.2, van: 0.1, truck: 0.05, bus: 0.07 }
    const usable = roadCells.filter((k) => nbr[k] && !inter[k] && !city.bridge[k])
    for (let n = 0; n < counts[0] && usable.length; n++) {
      const k = usable[Math.floor(rng() * usable.length)]
      const dirs = [0, 1, 2, 3].filter((d) => nbr[k] & (1 << d))
      let r = rng()
      let type = 'sedan'
      for (const [t, w] of Object.entries(mix)) if ((r -= w) <= 0) {
        type = t
        break
      }
      const heavy = type === 'bus' || type === 'truck'
      this.cars.push({
        k,
        dir: dirs[Math.floor(rng() * dirs.length)],
        t: rng(),
        speed: 0,
        max: (heavy ? 9 : 10.5 + rng() * 4.5) * (city.type === 'megacity' ? 0.85 : 1),
        type,
        len: VEHICLE_LENGTH[type],
        color: type === 'bus' ? (rng() < 0.5 ? '#e0b12b' : '#d9dde0') : type === 'truck' ? '#f2f2f0' : pick(CAR_COLORS, rng),
        x: 0,
        z: 0,
        y: 0,
        yaw: 0,
        state: 'drive',
        occupants: type === 'bus' ? 12 + Math.floor(rng() * 20) : 1 + Math.floor(rng() * 2),
        wait: 0,
        roll: 0,
        init: true,
      })
    }
    this.vMeshes = {}
    for (const type of VEHICLE_TYPES) {
      const list = this.cars.filter((c) => c.type === type)
      const mesh = new THREE.InstancedMesh(this.vehicleGeos[type], vehicleMaterial(this.world.envTexture), Math.max(1, list.length))
      mesh.count = list.length
      mesh.castShadow = true
      list.forEach((c, i) => {
        c.mesh = mesh
        c.mi = i
        mesh.setColorAt(i, _c.set(c.color))
      })
      this.world.trackEnv?.(mesh.material)
      this.vMeshes[type] = mesh
      this.group.add(mesh)
    }

    // head/tail-light glow sprites
    const nl = this.cars.length * 2
    const lgeo = new THREE.BufferGeometry()
    this.lightPos = new Float32Array(Math.max(1, nl) * 3)
    const lcol = new Float32Array(Math.max(1, nl) * 3)
    const lsize = new Float32Array(Math.max(1, nl))
    for (let i = 0; i < this.cars.length; i++) {
      lcol.set([1.0, 0.92, 0.7], i * 6)
      lcol.set([1.0, 0.12, 0.08], i * 6 + 3)
      lsize[i * 2] = 3.2
      lsize[i * 2 + 1] = 1.6
    }
    lgeo.setAttribute('position', new THREE.BufferAttribute(this.lightPos, 3).setUsage(THREE.DynamicDrawUsage))
    lgeo.setAttribute('aCol', new THREE.BufferAttribute(lcol, 3))
    lgeo.setAttribute('aSize', new THREE.BufferAttribute(lsize, 1))
    this.carLights = new THREE.Points(lgeo, lightsMaterial())
    this.carLights.frustumCulled = false
    this.group.add(this.carLights)

    // ---------------- pedestrians
    this.peds = []
    const walkable = roadCells.filter((k) => nbr[k] && !inter[k])
    for (let n = 0; n < counts[1] && walkable.length; n++) {
      const k = walkable[Math.floor(rng() * walkable.length)]
      const dirs = [0, 1, 2, 3].filter((d) => nbr[k] & (1 << d))
      this.peds.push({
        k,
        dir: dirs[Math.floor(rng() * dirs.length)],
        t: rng(),
        side: rng() < 0.5 ? 1 : -1,
        speed: 1.15 + rng() * 0.5,
        x: 0,
        z: 0,
        y: 0,
        yaw: 0,
        mode: 'walk',
        phase: rng() * 10,
        panic: 2.8 + rng() * 2,
        color: pick(SHIRTS, rng),
        init: true,
        plan: null,
      })
    }
    const pg = this.personGeo.clone()
    const np = Math.max(1, this.peds.length)
    const pants = new Float32Array(np * 3)
    const skin = new Float32Array(np * 3)
    const hair = new Float32Array(np * 3)
    this.pedWalk = new THREE.InstancedBufferAttribute(new Float32Array(np * 2), 2).setUsage(THREE.DynamicDrawUsage)
    this.peds.forEach((p, i) => {
      _c.set(pick(PANTS, rng)).toArray(pants, i * 3)
      _c.set(pick(SKIN, rng)).toArray(skin, i * 3)
      _c.set(pick(HAIR, rng)).toArray(hair, i * 3)
    })
    pg.setAttribute('aPants', new THREE.InstancedBufferAttribute(pants, 3))
    pg.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3))
    pg.setAttribute('aHair', new THREE.InstancedBufferAttribute(hair, 3))
    pg.setAttribute('aWalk', this.pedWalk)
    this.pedMesh = new THREE.InstancedMesh(pg, personMaterial(), np)
    this.pedMesh.count = this.peds.length
    this.pedMesh.castShadow = true
    this.peds.forEach((p, i) => this.pedMesh.setColorAt(i, _c.set(p.color)))
    this.group.add(this.pedMesh)

    this.buildStreetLights()
    this.buildSignals()
    this.buildFields()
  }

  // ------------------------------------------------------------ traffic signals
  /** 'G' | 'Y' | 'R' for traffic travelling in `dir` through intersection k. */
  signalState(k, dir) {
    const t = (this.time + this.signalOffset[k]) % 30
    if (dir % 2 === 0) return t < 11 ? 'G' : t < 13 ? 'Y' : 'R'
    return t < 15 ? 'R' : t < 26 ? 'G' : t < 28 ? 'Y' : 'R'
  }

  buildSignals() {
    const { city, inter, road } = this
    const heads = []
    for (let k = 0; k < GRID * GRID; k++) {
      if (!inter[k] || city.bridge[k]) continue
      const i = k % GRID
      const j = (k - i) / GRID
      for (let d = 0; d < 4; d++) {
        // signal for traffic arriving in direction d, on the near-right corner
        const fi = i - DIRS[d][0]
        const fj = j - DIRS[d][1]
        if (fi < 0 || fj < 0 || fi >= GRID || fj >= GRID || !road[idx(fi, fj)]) continue
        const [rx, rz] = right(d)
        const x = cellToWorld(i) - DIRS[d][0] * 4.7 + rx * 4.7
        const z = cellToWorld(j) - DIRS[d][1] * 4.7 + rz * 4.7
        heads.push({ k, d, x, z, y: this.world.groundAt(x, z) + KERB, yaw: Math.atan2(DIRS[d][1], -DIRS[d][0]) })
      }
    }
    this.signals = heads
    const n = Math.max(1, heads.length)
    const pole = new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6).translate(0, 2.1, 0)
    const box = new THREE.BoxGeometry(0.34, 1.0, 0.3).translate(0, 3.85, 0)
    const poleMesh = new THREE.InstancedMesh(mergeGeometries([pole, box]), new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.5, metalness: 0.4 }), n)
    const lampGeo = new THREE.CircleGeometry(0.11, 10)
    this.signalLamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), n * 3)
    heads.forEach((s, q) => {
      _m.makeRotationY(s.yaw).setPosition(s.x, s.y, s.z)
      poleMesh.setMatrixAt(q, _m)
      for (let l = 0; l < 3; l++) {
        // lamps face oncoming traffic
        const bx = -DIRS[s.d][0]
        const bz = -DIRS[s.d][1]
        _q.setFromEuler(_e.set(0, Math.atan2(bx, bz), 0))
        _p.set(s.x + bx * 0.16, s.y + 4.17 - l * 0.31, s.z + bz * 0.16)
        _m.compose(_p, _q, _s.set(1, 1, 1))
        this.signalLamps.setMatrixAt(q * 3 + l, _m)
      }
    })
    poleMesh.count = heads.length
    this.signalLamps.count = heads.length * 3
    poleMesh.castShadow = true
    this.group.add(poleMesh, this.signalLamps)
    this.signalTimer = 1
  }

  updateSignals(dt) {
    this.signalTimer += dt
    if (this.signalTimer < 0.2 || !this.signals.length) return
    this.signalTimer = 0
    const off = [0.18, 0.05, 0.04]
    this.signals.forEach((s, q) => {
      const st = this.signalState(s.k, s.d)
      const lit = [st === 'R', st === 'Y', st === 'G']
      const cols = [
        [1, 0.12, 0.08],
        [1, 0.72, 0.1],
        [0.2, 1, 0.45],
      ]
      for (let l = 0; l < 3; l++) {
        const c = cols[l]
        const k = lit[l] ? 1.6 : off[l] + 0.08
        this.signalLamps.setColorAt(q * 3 + l, _c.setRGB(c[0] * k, c[1] * k, c[2] * k))
      }
    })
    this.signalLamps.instanceColor.needsUpdate = true
  }

  // ------------------------------------------------------------ street lights
  buildStreetLights() {
    const { city, road } = this
    const N = GRID
    const lamps = []
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = idx(i, j)
        if (!road[k] || this.inter[k] || (i + j) % 2) continue
        // place on a kerb that faces non-road land
        for (let d = 0; d < 4; d++) {
          const [dx, dz] = DIRS[d]
          const ii = i + dx
          const jj = j + dz
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
          const kk = idx(ii, jj)
          if (road[kk]) continue
          const onBridge = city.bridge[k]
          if (city.cellType[kk] === CELL_RIVER && !onBridge) continue
          const x = cellToWorld(i) + dx * 4.4
          const z = cellToWorld(j) + dz * 4.4
          const y = onBridge ? (this.world.deckAt(x, z) ?? this.world.groundAt(x, z)) : this.world.groundAt(x, z) + KERB
          lamps.push({ x, z, y, dx: -dx, dz: -dz })
          break
        }
      }
    this.lamps = lamps
    const n = Math.max(1, lamps.length)
    const pole = new THREE.CylinderGeometry(0.09, 0.13, 7.5, 6).translate(0, 3.75, 0)
    const arm = new THREE.CylinderGeometry(0.05, 0.05, 1.8, 5).rotateZ(Math.PI / 2).translate(0.9, 7.4, 0)
    const poleMesh = new THREE.InstancedMesh(mergeGeometries([pole, arm]), new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.5, metalness: 0.6 }), n)
    const headMat = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: 0xffd9a0, emissiveIntensity: 0 })
    this.lampHeadMat = headMat
    const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.75, 0.14, 0.36).translate(1.75, 7.32, 0), headMat, n)
    const glowGeo = new THREE.BufferGeometry()
    const gp = new Float32Array(n * 3)
    const gc = new Float32Array(n * 3)
    const gs = new Float32Array(n)
    lamps.forEach((l, q) => {
      const yaw = Math.atan2(-l.dz, l.dx)
      _m.makeRotationY(yaw).setPosition(l.x, l.y, l.z)
      poleMesh.setMatrixAt(q, _m)
      heads.setMatrixAt(q, _m)
      gp.set([l.x + l.dx * 1.75, l.y + 7.15, l.z + l.dz * 1.75], q * 3)
      gc.set([1.0, 0.8, 0.5], q * 3)
      gs[q] = 5
    })
    poleMesh.count = heads.count = lamps.length
    poleMesh.castShadow = true
    glowGeo.setAttribute('position', new THREE.BufferAttribute(gp, 3))
    glowGeo.setAttribute('aCol', new THREE.BufferAttribute(gc, 3))
    glowGeo.setAttribute('aSize', new THREE.BufferAttribute(gs, 1))
    this.lampGlow = new THREE.Points(glowGeo, lightsMaterial())
    this.lampGlow.frustumCulled = false
    this.group.add(poleMesh, heads, this.lampGlow)
  }

  /** Light pools under street lamps, painted into the ground's emissive map. */
  paintLampMap(ctx, size) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, size, size)
    ctx.globalCompositeOperation = 'lighter'
    const s = size / (GRID * CELL)
    for (const l of this.lamps || []) {
      const x = (l.x + l.dx * 1.75 + HALF) * s
      const y = (l.z + l.dz * 1.75 + HALF) * s
      const r = 13 * s
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(255,205,140,0.85)')
      g.addColorStop(0.45, 'rgba(255,190,120,0.35)')
      g.addColorStop(1, 'rgba(255,180,110,0)')
      ctx.fillStyle = g
      ctx.fillRect(x - r, y - r, r * 2, r * 2)
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  // ------------------------------------------------------------ escape fields
  /** Multi-source BFS: every walkable cell gets the direction to the nearest target. */
  field(isTarget) {
    const N = GRID
    const { city } = this
    const next = new Int8Array(N * N).fill(-2)
    const q = new Int32Array(N * N)
    let h = 0
    let t = 0
    const walk = (k) => (city.buildingAt[k] < 0 && city.cellType[k] !== CELL_RIVER && city.cellType[k] !== CELL_POND) || city.bridge[k]
    for (let k = 0; k < N * N; k++)
      if (walk(k) && isTarget(k)) {
        next[k] = -1
        q[t++] = k
      }
    while (h < t) {
      const k = q[h++]
      const i = k % N
      const j = (k - i) / N
      for (let d = 0; d < 4; d++) {
        const ii = i + DIRS[d][0]
        const jj = j + DIRS[d][1]
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
        const kk = idx(ii, jj)
        if (next[kk] !== -2 || !walk(kk)) continue
        next[kk] = (d + 2) % 4 // step back toward k
        q[t++] = kk
      }
    }
    return next
  }

  buildFields() {
    const { city } = this
    const N = GRID
    const dist = new Uint8Array(N * N).fill(255)
    const q = []
    for (let k = 0; k < N * N; k++)
      if (city.buildingAt[k] >= 0) {
        dist[k] = 0
        q.push(k)
      }
    for (let h = 0; h < q.length; h++) {
      const k = q[h]
      const i = k % N
      const j = (k - i) / N
      for (const [dx, dz] of DIRS) {
        const ii = i + dx
        const jj = j + dz
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue
        const kk = idx(ii, jj)
        if (dist[kk] <= dist[k] + 1) continue
        dist[kk] = dist[k] + 1
        q.push(kk)
      }
    }
    let need = 3
    let count = 0
    for (let k = 0; k < N * N; k++) if (dist[k] >= need) count++
    if (count < 30) need = 2
    this.safeField = this.field((k) => dist[k] >= need || city.cellType[k] === CELL_PARK)
    const zs = []
    for (let k = 0; k < N * N; k++) if (city.cellType[k] !== CELL_RIVER) zs.push(city.z[k] - city.bankZ[Math.floor(k / N)])
    zs.sort((a, b) => a - b)
    const high = Math.max(5, zs[Math.floor(zs.length * 0.75)])
    this.highField = this.field((k) => city.z[k] - city.bankZ[Math.floor(k / N)] >= high)
  }

  // ------------------------------------------------------------ helpers
  cellOf(x, z) {
    const i = clamp(Math.floor((x + HALF) / CELL), 0, GRID - 1)
    const j = clamp(Math.floor((z + HALF) / CELL), 0, GRID - 1)
    return idx(i, j)
  }

  heightAt(k, x, z) {
    if (this.city.bridge[k]) return this.world.deckAt(x, z) ?? this.world.groundAt(x, z)
    return this.world.groundAt(x, z) + 0.06
  }

  /** Is (x,z) on the carriageway (as opposed to a sidewalk or open ground)? */
  onCarriageway(k, x, z) {
    if (!this.road[k]) return false
    const i = k % GRID
    const j = (k - i) / GRID
    const dx = Math.abs(x - cellToWorld(i))
    const dz = Math.abs(z - cellToWorld(j))
    if (this.inter[k]) return !(dx > 2.8 && dz > 2.8)
    const ew = this.nbr[k] & 0b0101
    const ns = this.nbr[k] & 0b1010
    if (ew && !ns) return dz < 2.8
    if (ns && !ew) return dx < 2.8
    return dx < 2.8 || dz < 2.8
  }

  blockAround(b) {
    // rubble spills into the street around a collapsed building
    for (let j = b.y - 1; j <= b.y + b.d; j++)
      for (let i = b.x - 1; i <= b.x + b.w; i++) {
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
        const k = idx(i, j)
        if (this.road[k] && Math.random() < 0.6) this.blocked[k] = 1
      }
  }

  /** Something heavy landed at (x,z): crush cars, strike pedestrians. */
  hitArea(x, z, r, energy) {
    let killed = 0
    let crushed = 0
    if (energy < 4000) return { killed, crushed }
    for (const p of this.peds) {
      if (p.mode === 'dead' || p.mode === 'indoors') continue
      if (Math.hypot(p.x - x, p.z - z) < r + 0.5) {
        p.mode = 'dead'
        p.cause = 'debris'
        this.stats.pedDead++
        killed++
      }
    }
    if (energy > 30000) {
      for (const c of this.cars) {
        if (c.state === 'crushed' || c.state === 'burnt') continue
        if (Math.hypot(c.x - x, c.z - z) < r + c.len * 0.45) {
          c.state = 'crushed'
          c.fire = Math.random() < 0.35 ? 60 + Math.random() * 60 : 0
          this.stats.carsCrushed++
          const dead = Math.round(c.occupants * (Math.random() < 0.6 ? 0.7 : 0.2))
          this.stats.carDead += dead
          killed += dead
          crushed++
        }
      }
    }
    return { killed, crushed }
  }

  // ------------------------------------------------------------ update
  /**
   * ctx: { shaking (g), quake, quakeT (s since main shock), flood, warned,
   *        depthAt(k), flowAt(i,j) → [vx,vz], night (0..1) }
   */
  update(dt, ctx) {
    if (!this.cars) return
    dt = Math.min(dt, 0.05)
    this.time += dt
    const shaking = ctx.shaking || 0
    // pedestrians currently out on the carriageway, per cell (for drivers to yield)
    this.crossing = new Map()
    for (const p of this.peds) {
      if (p.mode === 'dead' || p.mode === 'indoors') continue
      const k = this.cellOf(p.x, p.z)
      if (!this.onCarriageway(k, p.x, p.z)) continue
      let a = this.crossing.get(k)
      if (!a) this.crossing.set(k, (a = []))
      a.push(p)
    }
    this.updateSignals(dt)
    this.updateCars(dt, ctx, shaking)
    this.updatePeds(dt, ctx, shaking)
    this.carLights.material.uniforms.uNight.value = ctx.night
    this.lampGlow.material.uniforms.uNight.value = ctx.night
    this.lampHeadMat.emissiveIntensity = ctx.night * 3
  }

  pedAhead(c, k, fx, fz, rx, rz) {
    for (const p of this.crossing.get(k) || []) {
      const ax = p.x - c.x
      const az = p.z - c.z
      const along = ax * fx + az * fz
      const lat = Math.abs(ax * rx + az * rz)
      if (along > 0 && along < c.len * 0.5 + 9 && lat < 2.6) return along - c.len * 0.5
    }
    return 99
  }

  updateCars(dt, ctx, shaking) {
    const { cars, nbr, inter, blocked } = this
    const lanes = new Map()
    for (const c of cars) {
      if (c.state !== 'drive') continue
      const key = c.k * 4 + c.dir
      let a = lanes.get(key)
      if (!a) lanes.set(key, (a = []))
      a.push(c)
    }
    const fire = this.world.fire
    const smoke = this.world.smoke
    const touched = new Set()
    cars.forEach((c, n) => {
      const ci = c.k % GRID
      const cj = (c.k - ci) / GRID
      const depth = ctx.depthAt ? ctx.depthAt(c.k) : 0
      if (c.state === 'drive' || c.state === 'stalled') {
        if (depth > 0.3) c.state = 'stalled'
        if (depth > 0.55) {
          const [vx, vz] = ctx.flowAt(ci, cj)
          if (Math.hypot(vx, vz) > 0.4 || depth > 0.9) c.state = 'float'
        }
      }
      if (c.state === 'drive') {
        const [dx, dz] = DIRS[c.dir]
        const nk = idx(clamp(ci + dx, 0, GRID - 1), clamp(cj + dz, 0, GRID - 1))
        let desired = c.max
        if (shaking > 0.02) desired = 0
        else if (ctx.quake && ctx.quakeT > 0) desired = c.max * 0.45
        if (ctx.flood && ctx.rain > 25) desired *= 0.7
        if (inter[c.k]) desired = Math.min(desired, 8) // slow through junctions
        // vehicle ahead in the same lane
        let gap = 99
        for (const o of lanes.get(c.k * 4 + c.dir) || []) if (o !== c && o.t > c.t) gap = Math.min(gap, (o.t - c.t) * CELL - (o.len + c.len) / 2)
        for (const o of lanes.get(nk * 4 + c.dir) || []) gap = Math.min(gap, (1 - c.t + o.t) * CELL - (o.len + c.len) / 2)
        if (gap < 12) desired = Math.min(desired, Math.max(0, (gap - 2) * 1.2))
        // people on the road ahead: always yield
        const [rx, rz] = right(c.dir)
        const fx = Math.cos(c.yaw)
        const fz = -Math.sin(c.yaw)
        const ped = Math.min(this.pedAhead(c, c.k, fx, fz, rx, rz), this.pedAhead(c, nk, fx, fz, rx, rz))
        if (ped < 10) desired = Math.min(desired, Math.max(0, (ped - 1.5) * 1.1))
        // traffic signals and debris in the road
        if (c.t < 0.5 && !inter[c.k]) {
          const stop = (0.45 - c.t) * CELL
          let mustStop = blocked[nk]
          if (inter[nk]) {
            const st = this.signalState(nk, c.dir)
            if (st === 'R' || (st === 'Y' && c.t < 0.3)) mustStop = true
          }
          if (mustStop) desired = Math.min(desired, Math.max(0, stop * 0.8))
        }
        if (desired < 0.3 && c.speed < 0.3) c.wait += dt
        else c.wait = 0
        if (c.wait > 25 && gap < 12 && !blocked[nk] && ped > 10) desired = 2 // creep past a jam
        const acc = desired > c.speed ? 2.2 : 6.5
        c.speed += clamp(desired - c.speed, -acc * dt, acc * dt)
        c.t += (c.speed * dt) / CELL
        if (c.t >= 1) {
          c.t -= 1
          c.k = nk
          const back = (c.dir + 2) % 4
          const ni = nk % GRID
          const nj = Math.floor(nk / GRID)
          const opts = [0, 1, 2, 3].filter((d) => d !== back && nbr[nk] & (1 << d) && !blocked[idx(ni + DIRS[d][0], nj + DIRS[d][1])])
          if (!opts.length) c.dir = back
          else if (opts.includes(c.dir) && Math.random() < 0.6) {
            /* straight on */
          } else c.dir = opts[Math.floor(Math.random() * opts.length)]
          if (!(nbr[nk] & (1 << c.dir))) c.dir = back
        }
        const ii = c.k % GRID
        const jj = (c.k - ii) / GRID
        const [ex, ez] = DIRS[c.dir]
        const [lx, lz] = right(c.dir)
        const tx = cellToWorld(ii) + ex * (c.t - 0.5) * CELL + lx * LANE
        const tz = cellToWorld(jj) + ez * (c.t - 0.5) * CELL + lz * LANE
        const targetYaw = Math.atan2(-ez, ex)
        if (c.init) {
          c.x = tx
          c.z = tz
          c.yaw = targetYaw
          c.init = false
        }
        const k = Math.min(1, dt * 6)
        c.x += (tx - c.x) * k
        c.z += (tz - c.z) * k
        let dy = targetYaw - c.yaw
        dy = Math.atan2(Math.sin(dy), Math.cos(dy))
        c.yaw += dy * Math.min(1, dt * 5)
        c.y = this.heightAt(this.cellOf(c.x, c.z), c.x, c.z)
        c.roll = 0
      } else if (c.state === 'float') {
        const k = this.cellOf(c.x, c.z)
        const i = k % GRID
        const j = (k - i) / GRID
        const [vx, vz] = ctx.flowAt(i, j)
        const d = ctx.depthAt(k)
        c.x += vx * 0.85 * dt
        c.z += vz * 0.85 * dt
        c.yaw += (Math.sin(this.time * 0.7 + n) * 0.3 + vx * 0.05) * dt
        const surf = this.world.groundAt(c.x, c.z) + d
        c.y += (Math.max(surf - 0.9, this.world.groundAt(c.x, c.z)) - c.y) * Math.min(1, dt * 2)
        c.roll = Math.sin(this.time * 1.3 + n) * 0.08
        // occupants trapped in a car swept into deep water
        c.floatT = (c.floatT || 0) + dt
        if (!c.drowned && c.floatT > 25 && d > 1.2) {
          c.drowned = true
          const dead = Math.round(c.occupants * 0.5)
          this.stats.carDead += dead
          this.stats.swept += dead
        }
        if (d < 0.3) c.state = 'stalled'
      } else if (c.state === 'stalled') {
        c.speed = 0
      }
      if (c.fire > 0) {
        c.fire -= dt
        if (Math.random() < 0.6) fire.emit(c.x + (Math.random() - 0.5) * 3, c.y + 1.2, c.z + (Math.random() - 0.5) * 1.5, 0, 3 + Math.random() * 3, 0, 3 + Math.random() * 2, -1, 0.6 + Math.random() * 0.4, [1, 0.55, 0.15, 0.9], [0.9, 0.2, 0.05, 0])
        if (Math.random() < 0.15) smoke.emit(c.x, c.y + 2.5, c.z, 0, 4, 0, 4, 5, 5, [0.12, 0.11, 0.1, 0.5], [0.3, 0.3, 0.3, 0])
        if (c.fire <= 0) {
          c.state = 'burnt'
          c.mesh.setColorAt(c.mi, _c.set(0x1a1816))
          touched.add(c.mesh)
        }
      }
      if (c.state === 'crushed' && !c.colored) {
        c.colored = true
        c.mesh.setColorAt(c.mi, _c.set(c.color).multiplyScalar(0.45))
        touched.add(c.mesh)
      }
      const flat = c.state === 'crushed' || c.state === 'burnt' ? 0.45 : 1
      _p.set(c.x, c.y, c.z)
      _q.setFromEuler(_e.set(c.roll, c.yaw, flat < 1 ? 0.05 : 0, 'YXZ'))
      _s.set(1, flat, 1)
      _m.compose(_p, _q, _s)
      c.mesh.setMatrixAt(c.mi, _m)
      const lit = c.state === 'drive' || c.state === 'stalled' ? 1 : 0
      const fx = Math.cos(c.yaw)
      const fz = -Math.sin(c.yaw)
      const L = c.len * 0.5
      this.lightPos.set([c.x + fx * L, c.y + 0.8 - (lit ? 0 : 50), c.z + fz * L, c.x - fx * L, c.y + 0.9 - (lit ? 0 : 50), c.z - fz * L], n * 6)
    })
    for (const m of Object.values(this.vMeshes)) m.instanceMatrix.needsUpdate = true
    for (const m of touched) m.instanceColor.needsUpdate = true
    this.carLights.geometry.attributes.position.needsUpdate = true
  }

  /** Point on the sidewalk path for (cell, direction, progress, side). */
  walkPoint(k, dir, t, side) {
    const i = k % GRID
    const j = (k - i) / GRID
    const [ex, ez] = DIRS[dir]
    const [rx, rz] = right(dir)
    return [cellToWorld(i) + ex * (t - 0.5) * CELL + rx * WALK * side, cellToWorld(j) + ez * (t - 0.5) * CELL + rz * WALK * side]
  }

  /** Choose what to do at the end of a block: cross on the green, turn the corner, or cross this street. */
  planAtCorner(p, nk) {
    const { nbr } = this
    const ni = nk % GRID
    const nj = Math.floor(nk / GRID)
    const [rx, rz] = right(p.dir)
    const turnDir = dirOf(rx * p.side, rz * p.side) // the street on our side of the corner
    const canStraight = nbr[nk] & (1 << p.dir)
    const canTurn = nbr[nk] & (1 << turnDir)
    const r = Math.random()
    if (canTurn && (r < 0.4 || !canStraight)) {
      const tk = idx(ni + DIRS[turnDir][0], nj + DIRS[turnDir][1])
      const [nrx, nrz] = right(turnDir)
      const back = DIRS[(p.dir + 2) % 4]
      return { kind: 'turn', dir: turnDir, k: tk, side: Math.sign(nrx * back[0] + nrz * back[1]) || 1 }
    }
    if (canStraight && r < 0.85) return { kind: 'straight' }
    return { kind: 'cross' } // cross the street we are on, then walk back
  }

  updatePeds(dt, ctx, shaking) {
    const { peds, nbr, city, inter } = this
    const quakeAlarm = shaking > 0.03 || (ctx.quake && ctx.quakeT > 0)
    const walkAttr = this.pedWalk.array
    peds.forEach((p, n) => {
      const k = this.cellOf(p.x, p.z)
      const i = k % GRID
      const j = (k - i) / GRID
      const depth = ctx.depthAt ? ctx.depthAt(k) : 0
      let lying = false
      let hidden = false
      let stride = 0
      if (p.mode === 'walk' || p.mode === 'flee' || p.mode === 'safe' || p.mode === 'toIndoors') {
        if (ctx.flood && depth > 0.45) {
          const [vx, vz] = ctx.flowAt(i, j)
          if (depth > 1.1 || Math.hypot(vx, vz) > 1.0) {
            p.mode = 'swept'
            p.sweptT = 0
          }
        } else if (quakeAlarm && p.mode === 'walk') {
          p.mode = 'flee'
          p.field = this.safeField
        } else if (ctx.flood && (ctx.warned || depth > 0.08 || ctx.rain > 35) && (p.mode === 'walk' || p.mode === 'safe')) {
          let best = null
          for (let dj = -3; dj <= 3 && !best; dj++)
            for (let di = -3; di <= 3; di++) {
              const ii = i + di
              const jj = j + dj
              if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue
              const bid = city.buildingAt[idx(ii, jj)]
              if (bid < 0) continue
              const b = city.byId.get(bid)
              if (b && b.floors >= 3 && !this.world.isRubble(b)) {
                best = b
                break
              }
            }
          if (best && Math.random() < 0.7) {
            p.mode = 'toIndoors'
            p.target = best
          } else {
            p.mode = 'flee'
            p.field = this.highField
          }
        }
      }

      if (p.mode === 'walk') {
        const [tx, tz] = this.walkPoint(p.k, p.dir, p.t, p.side)
        if (p.init) {
          p.x = tx
          p.z = tz
          p.init = false
        }
        const d = Math.hypot(tx - p.x, tz - p.z)
        if (d > 0.4) {
          // catching up with the path (turning a corner or crossing a street)
          this.steer(p, tx, tz, p.speed, dt)
          stride = 0.45
        } else {
          const [dx, dz] = DIRS[p.dir]
          const pk = p.k
          const pi = pk % GRID
          const pj = (pk - pi) / GRID
          const nextK = idx(clamp(pi + dx, 0, GRID - 1), clamp(pj + dz, 0, GRID - 1))
          let hold = false
          if (!inter[pk] && p.t > 0.9 && this.road[nextK]) {
            if (!p.plan) p.plan = this.planAtCorner(p, nextK)
            if (inter[nextK]) {
              if (p.plan.kind === 'straight' && this.signalState(nextK, p.dir) !== 'G') hold = true
              if (p.plan.kind === 'cross' && this.signalState(nextK, p.dir) !== 'R') hold = true
            }
            if (!hold && p.plan.kind === 'turn' && inter[nextK]) {
              p.k = p.plan.k
              p.dir = p.plan.dir
              p.side = p.plan.side
              p.t = 0
              p.plan = null
            } else if (!hold && p.plan.kind === 'cross') {
              // walk across the road we're on (cars on it are held at the red)
              p.dir = (p.dir + 2) % 4
              p.t = 1 - p.t
              p.plan = null
            }
          } else if (!this.road[nextK] && p.t > 0.9) {
            // dead end: turn around on the same side of the street
            p.dir = (p.dir + 2) % 4
            p.side = -p.side
            p.t = 1 - p.t
          }
          if (!hold) {
            p.t += (p.speed * dt) / CELL
            stride = 0.45
            if (p.t >= 1) {
              p.t -= 1
              if (this.road[nextK]) p.k = nextK
              p.plan = null
              if (!(nbr[p.k] & (1 << p.dir))) {
                // the street bends (or ends): follow it on the nearest sidewalk
                const back = (p.dir + 2) % 4
                const opts = [0, 1, 2, 3].filter((d) => d !== back && nbr[p.k] & (1 << d))
                const nd = opts.length ? opts[Math.floor(Math.random() * opts.length)] : back
                let best = 1
                let bestD = Infinity
                for (const sd of [1, -1]) {
                  const [wx, wz] = this.walkPoint(p.k, nd, 0.5, sd)
                  const dd = Math.hypot(wx - p.x, wz - p.z)
                  if (dd < bestD) {
                    bestD = dd
                    best = sd
                  }
                }
                p.dir = nd
                p.side = best
                p.t = 0.5
              }
            }
            const [nx, nz] = this.walkPoint(p.k, p.dir, p.t, p.side)
            p.yaw = Math.atan2(-(nz - p.z), nx - p.x) || p.yaw
            p.x = nx
            p.z = nz
          }
        }
      } else if (p.mode === 'flee') {
        const f = p.field[k]
        if (f === -1 || f === -2) {
          p.mode = 'safe'
          p.hx = p.x + (Math.random() - 0.5) * 6
          p.hz = p.z + (Math.random() - 0.5) * 6
        } else {
          const tx = cellToWorld(i + DIRS[f][0]) + Math.sin(p.phase * 7.3) * 3
          const tz = cellToWorld(j + DIRS[f][1]) + Math.cos(p.phase * 5.1) * 3
          if (this.steer(p, tx, tz, p.panic, dt)) stride = 0.85
        }
      } else if (p.mode === 'safe') {
        if (Math.hypot(p.hx - p.x, p.hz - p.z) > 0.5 && this.steer(p, p.hx, p.hz, 1, dt)) stride = 0.35
        if (!quakeAlarm && !ctx.flood && Math.random() < dt * 0.02 && this.road[k] && !inter[k]) {
          p.mode = 'walk'
          p.k = k
          p.t = 0.5
          p.plan = null
        }
      } else if (p.mode === 'toIndoors') {
        const b = p.target
        if (Math.hypot(b.cx - p.x, b.cz - p.z) < Math.max(b.fw, b.fd) * 0.5 + 1) p.mode = 'indoors'
        else if (this.steer(p, b.cx, b.cz, 2.4, dt)) stride = 0.7
      } else if (p.mode === 'indoors') {
        hidden = true
      } else if (p.mode === 'swept') {
        const [vx, vz] = ctx.flowAt(i, j)
        p.x += vx * dt
        p.z += vz * dt
        p.sweptT += dt
        lying = true
        if (p.sweptT > 8 && Math.random() < dt * 0.05 && depth > 0.8) {
          p.mode = 'dead'
          p.cause = 'flood'
          this.stats.pedDead++
          this.stats.swept++
        }
        if (depth < 0.2) p.mode = 'safe'
        hidden = depth > 1.6
      } else if (p.mode === 'dead') {
        lying = true
        hidden = depth > 0.4
      }

      const ground = this.heightAt(k, p.x, p.z)
      const onWalk = this.road[k] && !this.onCarriageway(k, p.x, p.z) && !city.bridge[k]
      p.y = p.mode === 'swept' ? ground + Math.max(0, depth - 0.25) : ground + (onWalk ? KERB : 0)
      if (stride) p.phase += dt * (stride > 0.6 ? 11 : 7.5)
      _p.set(p.x, p.y + (lying ? 0.15 : 0), p.z)
      _q.setFromEuler(_e.set(lying ? -Math.PI / 2 : 0, p.yaw + Math.PI / 2, 0, 'YXZ'))
      const s = hidden ? 0 : 1
      _s.set(s, s, s)
      _m.compose(_p, _q, _s)
      this.pedMesh.setMatrixAt(n, _m)
      walkAttr[n * 2] = p.phase
      walkAttr[n * 2 + 1] = lying ? 0 : stride
    })
    this.pedMesh.instanceMatrix.needsUpdate = true
    this.pedWalk.needsUpdate = true
  }

  steer(p, tx, tz, speed, dt) {
    const dx = tx - p.x
    const dz = tz - p.z
    const d = Math.hypot(dx, dz)
    if (d < 0.05) return false
    const step = Math.min(d, speed * dt)
    p.x += (dx / d) * step
    p.z += (dz / d) * step
    p.yaw = Math.atan2(-dz, dx)
    return true
  }

  outdoorCount() {
    let n = 0
    for (const c of this.cars || []) n += c.occupants
    return n + (this.peds?.length || 0)
  }
}
