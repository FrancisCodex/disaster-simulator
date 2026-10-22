// City life: traffic (lanes, car-following, working traffic signals),
// pedestrians on the sidewalks who cross at crosswalks on a green, street
// lights — and how they all react to a disaster.
//  • Earthquake: everyone carries a fear level set by the shaking they feel
//    where they are (Modified Mercalli: IV felt, V–VI many frightened, VII
//    hard to stand / people run outdoors, VIII+ general panic), raised by
//    collapses and fires nearby and by their own temperament. Frightened
//    people stop and brace, then head for open ground away from buildings;
//    panicked ones run. Drivers slow, then brake and pull over; some abandon
//    their cars. Falling debris crushes cars and strikes pedestrians.
//  • Flood: cars stall, then float off with the current; people head indoors
//    or to high ground; anyone caught in deep moving water is swept away.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GRID, CELL, CELL_RIVER, CELL_POND, CELL_PARK } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { clamp } from './math.js'
import { fadeDepthMaterial, vehicleGeometry, vehicleMaterial, VEHICLE_TYPES, VEHICLE_LENGTH, personGeometry, personMaterial } from './assets.js'
import { KERB } from './roads.js'
import { analyzeRoads, AVENUE, JUNCTION, STREET, END, BEND } from './roadNet.js'
import { vehicleModelMaterial } from './quaternius.js'
import { mmiFromPga } from './quakePhysics.js'

/** Fear (0..1) from felt shaking (surface PGA in g): none at intensity IV (felt outdoors by few), ¼ at V, ½ at VI, ¾ at VII, full at VIII. */
const PANIC = 0.88 // fear above which people run blindly
const fearOfShaking = (pga) => (pga < 0.004 ? 0 : clamp((mmiFromPga(pga) - 4) / 4, 0, 1))

import { DIRS } from './roadNet.js'
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
const _r = new THREE.Matrix4()
const _a = new THREE.Vector3()
const HALF = (GRID * CELL) / 2
const LANE = 1.4 // lane centre on a two-way street (2.8 m lanes between the kerbs)
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
      if (!c.userData.sharedGeometry) c.geometry?.dispose()
      c.material?.dispose?.()
    }
  }

  build(city, hour = 12, rng = Math.random) {
    this.dispose()
    this.city = city
    this.stats = { pedDead: 0, carDead: 0, carsCrushed: 0, swept: 0 }
    const N = GRID
    const net = analyzeRoads(city)
    this.net = net
    this.deadCache = null
    const road = net.road
    this.road = road
    this.blocked = new Uint8Array(N * N) // impassable now: rubble, closed bridges, fire
    this.rubble = new Uint8Array(N * N) // blocked for good (rubble, landslides, closed bridges)
    this.heat = new Uint8Array(N * N) // too hot to pass beside a fire
    // cars: where they may drive next; pedestrians: where the sidewalks go
    const carOut = net.carOut
    this.carOut = carOut
    this.walkOut = net.walkOut
    const inter = new Uint8Array(N * N)
    const roadCells = []
    for (let k = 0; k < N * N; k++) {
      if (!road[k]) continue
      if (net.kind[k] === JUNCTION) inter[k] = 1
      roadCells.push(k)
    }
    this.inter = inter
    // roads that run off the edge of the district: traffic leaves and arrives there
    const legal = (k, d) => (net.kind[k] === AVENUE ? net.oneway[k] === d : net.kind[k] === STREET || net.kind[k] === END ? (net.axis[k] === 1 ? d % 2 === 0 : d % 2 === 1) : false)
    this.edgeExit = new Uint8Array(N * N)
    this.edgeEntries = []
    for (const k of roadCells) {
      if (city.bridge[k]) continue
      const i = k % N
      const j = (k - i) / N
      for (let d = 0; d < 4; d++) {
        const oi = i + DIRS[d][0]
        const oj = j + DIRS[d][1]
        if (oi >= 0 && oj >= 0 && oi < N && oj < N) continue
        if (legal(k, d)) this.edgeExit[k] |= 1 << d // drive out through this side
        const inward = (d + 2) % 4
        if (legal(k, inward)) this.edgeEntries.push({ k, d: inward }) // arrive from this side
      }
    }
    // every cell of one intersection shares the same signal timing
    const phase = []
    this.signalOffset = new Float32Array(N * N)
    for (let k = 0; k < N * N; k++) {
      const c = net.cluster[k]
      if (c < 0) continue
      if (phase[c] === undefined) phase[c] = rng() * 30
      this.signalOffset[k] = phase[c]
    }

    const base = { rural: [40, 110], metropolis: [230, 560], megacity: [440, 1150] }[city.type]
    // fewer people out late at night, rush-hour peaks in the morning and evening
    const h = ((hour % 24) + 24) % 24
    const activity = h < 5 ? 0.15 : h < 7 ? 0.45 : h < 10 ? 1 : h < 16 ? 0.85 : h < 20 ? 1 : h < 23 ? 0.5 : 0.25
    const counts = [Math.round(base[0] * Math.max(0.3, activity)), Math.round(base[1] * activity)]

    // ---------------- vehicles
    this.cars = []
    const K = this.models
    // detailed vehicles (Quaternius)
    const mix = K
      ? city.type === 'rural'
        ? { sedan: 0.32, hatch: 0.24, suv: 0.3, sports: 0.06, police: 0.04, ambulance: 0.02, schoolbus: 0.02 }
        : { sedan: 0.26, hatch: 0.2, suv: 0.18, sports: 0.05, sports2: 0.04, taxi: city.type === 'megacity' ? 0.12 : 0.07, police: 0.03, ambulance: 0.02, bus: 0.05, schoolbus: 0.02 }
      : city.type === 'rural'
        ? { sedan: 0.3, hatch: 0.2, suv: 0.3, van: 0.12, truck: 0.08 }
        : { sedan: 0.36, hatch: 0.22, suv: 0.2, van: 0.1, truck: 0.05, bus: 0.07 }
    const lengthOf = (t) => (K && K.cars[t] ? K.cars[t].length : VEHICLE_LENGTH[t])
    const usable = roadCells.filter((k) => carOut[k] && !inter[k] && !city.bridge[k])
    this.usable = usable
    const taken = new Set()
    for (let n = 0, tries = 0; n < counts[0] && usable.length && tries < counts[0] * 4; tries++) {
      const k = usable[Math.floor(rng() * usable.length)]
      if (taken.has(k)) continue
      taken.add(k)
      n++
      const dirs = [0, 1, 2, 3].filter((d) => carOut[k] & (1 << d))
      let r = rng()
      let type = 'sedan'
      for (const [t, w] of Object.entries(mix)) if ((r -= w) <= 0) {
        type = t
        break
      }
      const heavy = /bus|truck|garbage|fire|delivery/.test(type)
      this.cars.push({
        k,
        dir: dirs[Math.floor(rng() * dirs.length)],
        t: rng(),
        speed: 0,
        max: (heavy ? 9 : 10.5 + rng() * 4.5) * (city.type === 'megacity' ? 0.85 : 1),
        type,
        len: lengthOf(type),
        // detailed models keep their own livery unless the body is flagged as paint
        color: K && K.cars[type] ? (K.cars[type].paint ? pick(CAR_COLORS, rng) : '#ffffff') : type === 'bus' ? (rng() < 0.5 ? '#e0b12b' : '#d9dde0') : type === 'truck' ? '#f2f2f0' : pick(CAR_COLORS, rng),
        x: 0,
        z: 0,
        y: 0,
        yaw: 0,
        state: 'drive',
        id: n,
        occupants: type === 'bus' ? 12 + Math.floor(rng() * 20) : 1 + Math.floor(rng() * 2),
        fear: 0,
        trait: 0.5 + rng() ** 1.6 * 0.9, // how easily this driver is frightened (most are steady)
        pull: 0,
        lane: rng() < 0.5 ? 0 : 1,
        wait: 0,
        roll: 0,
        init: true,
      })
    }
    this.vMeshes = {}
    for (const type of new Set([...VEHICLE_TYPES, ...Object.keys(mix)])) {
      const list = this.cars.filter((c) => c.type === type)
      if (!list.length) continue
      const km = K?.cars[type]
      const geo = km ? km.geometry : this.vehicleGeos[type]
      const mat = km ? vehicleModelMaterial(this.world.envTexture) : vehicleMaterial(this.world.envTexture)
      const mesh = new THREE.InstancedMesh(geo, mat, list.length)
      mesh.userData.sharedGeometry = true
      // per-car opacity, so cars fade in and out at the district edge
      mesh.userData.fade = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1).setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('aFade', mesh.userData.fade)
      mesh.customDepthMaterial = fadeDepthMaterial()
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
    const walkable = roadCells.filter((k) => this.walkOut[k] && !inter[k])
    // a hidden reserve stands in for drivers and passengers who abandon their cars
    const reserve = Math.min(240, Math.round(this.cars.length * 0.6))
    for (let n = 0; n < counts[1] + reserve && walkable.length; n++) {
      const k = walkable[Math.floor(rng() * walkable.length)]
      const dirs = [0, 1, 2, 3].filter((d) => this.walkOut[k] & (1 << d))
      const dir = dirs[Math.floor(rng() * dirs.length)]
      let side = rng() < 0.5 ? 1 : -1
      if (!net.hasWalk(k, dir, side)) side = -side
      if (!net.hasWalk(k, dir, side)) continue
      this.peds.push({
        k,
        dir,
        t: rng(),
        side,
        speed: 1.15 + rng() * 0.5,
        x: 0,
        z: 0,
        y: 0,
        yaw: 0,
        mode: n < counts[1] ? 'walk' : 'reserve',
        phase: rng() * 10,
        panic: 2.8 + rng() * 2, // sprinting speed when panicking (m/s)
        fear: 0,
        trait: 0.5 + rng() ** 1.6 * 0.9, // temperament: most people stay level-headed, a few are easily panicked
        color: pick(SHIRTS, rng),
        init: true,
        plan: null,
      })
    }
    // people are always the built-in figures: one instanced mesh with its own walk attribute
    this.pedMeshes = []
    if (this.peds.length) {
      const n = this.peds.length
      const pg = this.personGeo.clone()
      const walk = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage)
      pg.setAttribute('aWalk', walk)
      const pants = new Float32Array(n * 3)
      const skin = new Float32Array(n * 3)
      const hair = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        _c.set(pick(PANTS, rng)).toArray(pants, i * 3)
        _c.set(pick(SKIN, rng)).toArray(skin, i * 3)
        _c.set(pick(HAIR, rng)).toArray(hair, i * 3)
      }
      pg.setAttribute('aPants', new THREE.InstancedBufferAttribute(pants, 3))
      pg.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3))
      pg.setAttribute('aHair', new THREE.InstancedBufferAttribute(hair, 3))
      const mesh = new THREE.InstancedMesh(pg, personMaterial(), n)
      mesh.castShadow = false // shadows of 1.7 m figures are invisible from city height
      this.peds.forEach((p, i) => {
        p.pm = 0
        p.mi = i
        mesh.setColorAt(i, _c.set(p.color))
      })
      this.pedMeshes.push({ mesh, walk })
      this.group.add(mesh)
    }

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
        const fk = idx(fi, fj)
        if (inter[fk] || !(this.carOut[fk] & (1 << d))) continue
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
    this.signalPoles = poleMesh
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
      const lit = s.dark || s.fallen ? [false, false, false] : [st === 'R', st === 'Y', st === 'G']
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
    // a lamp whose instance colour is dimmed has lost power (or fallen): no glow
    headMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\n  totalEmissiveRadiance *= step(0.9, vColor.g);\n#endif',
      )
    }
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
    this.lampPoles = poleMesh
    this.lampHeads = heads
    for (let q = 0; q < n; q++) heads.setColorAt(q, _c.setRGB(1, 1, 1))
    this.lampGlowSize = gs
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
      if (l.fallen || l.dark) continue
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

  /** Pole matrix: standing, or pivoted about its foot to lie the way it fell (ax, az: world x, z). */
  poleMatrix(x, y, z, yaw, fallen) {
    _m.makeRotationY(yaw)
    if (fallen) _m.premultiply(_r.makeRotationAxis(_a.set(fallen.az, 0, -fallen.ax), fallen.th))
    return _m.setPosition(x, y, z)
  }

  /** Street light q blown over or struck, falling toward (ax, az). */
  knockLamp(q, ax, az) {
    const l = this.lamps?.[q]
    if (!l || l.fallen) return false
    l.fallen = { ax, az, th: 1.3 + Math.random() * 0.25 }
    const m = this.poleMatrix(l.x, l.y, l.z, Math.atan2(-l.dz, l.dx), l.fallen)
    this.lampPoles.setMatrixAt(q, m)
    this.lampHeads.setMatrixAt(q, m)
    this.lampPoles.instanceMatrix.needsUpdate = this.lampHeads.instanceMatrix.needsUpdate = true
    this.setLampLit(q, false)
    return true
  }

  setLampLit(q, lit) {
    this.lampHeads.setColorAt(q, lit ? _c.setRGB(1, 1, 1) : _c.setRGB(0.4, 0.4, 0.4))
    this.lampHeads.instanceColor.needsUpdate = true
    this.lampGlowSize[q] = lit ? 5 : 0
    this.lampGlow.geometry.attributes.aSize.needsUpdate = true
    this.lampMapDirty = true
  }

  /** A traffic signal blown over or struck. */
  knockSignal(q, ax, az) {
    const s = this.signals?.[q]
    if (!s || s.fallen) return false
    s.fallen = { ax, az, th: 1.3 + Math.random() * 0.25 }
    this.signalPoles.setMatrixAt(q, this.poleMatrix(s.x, s.y, s.z, s.yaw, s.fallen))
    this.signalPoles.instanceMatrix.needsUpdate = true
    // its lamps go with it
    _m.makeScale(0, 0, 0)
    for (let l = 0; l < 3; l++) this.signalLamps.setMatrixAt(q * 3 + l, _m)
    this.signalLamps.instanceMatrix.needsUpdate = true
    return true
  }

  /** Lights and signals go dark where the power is cut (powered(x, z) → bool). */
  setPower(powered) {
    ;(this.lamps || []).forEach((l, q) => {
      const dark = !powered(l.x, l.z)
      if (dark === !!l.dark) return
      l.dark = dark
      if (!l.fallen) this.setLampLit(q, !dark)
    })
    for (const s of this.signals || []) s.dark = !powered(s.x, s.z)
  }

  /** Street lights and signals within r of (x, z): { kind, q, x, z }. */
  polesNear(x, z, r) {
    const out = []
    ;(this.lamps || []).forEach((l, q) => {
      if (!l.fallen && Math.abs(l.x - x) < r && Math.abs(l.z - z) < r) out.push({ kind: 'lamp', q, x: l.x, z: l.z })
    })
    ;(this.signals || []).forEach((s, q) => {
      if (!s.fallen && Math.abs(s.x - x) < r && Math.abs(s.z - z) < r) out.push({ kind: 'signal', q, x: s.x, z: s.z })
    })
    return out
  }

  knockPole(p, ax, az) {
    return p.kind === 'lamp' ? this.knockLamp(p.q, ax, az) : this.knockSignal(p.q, ax, az)
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
    const net = this.net
    if (net.isJ(k)) return !(dx > 2.8 && dz > 2.8)
    const perp = net.axis[k] === 1 ? z - cellToWorld(j) : x - cellToWorld(i)
    if (net.kind[k] === AVENUE) {
      // the median side is all carriageway; the sidewalk is on the outer side
      const toTwin = DIRS[net.twin[k]][net.axis[k] === 1 ? 1 : 0]
      return perp * toTwin > -2.8
    }
    return Math.abs(perp) < 2.8
  }

  /** Close road cell k for good (rubble, a landslide, a closed bridge). */
  block(k) {
    this.rubble[k] = 1
    this.blocked[k] = 1
  }

  blockAround(b) {
    // rubble spills into the street around a collapsed building
    for (let j = b.y - 1; j <= b.y + b.d; j++)
      for (let i = b.x - 1; i <= b.x + b.w; i++) {
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
        const k = idx(i, j)
        if (this.road[k] && Math.random() < 0.6) this.block(k)
      }
  }

  /** A badly damaged bridge is closed: traffic stops at its ends and nobody walks onto it. */
  closeBridge(sp) {
    for (let i = sp.i0 + 1; i < sp.i1; i++) {
      const k = idx(i, sp.j)
      this.block(k)
      this.walkOut[k] = 0
    }
    this.deadCache = null
  }

  /** A span fell: whoever was on that stretch of deck goes down with it. */
  bridgeCollapsed(sp, drop) {
    this.closeBridge(sp)
    const z = cellToWorld(sp.j)
    const on = (x, zz) => Math.abs(zz - z) < CELL * 0.55 && x > drop.a - 1 && x < drop.b + 1
    for (const c of this.cars) {
      if (c.state === 'exit' || c.state === 'sunk' || !on(c.x, c.z)) continue
      c.state = 'sunk'
      c.speed = 0
      c.y = this.world.groundAt(c.x, c.z) + 0.4
      c.roll = (Math.random() - 0.5) * 0.8
      const dead = Math.round(c.occupants * 0.6)
      c.occupants -= dead
      this.stats.carDead += dead
      this.stats.bridgeDead = (this.stats.bridgeDead || 0) + dead
    }
    for (const p of this.peds) {
      if (p.mode === 'dead' || p.mode === 'reserve' || !on(p.x, p.z)) continue
      p.mode = 'dead'
      p.cause = 'bridge'
      p.fallen = true
      this.stats.pedDead++
      this.stats.bridgeDead = (this.stats.bridgeDead || 0) + 1
    }
  }

  /**
   * People out in the open and cars, bucketed by grid cell for hitArea. Built
   * at most once per update: a great quake drops debris in dozens of places
   * every frame.
   */
  hitIndex() {
    if (this.hitGrid && this.hitGridT === this.time && this.hitGridOf === this.peds) return this.hitGrid
    const peds = new Map()
    const cars = new Map()
    const put = (m, k, o) => {
      const a = m.get(k)
      if (a) a.push(o)
      else m.set(k, [o])
    }
    for (const p of this.peds) if (p.mode !== 'dead' && p.mode !== 'indoors' && p.mode !== 'reserve') put(peds, this.cellOf(p.x, p.z), p)
    for (const c of this.cars) if (c.state !== 'crushed' && c.state !== 'burnt') put(cars, this.cellOf(c.x, c.z), c)
    this.hitGrid = { peds, cars }
    this.hitGridT = this.time
    this.hitGridOf = this.peds
    return this.hitGrid
  }

  /** Everything bucketed in `m` within the cells that a circle of radius r at (x, z) touches. */
  *near(m, x, z, r) {
    const i0 = clamp(Math.floor((x - r + HALF) / CELL), 0, GRID - 1)
    const i1 = clamp(Math.floor((x + r + HALF) / CELL), 0, GRID - 1)
    const j0 = clamp(Math.floor((z - r + HALF) / CELL), 0, GRID - 1)
    const j1 = clamp(Math.floor((z + r + HALF) / CELL), 0, GRID - 1)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) yield* m.get(idx(i, j)) || []
  }

  /** Something heavy landed at (x,z): crush cars, strike pedestrians. */
  hitArea(x, z, r, energy) {
    let killed = 0
    let crushed = 0
    if (energy < 4000 || !this.peds) return { killed, crushed }
    const H = this.hitIndex()
    for (const p of this.near(H.peds, x, z, r + 0.5)) {
      if (p.mode === 'dead' || p.mode === 'indoors' || p.mode === 'reserve') continue
      if (Math.hypot(p.x - x, p.z - z) < r + 0.5) {
        p.mode = 'dead'
        p.cause = 'debris'
        this.stats.pedDead++
        killed++
      }
    }
    if (energy > 30000) {
      for (const c of this.near(H.cars, x, z, r + 6)) {
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
   * ctx: { shaking (g), field + frac (surface PGA map of the current shaking and its envelope), burning,
   *        quake, quakeT (s since main shock), flood, warned,
   *        depthAt(k), flowAt(i,j) → [vx,vz], night (0..1) }
   */
  update(dt, ctx) {
    if (!this.cars) return
    dt = Math.min(dt, 0.05)
    this.time += dt
    // surface PGA (g) being felt right now in cell k
    this.felt = ctx.field ? (k) => ctx.field[k] * ctx.frac : () => 0
    // Fires: people keep well away from the flames, and the radiant heat beside
    // a fully developed fire makes the road past it impassable until it dies down.
    this.fireTimer = (this.fireTimer || 0) + dt
    if (this.fireTimer > 0.5) {
      this.fireTimer = 0
      this.heat.fill(0)
      const scorch = (i0, j0, i1, j1) => {
        for (let j = Math.max(0, j0); j <= Math.min(GRID - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(GRID - 1, i1); i++) if (this.road[idx(i, j)]) this.heat[idx(i, j)] = 1
      }
      for (const b of ctx.burning || []) {
        const I = ctx.fireOf ? ctx.fireOf(b) : 1
        if (I < 0.05) continue
        this.alarm(b.cx, b.cz, 12 + 14 * I, 0.35 * I, 0.6)
        if (I > 0.5) scorch(b.x - 1, b.y - 1, b.x + b.w, b.y + b.d)
      }
      for (const tr of ctx.burningTrees || []) {
        if ((tr.I ?? 1) < 0.3) continue
        this.alarm(tr.x, tr.z, 8, 0.25, 0.6)
        const i = Math.floor((tr.x + HALF) / CELL)
        const j = Math.floor((tr.z + HALF) / CELL)
        scorch(i, j, i, j)
      }
      for (let k = 0; k < this.blocked.length; k++) this.blocked[k] = this.rubble[k] | this.heat[k]
      this.deadCache = null
    }
    // pedestrians currently out on the carriageway, per cell (for drivers to yield)
    this.crossing = new Map()
    for (const p of this.peds) {
      if (p.mode === 'dead' || p.mode === 'indoors' || p.mode === 'reserve') continue
      const k = this.cellOf(p.x, p.z)
      if (!this.onCarriageway(k, p.x, p.z)) continue
      let a = this.crossing.get(k)
      if (!a) this.crossing.set(k, (a = []))
      a.push(p)
    }
    this.updateSignals(dt)
    // repaint the pools of light on the ground once lamps have gone dark or fallen (not every frame)
    if (this.lampMapDirty && this.time - (this.lampMapT ?? -9) > 1) {
      this.lampMapDirty = false
      this.lampMapT = this.time
      this.world.paintLamps()
    }
    this.updateCars(dt, ctx)
    this.updatePeds(dt, ctx)
    this.carLights.material.uniforms.uNight.value = ctx.night
    this.lampGlow.material.uniforms.uNight.value = ctx.night * 0.45
    this.lampHeadMat.emissiveIntensity = ctx.night * 1.2
  }

  /**
   * Something frightening happened at (x, z): a collapse, a fire. Fear rises
   * with closeness (e-folding distance r), and people flee away from it.
   * cap limits how frightened a distant, ongoing threat (like a fire) can make anyone.
   */
  alarm(x, z, r, strength, cap = 1) {
    const reach = r * 3
    for (const p of this.peds || []) {
      if (p.mode === 'dead' || p.mode === 'indoors' || p.mode === 'reserve') continue
      const d = Math.hypot(p.x - x, p.z - z)
      if (d > reach) continue
      const add = strength * Math.exp(-d / r) * p.trait
      p.fear = Math.max(p.fear, Math.min(cap, p.fear + add))
      if (add > 0.15) p.threat = { x, z, until: this.time + 25 }
    }
    for (const c of this.cars || []) {
      if (c.state !== 'drive') continue
      const d = Math.hypot(c.x - x, c.z - z)
      if (d > reach) continue
      const add = strength * Math.exp(-d / r) * c.trait
      c.fear = Math.max(c.fear, Math.min(cap, c.fear + add))
      if (add > 0.3) c.threatUntil = this.time + 20 // something came down right by the car
    }
  }

  /** How the people outside are behaving: for the HUD and the event log. */
  panicStats() {
    const s = { outside: 0, calm: 0, alarmed: 0, fleeing: 0, panicking: 0, fallen: 0, carsStopped: 0, carsAbandoned: 0 }
    for (const p of this.peds || []) {
      if (p.mode === 'dead' || p.mode === 'indoors' || p.mode === 'reserve') continue
      s.outside++
      if (p.mode === 'fallen') s.fallen++
      if (p.fear >= PANIC) s.panicking++
      else if (p.fear >= 0.55) s.fleeing++
      else if (p.fear >= 0.2) s.alarmed++
      else s.calm++
    }
    for (const c of this.cars || []) {
      if (c.state === 'abandoned') s.carsAbandoned++
      else if (c.state === 'drive' && c.halt) s.carsStopped++
    }
    return s
  }

  /** Drivers and passengers get out and run; the car stays where it stopped. */
  abandonCar(c) {
    c.state = 'abandoned'
    c.halt = true
    const [rx, rz] = right(c.dir)
    let n = Math.min(c.occupants, c.type === 'bus' || c.type === 'schoolbus' ? 6 : 3)
    for (const p of this.peds) {
      if (n <= 0) break
      if (p.mode !== 'reserve') continue
      n--
      const side = Math.random() < 0.7 ? 1 : -1
      p.x = c.x + rx * 1.4 * side + (Math.random() - 0.5) * c.len * 0.6
      p.z = c.z + rz * 1.4 * side + (Math.random() - 0.5) * c.len * 0.6
      p.init = false
      p.fear = Math.max(c.fear, 0.6)
      p.mode = 'flee'
      p.field = this.safeField
    }
    this.stats.abandoned = (this.stats.abandoned || 0) + 1
    c.occupants = 0 // they are on foot now
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

  updateCars(dt, ctx) {
    const { cars, inter, blocked, net } = this
    const grid = new Map()
    const byCluster = new Map()
    const byCell = new Map()
    this.byCell = byCell
    for (const c of cars) {
      if (c.state === 'drive') {
        let b = byCell.get(c.k)
        if (!b) byCell.set(c.k, (b = []))
        b.push(c)
      }
      if (c.state === 'drive' && inter[c.k]) {
        const cl = net.cluster[c.k]
        let b = byCluster.get(cl)
        if (!b) byCluster.set(cl, (b = []))
        b.push(c)
      }
      if (c.init) continue
      const key = this.cellOf(c.x, c.z)
      let a = grid.get(key)
      if (!a) grid.set(key, (a = []))
      a.push(c)
    }
    const fire = this.world.fire
    const smoke = this.world.smoke
    const touched = new Set()
    const fading = new Set()
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
        if (!c.path) this.enterCell(c, c.k, c.dir, null)
        const [dx, dz] = DIRS[c.dir]
        const nk = idx(clamp(ci + dx, 0, GRID - 1), clamp(cj + dz, 0, GRID - 1))
        let desired = c.max
        // Drivers feel weak shaking late, if at all. Strong shaking feels like a
        // burst tyre and makes steering hard: they brake and pull over to the
        // kerb, and wait there until they've calmed down. The worst-frightened leave the car.
        const here = this.felt(c.k)
        // a moving car's suspension hides about one intensity unit (MMI VII: "noticed by persons driving")
        c.fear = Math.max(c.fear - dt * 0.01, Math.min(1, fearOfShaking(here * 0.5) * c.trait))
        c.halt = c.fear > 0.45 || here > 0.25 || (c.halt && c.fear > 0.3)
        if (c.halt) desired = 0
        else if (c.fear > 0.15 || here > 0.02) desired = c.max * 0.5
        else if (ctx.quake && ctx.quakeT > 0) desired = c.max * 0.6 // cracked roads, debris, signals out
        // most drivers stay with their cars; they get out and run when something collapses right beside them, or in sheer terror
        if (c.halt && c.speed < 0.3 && Math.random() < dt * (c.threatUntil > this.time ? 0.12 * c.fear : c.fear > 0.95 ? 0.04 : 0)) this.abandonCar(c)
        if (ctx.flood && ctx.rain > 25) desired *= 0.7
        // slow for corners: tighter arcs, lower speed
        if (c.path.turn) desired = Math.min(desired, c.path.turn === 2 ? 3 : c.path.radius < 4 ? 4.5 : 7)
        else if (inter[c.k]) desired = Math.min(desired, 9)
        // following: vehicles ahead on our own path
        const { gap } = this.clearAhead(c, grid, inter[c.k])
        if (gap < 30) desired = Math.min(desired, Math.sqrt(2 * 5.5 * Math.max(0, gap - 2.0)))
        if (gap < 0.3) c.speed = 0
        // people in the road ahead: always yield
        const [rx, rz] = right(c.dir)
        const fx = Math.cos(c.yaw)
        const fz = -Math.sin(c.yaw)
        const ped = Math.min(this.pedAhead(c, c.k, fx, fz, rx, rz), this.pedAhead(c, nk, fx, fz, rx, rz))
        if (ped < 10) desired = Math.min(desired, Math.max(0, (ped - 1.5) * 1.1))
        // decide the turn before reaching the intersection
        if (inter[nk] && !inter[c.k] && c.planK !== nk) {
          const r = Math.random()
          c.planK = nk
          c.planDir = r < 0.6 ? c.dir : r < 0.8 ? (c.dir + 1) % 4 : (c.dir + 3) % 4
          if (this.deadAhead(this.turnExit(nk, c.dir, c.planDir), c.planDir)) c.planDir = c.dir
        }
        // approaching an intersection: signal, then right of way
        if (inter[nk] && !inter[c.k]) {
          const stopAt = Math.max(0, (0.42 - c.t) * c.path.len)
          let hold = !!blocked[nk]
          const st = this.signalState(nk, c.dir)
          if (st === 'R' || (st === 'Y' && c.t < 0.3)) hold = true
          if (!hold && c.t > 0.15) hold = !this.mayEnter(c, nk, byCluster, byCell, st)
          if (hold) {
            c.gateWait = (c.gateWait || 0) + dt
            desired = Math.min(desired, Math.sqrt(2 * 5.5 * stopAt))
            if (c.t >= 0.42) desired = 0
          } else c.gateWait = 0
        } else if (blocked[nk]) desired = Math.min(desired, Math.sqrt(2 * 5.5 * Math.max(0, (0.42 - c.t) * c.path.len)))
        if (desired < 0.3 && c.speed < 0.3) c.wait += dt
        else c.wait = 0
        if (c.wait > 90) this.respawn(c) // last resort: wreckage has sealed the road
        const acc = desired > c.speed ? 2.2 : 6.5
        c.speed += clamp(desired - c.speed, -acc * dt, acc * dt)
        c.t += (c.speed * dt) / c.path.len
        if (c.t >= 1 && c.exiting) {
          // already faded out on the way here: swap for a car arriving elsewhere
          this.enterFromEdge(c)
        } else if (c.t >= 1) {
          const p3 = c.path.p3
          const inDir = c.dir
          c.t = (c.t - 1) * (c.path.len / 10)
          this.enterCell(c, nk, inDir, p3)
        }
        if (c.fadeIn !== undefined) {
          c.fadeIn += c.speed * dt
          c.fade = Math.min(1, 0.25 + c.fadeIn / 3) // quick: visible almost at once
          if (c.fade >= 1) c.fadeIn = undefined
        }
        // leaving the district: fade out gradually over the last stretch of road
        if (c.exiting) c.fade = Math.min(c.fade ?? 1, clamp((1 - c.t) / 0.7, 0, 1))
        const pt = this.pathPoint(c.path, Math.min(1, c.t))
        // pulling over: ease toward the kerb while stopped, back out when moving off
        c.pull += ((c.halt ? 1 : 0) - c.pull) * Math.min(1, dt * (c.speed > 0.5 || !c.halt ? 1.6 : 0.8))
        const [px, pz] = right(c.dir)
        const kerb = c.path.turn || inter[c.k] ? 0 : c.pull * 1.2
        c.x = pt.x + px * kerb
        c.z = pt.z + pz * kerb
        c.yaw = pt.yaw
        if (c.init) c.init = false
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
      } else if (c.state === 'exit') {
        const fx = Math.cos(c.yaw)
        const fz = -Math.sin(c.yaw)
        const v = Math.max(4, c.speed)
        c.exitD += v * dt
        c.x += fx * v * dt
        c.z += fz * v * dt
        c.fade = Math.max(0, 1 - c.exitD / 10)
        if (c.exitD > 10) this.enterFromEdge(c)
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
      const flat = c.state === 'crushed' || c.state === 'burnt' ? 0.45 : c.state === 'sunk' ? 0.8 : 1
      const fade = c.fade ?? 1
      _p.set(c.x, c.y, c.z)
      _q.setFromEuler(_e.set(c.roll, c.yaw, flat < 1 ? 0.05 : 0, 'YXZ'))
      _s.set(1, flat, 1)
      _m.compose(_p, _q, _s)
      c.mesh.setMatrixAt(c.mi, _m)
      c.mesh.userData.fade.setX(c.mi, fade)
      fading.add(c.mesh)
      // stopped on the shoulder: hazard lights blink
      const hazard = c.halt && c.state === 'drive' && Math.sin(this.time * 7 + n) < 0
      const lit = (c.state === 'drive' || c.state === 'stalled') && fade > 0.6 && !hazard ? 1 : 0
      const fx = Math.cos(c.yaw)
      const fz = -Math.sin(c.yaw)
      const L = c.len * 0.5
      this.lightPos.set([c.x + fx * L, c.y + 0.8 - (lit ? 0 : 50), c.z + fz * L, c.x - fx * L, c.y + 0.9 - (lit ? 0 : 50), c.z - fz * L], n * 6)
    })
    for (const m of Object.values(this.vMeshes)) m.instanceMatrix.needsUpdate = true
    for (const m of touched) m.instanceColor.needsUpdate = true
    for (const m of fading) m.userData.fade.needsUpdate = true
    this.carLights.geometry.attributes.position.needsUpdate = true
  }

  /** Distance to the nearest vehicle in our path (bumper to bumper), and which one. */
  clearAhead(c, grid, inJunction) {
    const fx = Math.cos(c.yaw)
    const fz = -Math.sin(c.yaw)
    const ci = Math.floor((c.x + HALF) / CELL)
    const cj = Math.floor((c.z + HALF) / CELL)
    let gap = 99
    let blocker = null
    const halfW = c.len > 8 ? 1.3 : 1.0
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const ii = ci + di
        const jj = cj + dj
        if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue
        for (const o of grid.get(idx(ii, jj)) || []) {
          if (o === c) continue
          const dx = o.x - c.x
          const dz = o.z - c.z
          const along = dx * fx + dz * fz
          const lat = Math.abs(dx * fz - dz * fx)
          if (along <= 0 || along > 24) continue
          // follow traffic going our way; crossing traffic is handled by right of way,
          // except a vehicle stopped right across our path
          const cosRel = Math.cos(o.yaw - c.yaw)
          const moving = o.state === 'drive' && o.speed > 0.5
          if (cosRel < 0.4 && (moving || inJunction || along > 8)) continue
          // the other vehicle's half-width across our path depends on its heading
          const rel = Math.abs(Math.sin(o.yaw - c.yaw))
          const oHalf = (o.len > 8 ? 1.3 : 1.0) * (1 - rel) + (o.len / 2) * rel
          if (lat > halfW + oHalf + 0.25) continue
          const g = along - c.len / 2 - ((o.len / 2) * (1 - rel) + (o.len > 8 ? 1.3 : 1.0) * rel)
          if (g < gap) {
            gap = g
            blocker = o
          }
        }
      }
    // while turning, also look where the curve ends: someone just inside the street we're turning into
    if (c.path?.turn) {
      const p3 = c.path.p3
      const ex = DIRS[c.dir][0]
      const ez = DIRS[c.dir][1]
      const remaining = (1 - c.t) * c.path.len
      const ii = Math.floor((p3.x + HALF) / CELL)
      const jj = Math.floor((p3.z + HALF) / CELL)
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const a = ii + di
          const b = jj + dj
          if (a < 0 || b < 0 || a >= GRID || b >= GRID) continue
          for (const o of grid.get(idx(a, b)) || []) {
            if (o === c) continue
            const ax = o.x - p3.x
            const az = o.z - p3.z
            const along = ax * ex + az * ez
            const lat = Math.abs(ax * ez - az * ex)
            if (lat > 1.8 || along < -o.len || along > 12) continue
            const g = remaining + along - (o.len + c.len) / 2
            if (g < gap) {
              gap = g
              blocker = o
            }
          }
        }
    }
    return { gap, blocker }
  }

  /** Offset from the cell centre line (to the right of travel) for a lane. */
  laneOffset(k, lane) {
    if (this.net.kind[k] === AVENUE) return lane ? -2.4 : 1.1
    return LANE
  }

  /** Check the mirrors: is the other lane clear beside and ahead of us? */
  laneFree(c, k, next, dir, lane) {
    for (const cell of [k, next, c.prevK ?? k]) {
      for (const o of this.byCell?.get(cell) || []) {
        if (o === c || o.dir !== dir) continue
        if (o.lane === lane || o.path?.turn) return false
      }
    }
    return true
  }

  /** Does driving from cell k in direction d only lead to a dead end? */
  deadAhead(k, d) {
    const key = k * 4 + d
    if (!this.deadCache) this.deadCache = new Map()
    let v = this.deadCache.get(key)
    if (v !== undefined) return v
    v = false
    let cell = k
    for (let q = 0; q < 40; q++) {
      const kind = this.net.kind[cell]
      if (kind === END) {
        v = !(this.edgeExit[cell] & (1 << d)) // a road that leaves the map is a way out, not a dead end
        break
      }
      if (kind === JUNCTION || kind === BEND || !this.road[cell]) break
      const i = (cell % GRID) + DIRS[d][0]
      const j = Math.floor(cell / GRID) + DIRS[d][1]
      if (i < 0 || j < 0 || i >= GRID || j >= GRID) break
      cell = idx(i, j)
    }
    this.deadCache.set(key, v)
    return v
  }

  /** First cell past the intersection that starts at k when travelling dir. */
  beyond(k, dir) {
    let cell = k
    for (let q = 0; q < 4 && this.inter[cell]; q++) {
      const i = (cell % GRID) + DIRS[dir][0]
      const j = Math.floor(cell / GRID) + DIRS[dir][1]
      if (i < 0 || j < 0 || i >= GRID || j >= GRID) break
      cell = idx(i, j)
    }
    return cell
  }

  /**
   * Enter cell k having travelled inDir. Chooses where to leave (straight, turn,
   * U-turn at a dead end), which lane, and builds the curve from p0 (the end
   * of the previous curve) to the exit edge.
   */
  enterCell(c, k, inDir, p0) {
    const { carOut, inter, blocked, net } = this
    const prevK = c.k
    c.prevK = prevK
    const entering = inter[k] && !inter[prevK]
    c.k = k
    const i = k % GRID
    const j = (k - i) / GRID
    const back = (inDir + 2) % 4
    const opts = [0, 1, 2, 3].filter((d) => d !== back && carOut[k] & (1 << d) && !blocked[idx(i + DIRS[d][0], j + DIRS[d][1])])
    if (entering) {
      c.entryDir = inDir
      c.exitDir = c.planK === k ? c.planDir : inDir
    }
    // drivers avoid streets that only lead to a dead end
    const through = opts.filter((d) => !this.deadAhead(idx(i + DIRS[d][0], j + DIRS[d][1]), d))
    const pickFrom = through.length ? through : opts
    let dir = inDir
    // carry on off the map where the road leaves the district
    const exits = [0, 1, 2, 3].filter((d) => d !== back && this.edgeExit[k] & (1 << d))
    c.exiting = false
    if (exits.length && (!opts.length || Math.random() < 0.6)) {
      dir = exits[Math.floor(Math.random() * exits.length)]
      c.exiting = true
    } else if (!opts.length) dir = carOut[k] & (1 << back) ? back : inDir
    else if (inter[k]) {
      if (opts.includes(c.exitDir)) dir = c.exitDir
      else if (!opts.includes(inDir)) dir = c.exitDir = pickFrom[Math.floor(Math.random() * pickFrom.length)]
      if (through.length && !through.includes(dir)) dir = c.exitDir = through.includes(inDir) ? inDir : through[Math.floor(Math.random() * through.length)]
    } else if (!(pickFrom.includes(inDir) && Math.random() < 0.7)) dir = pickFrom[Math.floor(Math.random() * pickFrom.length)]
    if (!inter[k]) c.entryDir = c.exitDir = -1
    c.dir = dir
    // lane at the exit edge
    const ni = i + DIRS[dir][0]
    const nj = j + DIRS[dir][1]
    const next = ni >= 0 && nj >= 0 && ni < GRID && nj < GRID ? idx(ni, nj) : k
    const roadAhead = inter[next] ? this.beyond(next, dir) : next
    const avenueAhead = net.kind[roadAhead] === AVENUE || net.kind[k] === AVENUE
    if (!avenueAhead) c.lane = 0
    else if (dir !== inDir) c.lane = dir === (inDir + 1) % 4 ? 0 : 1 // right turns into the kerb lane, left into the inner lane
    else if (net.kind[k] === AVENUE && Math.random() < 0.12 && this.laneFree(c, k, next, dir, 1 - c.lane)) c.lane = 1 - c.lane // occasional, gradual lane change
    else if (net.kind[prevK] !== AVENUE && net.kind[k] === AVENUE) c.lane = Math.random() < 0.5 ? 0 : 1
    const offOut = avenueAhead ? (c.lane ? -2.4 : 1.1) : LANE
    const [ex, ez] = DIRS[dir]
    const [rx, rz] = right(dir)
    const cx = cellToWorld(i)
    const cz = cellToWorld(j)
    const p3 = { x: cx + ex * CELL * 0.5 + rx * offOut, z: cz + ez * CELL * 0.5 + rz * offOut }
    if (!p0) {
      const [qx, qz] = right(inDir)
      const off = this.laneOffset(k, c.lane)
      p0 = { x: cx - DIRS[inDir][0] * CELL * 0.5 + qx * off, z: cz - DIRS[inDir][1] * CELL * 0.5 + qz * off }
    }
    const [ix, iz] = DIRS[inDir]
    let p1
    let p2
    let turn = 0
    if (dir === inDir) {
      p1 = { x: p0.x + ix * CELL * 0.35, z: p0.z + iz * CELL * 0.35 }
      p2 = { x: p3.x - ex * CELL * 0.35, z: p3.z - ez * CELL * 0.35 }
    } else if (dir === back) {
      turn = 2 // U-turn
      p1 = { x: p0.x + ix * 6, z: p0.z + iz * 6 }
      p2 = { x: p3.x - ex * 6, z: p3.z - ez * 6 }
    } else {
      turn = 1
      const a = Math.abs((p3.x - p0.x) * ix + (p3.z - p0.z) * iz)
      const b = Math.abs((p3.x - p0.x) * ex + (p3.z - p0.z) * ez)
      p1 = { x: p0.x + ix * a * 0.55, z: p0.z + iz * a * 0.55 }
      p2 = { x: p3.x - ex * b * 0.55, z: p3.z - ez * b * 0.55 }
    }
    const path = { p0, p1, p2, p3, turn, radius: turn === 1 ? Math.min(Math.abs((p3.x - p0.x) * ix + (p3.z - p0.z) * iz), Math.abs((p3.x - p0.x) * ex + (p3.z - p0.z) * ez)) : 99, len: 0 }
    let len = 0
    let prev = p0
    for (let q = 1; q <= 8; q++) {
      const pt = this.pathPoint(path, q / 8)
      len += Math.hypot(pt.x - prev.x, pt.z - prev.z)
      prev = pt
    }
    path.len = Math.max(1, len)
    c.path = path
  }

  /** Position and heading on a cubic Bézier path. */
  pathPoint(p, t) {
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const cc = 3 * u * t * t
    const d = t * t * t
    const x = a * p.p0.x + b * p.p1.x + cc * p.p2.x + d * p.p3.x
    const z = a * p.p0.z + b * p.p1.z + cc * p.p2.z + d * p.p3.z
    const tx = 3 * u * u * (p.p1.x - p.p0.x) + 6 * u * t * (p.p2.x - p.p1.x) + 3 * t * t * (p.p3.x - p.p2.x)
    const tz = 3 * u * u * (p.p1.z - p.p0.z) + 6 * u * t * (p.p2.z - p.p1.z) + 3 * t * t * (p.p3.z - p.p2.z)
    return { x, z, yaw: Math.atan2(-tz, tx) }
  }

  /**
   * Right of way at an intersection: no conflicting movement inside it, room
   * to leave it (don't block the box), and left turns yield to oncoming traffic.
   */
  mayEnter(c, nk, byCluster, byCell, signal) {
    const { inter, net } = this
    const opp = (c.dir + 2) % 4
    const left = (c.dir + 3) % 4
    const myTurn = c.planK === nk ? c.planDir : c.dir
    for (const o of byCluster.get(net.cluster[nk]) || []) {
      if (o === c || o.entryDir === c.dir) continue
      const oStraight = o.exitDir === o.entryDir
      const oRight = o.exitDir === (o.entryDir + 1) % 4
      const meStraight = myTurn === c.dir
      const meRight = myTurn === (c.dir + 1) % 4
      if (o.entryDir === opp && (oStraight || oRight) && (meStraight || meRight)) continue // opposite flows don't cross
      return false
    }
    // room on the far side?
    const exitCell = this.beyond(nk, c.dir)
    const target = myTurn === c.dir ? exitCell : this.turnExit(nk, c.dir, myTurn)
    for (const o of byCell.get(target) || []) if (o.dir === myTurn && o.t < 0.6 && o.speed < 2) return false
    // a left turn waits for a gap in oncoming traffic (unless the light is ending)
    if (myTurn === left && signal === 'G') {
      const oncoming = this.beyond(nk, c.dir)
      for (const cell of [oncoming]) {
        for (const o of byCell.get(cell) || []) {
          if (o.dir !== opp || o.speed < 0.5) continue
          const oTurn = o.planK >= 0 && inter[o.planK] && net.cluster[o.planK] === net.cluster[nk] ? o.planDir : o.dir
          if (oTurn !== (opp + 3) % 4) return false
        }
      }
      for (const o of byCluster.get(net.cluster[nk]) || []) if (o.entryDir === opp) return false
    }
    return true
  }

  /** Cell where a turning vehicle leaves the intersection that starts at nk. */
  turnExit(nk, inDir, outDir) {
    let cell = nk
    for (let q = 0; q < 4 && this.inter[cell]; q++) {
      if (this.carOut[cell] & (1 << outDir)) return this.beyond(cell, outDir)
      const i = (cell % GRID) + DIRS[inDir][0]
      const j = Math.floor(cell / GRID) + DIRS[inDir][1]
      if (i < 0 || j < 0 || i >= GRID || j >= GRID) break
      cell = idx(i, j)
    }
    return cell
  }

  /** A car that drove off the map is replaced by one arriving on another road into the district. */
  enterFromEdge(c) {
    const E = this.edgeEntries
    let e = null
    for (let tries = 0; tries < 12 && E.length; tries++) {
      const cand = E[Math.floor(Math.random() * E.length)]
      if (this.blocked[cand.k]) continue
      const x = cellToWorld(cand.k % GRID)
      const z = cellToWorld(Math.floor(cand.k / GRID))
      if (this.cars.some((o) => o !== c && o.state !== 'exit' && Math.abs(o.x - x) < 12 && Math.abs(o.z - z) < 12)) continue
      e = cand
      break
    }
    c.fade = 1
    c.fadeIn = undefined
    c.exiting = false
    c.state = 'drive'
    if (!e) return this.respawn(c)
    c.k = e.k
    c.dir = e.d
    c.t = 0
    c.speed = c.max * 0.6
    c.wait = 0
    c.planK = -1
    this.enterCell(c, e.k, e.d, null)
    c.fade = 0.25
    c.fadeIn = 0
  }

  /** A car with nowhere to go reappears somewhere else on the network. */
  respawn(c) {
    let k = this.usable[0]
    for (let tries = 0; tries < 30; tries++) {
      k = this.usable[Math.floor(Math.random() * this.usable.length)]
      const x = cellToWorld(k % GRID)
      const z = cellToWorld(Math.floor(k / GRID))
      if (!this.cars.some((o) => o !== c && Math.abs(o.x - x) < 9 && Math.abs(o.z - z) < 9)) break
    }
    const dirs = [0, 1, 2, 3].filter((d) => this.carOut[k] & (1 << d))
    c.dir = dirs[Math.floor(Math.random() * dirs.length)]
    c.t = 0.5
    c.speed = 0
    c.wait = 0
    c.planK = -1
    c.k = k
    this.enterCell(c, k, c.dir, null)
    c.init = true
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
    const nbr = this.walkOut
    const net = this.net
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
      const side = Math.sign(nrx * back[0] + nrz * back[1]) || 1
      if (!net.isJ(tk) && net.hasWalk(tk, turnDir, side)) return { kind: 'turn', dir: turnDir, k: tk, side }
    }
    if (canStraight && r < 0.85) return { kind: 'straight' }
    // cross the street we are on, then walk back — never across a divided avenue
    if (net.kind[p.k] === STREET && net.hasWalk(p.k, (p.dir + 2) % 4, p.side)) return { kind: 'cross' }
    return canStraight ? { kind: 'straight' } : { kind: 'back' }
  }

  updatePeds(dt, ctx) {
    const { peds, city, inter, net } = this
    const nbr = this.walkOut

    peds.forEach((p) => {
      if (p.mode === 'reserve') {
        // not out yet: still sitting in a car
        _m.makeScale(0, 0, 0)
        this.pedMeshes[p.pm].mesh.setMatrixAt(p.mi, _m)
        return
      }
      const k = this.cellOf(p.x, p.z)
      const i = k % GRID
      const j = (k - i) / GRID
      const depth = ctx.depthAt ? ctx.depthAt(k) : 0
      let lying = false
      let hidden = false
      let crouch = false
      let stride = 0
      if (!ctx.flood && p.mode !== 'dead' && p.mode !== 'indoors' && p.mode !== 'swept') this.quakeReaction(p, k, dt)
      if (p.mode === 'walk' || p.mode === 'flee' || p.mode === 'safe' || p.mode === 'toIndoors') {
        if (ctx.flood && depth > 0.45) {
          const [vx, vz] = ctx.flowAt(i, j)
          if (depth > 1.1 || Math.hypot(vx, vz) > 1.0) {
            p.mode = 'swept'
            p.sweptT = 0
          }
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
            } else if (!hold && p.plan.kind === 'back') {
              p.dir = (p.dir + 2) % 4
              p.side = -p.side
              p.t = 1 - p.t
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
              if (!net.isJ(p.k) && !net.hasWalk(p.k, p.dir, p.side)) p.side = -p.side
            }
            const [nx, nz] = this.walkPoint(p.k, p.dir, p.t, p.side)
            p.yaw = Math.atan2(-(nz - p.z), nx - p.x) || p.yaw
            p.x = nx
            p.z = nz
          }
        }
      } else if (p.mode === 'brace') {
        // stopped where they stand, crouched, waiting for the shaking to pass
        crouch = true
      } else if (p.mode === 'fallen') {
        // thrown off their feet
        lying = true
        p.fallT -= dt
        if (p.fallT <= 0) {
          p.mode = p.fear > 0.55 ? 'flee' : 'brace'
          p.field = this.safeField
        }
      } else if (p.mode === 'flee') {
        const f = (p.field ?? this.safeField)[k]
        // panicked people run flat out and erratically; frightened ones walk briskly
        const pace = ctx.flood ? p.panic : p.fear >= PANIC ? p.panic : 1.6 + p.fear * 1.2
        const wobble = ctx.flood ? 3 : 1.5 + p.fear * 4
        const away = p.threat && p.threat.until > this.time && Math.hypot(p.x - p.threat.x, p.z - p.threat.z) < 40
        if (away) {
          // get away from the collapse or fire first
          const dx = p.x - p.threat.x
          const dz = p.z - p.threat.z
          const d = Math.hypot(dx, dz) || 1
          if (this.steer(p, p.x + (dx / d) * 6 + Math.sin(p.phase * 3.1) * wobble, p.z + (dz / d) * 6 + Math.cos(p.phase * 2.7) * wobble, pace, dt)) stride = 0.85
        } else if (f === -1 || f === -2) {
          p.mode = 'safe'
          p.hx = p.x + (Math.random() - 0.5) * 6
          p.hz = p.z + (Math.random() - 0.5) * 6
        } else {
          const tx = cellToWorld(i + DIRS[f][0]) + Math.sin(p.phase * 7.3) * wobble
          const tz = cellToWorld(j + DIRS[f][1]) + Math.cos(p.phase * 5.1) * wobble
          if (this.steer(p, tx, tz, pace, dt)) stride = pace > 2.6 ? 0.85 : 0.6
        }
      } else if (p.mode === 'safe') {
        if (Math.hypot(p.hx - p.x, p.hz - p.z) > 0.5 && this.steer(p, p.hx, p.hz, 1, dt)) stride = 0.35
        // in the open they wait; once calm (and the ground is still) they go back to their day
        if (!ctx.flood && p.fear < 0.2 && this.felt(k) < 0.005 && Math.random() < dt * 0.02 && this.road[k] && !inter[k]) {
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
        hidden = depth > 0.4 || p.fallen // fell into the river with a bridge span
      }

      const ground = this.heightAt(k, p.x, p.z)
      const onWalk = this.road[k] && !this.onCarriageway(k, p.x, p.z) && !city.bridge[k]
      p.y = p.mode === 'swept' ? ground + Math.max(0, depth - 0.25) : ground + (onWalk ? KERB : 0)
      if (stride) p.phase += dt * (stride > 0.6 ? 11 : 7.5)
      _p.set(p.x, p.y + (lying ? 0.15 : 0), p.z)
      _q.setFromEuler(_e.set(lying ? -Math.PI / 2 : 0, p.yaw + Math.PI / 2, 0, 'YXZ'))
      const s = hidden ? 0 : 1
      _s.set(s, crouch ? s * 0.55 : s, s)
      _m.compose(_p, _q, _s)
      const pm = this.pedMeshes[p.pm]
      pm.mesh.setMatrixAt(p.mi, _m)
      pm.walk.array[p.mi * 2] = p.phase
      pm.walk.array[p.mi * 2 + 1] = lying ? 0 : stride
    })
    for (const pm of this.pedMeshes) {
      pm.mesh.instanceMatrix.needsUpdate = true
      pm.walk.needsUpdate = true
    }
  }

  /**
   * Fear and the immediate reaction to an earthquake. Most people stop and
   * brace while the ground moves (drop, cover, hold on), then walk out to open
   * ground away from buildings; the panicked run straight away; at intensity
   * VIII and above some are thrown off their feet. Fear fades over a minute or
   * two once the shaking stops, and each aftershock brings it back.
   */
  quakeReaction(p, k, dt) {
    const here = this.felt(k)
    p.fear = Math.max(p.fear - dt * 0.012, Math.min(1, fearOfShaking(here) * p.trait))
    const f = p.fear
    if (here > 0.25 && p.mode !== 'fallen' && Math.random() < dt * (here - 0.2) * 1.2) {
      p.mode = 'fallen'
      p.fallT = 1.5 + Math.random() * 3
      return
    }
    const flee = () => {
      p.mode = 'flee'
      p.field = this.safeField
    }
    if (p.mode === 'walk') {
      if (f >= PANIC) flee()
      else if (f > 0.2 && here > 0.01) p.mode = 'brace'
      else if (f > 0.55) flee()
    } else if (p.mode === 'brace') {
      if (f >= PANIC) flee()
      else if (here < 0.004) {
        // the shaking has stopped
        if (f > 0.35) flee()
        else p.mode = 'walk'
      }
    } else if (p.mode === 'safe' && f > 0.75 && p.threat && p.threat.until > this.time) flee()
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
    return n + (this.peds || []).filter((p) => p.mode !== 'reserve').length
  }
}
