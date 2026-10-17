// Three.js scene: terrain and surrounding landscape, buildings, water,
// city life, props and effects.
import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { GRID, CELL, CELL_ROAD, CELL_RIVER, CELL_BANK, CELL_PARK, CELL_POND, CELL_GRASS, BUILDING_TYPES, CITY_TYPES, RIVER_HALF_WIDTH, RIVER_DEPTH } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { makeNoise2D, clamp, lerp, smoothstep } from './math.js'
import { Particles, Debris, Rain } from './effects.js'
import { makeBuildingMaterial, makeSwayDepthMaterial, makeWaterMaterial, SkyEnvironment } from './materials.js'
import { CityLife } from './cityLife.js'
import { buildRoadMeshes } from './roads.js'
import { Subsurface } from './subsurface.js'
import { loadModels } from './quaternius.js'

const HALF = (GRID * CELL) / 2
const PX = 16 // terrain texture pixels per cell
const OUTER = 3600 // half-size of the surrounding landscape (m)
const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _t = new THREE.Matrix4()
const _c = new THREE.Color()
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()
const _e = new THREE.Euler()

function gableGeometry() {
  // ridge along X, footprint 1×1, height 1
  const p = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
  ]
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
  g.computeVertexNormals()
  return g
}

function iconTexture(letter, bg) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  g.fillStyle = 'rgba(0,0,0,0.35)'
  g.beginPath()
  g.arc(32, 34, 28, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = bg
  g.beginPath()
  g.arc(32, 32, 27, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = '#fff'
  g.lineWidth = 4
  g.stroke()
  g.fillStyle = '#fff'
  g.font = 'bold 34px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(letter, 32, 34)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

export class World {
  constructor(container) {
    this.container = container
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    const scene = new THREE.Scene()
    this.scene = scene
    scene.fog = new THREE.Fog(0x9fb8cf, 1200, 5200)
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 12000)
    camera.position.set(-520, 520, 620)
    this.camera = camera
    const controls = new MapControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = 1.42
    controls.minDistance = 12
    controls.maxDistance = 2600
    controls.screenSpacePanning = false
    controls.zoomToCursor = true
    this.controls = controls

    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 1.0)
    scene.add(this.hemi)
    const sun = new THREE.DirectionalLight(0xffffff, 2.4)
    sun.castShadow = true
    sun.shadow.mapSize.set(4096, 4096)
    const sc = sun.shadow.camera
    sc.left = -680
    sc.right = 680
    sc.top = 680
    sc.bottom = -680
    sc.near = 50
    sc.far = 3200
    sun.shadow.bias = -0.0003
    sun.shadow.normalBias = 0.5
    scene.add(sun)
    scene.add(sun.target)
    this.sun = sun

    this.uNight = { value: 0 }
    this.uTime = { value: 0 }
    this.uRain = { value: 0 }
    this.sky = new SkyEnvironment(renderer)
    this.sky.update({ top: new THREE.Color(0x4f7fbf), horizon: new THREE.Color(0xbcd4ea), ground: new THREE.Color(0x3b4535), sunDir: new THREE.Vector3(0.3, 0.8, 0.2), sunCol: new THREE.Color(1, 0.95, 0.85) })
    this.envMaterials = new Set()
    this.lastEnvT = -10

    this.root = new THREE.Group()
    scene.add(this.root)

    this.fire = new Particles(scene, 3000, true)
    this.smoke = new Particles(scene, 3500, false)
    this.dust = new Particles(scene, 4000, false)
    this.debris = new Debris(scene, 6000)
    this.debris.surfaceAt = (x, z, src) => this.surfaceAt(x, z, src)
    this.debris.onLand = (it, v, bid) => this.debrisLanded(it, v, bid)
    this.debris.onShatter = (it) => this.shatter(it)
    this.rain = new Rain(scene)
    this.life = new CityLife(scene, this)
    this.lifeCtx = {}
    this.impactAcc = new Map()
    this.subsurface = new Subsurface(this)
    // CC0 Quaternius vehicles and people stream in; built-in models are used until then
    loadModels().then((m) => {
      if (!m) return
      this.modelAssets = m
      if (this.useModels !== false) this.life.models = m
      this.onAssetsLoaded?.()
    })
    this.showWorld = true
    this.blockShake = new THREE.Vector3()

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
      new THREE.LineBasicMaterial({ color: 0x4ade80, depthTest: false, transparent: true }),
    )
    this.highlight.renderOrder = 10
    this.highlight.visible = false
    scene.add(this.highlight)

    this.icons = { hospital: iconTexture('H', '#dc2626'), fire: iconTexture('F', '#ea580c'), shelter: iconTexture('S', '#16a34a'), school: iconTexture('E', '#ca8a04') }
    this.raycaster = new THREE.Raycaster()
    this.anim = new Map()
    this.shakes = []
    this.realTime = 0
    this.colorFn = null
    this.camShake = new THREE.Vector3()
    this.nightF = 0

    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  get envTexture() {
    return this.sky.texture
  }

  trackEnv(mat) {
    mat.envMap = this.sky.texture
    this.envMaterials.add(mat)
    return mat
  }

  resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ------------------------------------------------------------------ city
  buildCity(city, hour = 12) {
    this.city = city
    for (const c of [...this.root.children]) {
      this.root.remove(c)
      c.traverse?.((o) => {
        o.geometry?.dispose()
        if (o.material && o.material !== this.waterMat) o.material.dispose?.()
      })
    }
    this.envMaterials.clear()
    this.anim.clear()
    this.impactAcc.clear()
    this.shakes = []
    this.fire.clear()
    this.smoke.clear()
    this.dust.clear()
    this.debris.clear()
    this.noise = makeNoise2D(city.seed + 99)
    this.buildTerrain()
    this.buildRoads()
    this.subsurface.build(city)
    this.root.add(this.subsurface.group)
    this.outerMesh = null
    this.forestMesh = null
    // the surrounding landscape is only generated when it is switched on
    if (this.showWorld) this.buildOuter()
    this.buildWater()
    this.buildTrees()
    this.rebuildBuildings()
    this.rebuildStatic()
    this.life.build(city, hour)
    this.applyWorldVisibility()
    this.paintLamps()
  }

  vertexHeight(vi, vj) {
    const { city } = this
    let s = 0
    let n = 0
    for (let dj = -1; dj <= 0; dj++)
      for (let di = -1; di <= 0; di++) {
        const i = vi + di
        const j = vj + dj
        if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
        s += city.z[idx(i, j)]
        n++
      }
    return s / n
  }

  groundAt(x, z) {
    if (!this.city) return 0
    const fi = clamp((x + HALF) / CELL - 0.5, 0, GRID - 1.001)
    const fj = clamp((z + HALF) / CELL - 0.5, 0, GRID - 1.001)
    const i = Math.floor(fi)
    const j = Math.floor(fj)
    const u = fi - i
    const v = fj - j
    const Z = this.city.z
    const a = Z[idx(i, j)]
    const b = Z[idx(Math.min(i + 1, GRID - 1), j)]
    const c = Z[idx(i, Math.min(j + 1, GRID - 1))]
    const d = Z[idx(Math.min(i + 1, GRID - 1), Math.min(j + 1, GRID - 1))]
    return lerp(lerp(a, b, u), lerp(c, d, u), v)
  }

  /** Top of whatever is at (x,z): a standing building's roof or the ground. */
  surfaceAt(x, z, src = -1) {
    const ground = this.groundAt(x, z)
    if (!this.city || x < -HALF || z < -HALF || x >= HALF || z >= HALF) return { y: ground, bid: -1 }
    const i = Math.floor((x + HALF) / CELL)
    const j = Math.floor((z + HALF) / CELL)
    const bid = this.city.buildingAt[idx(i, j)]
    if (bid < 0 || bid === src) return { y: ground, bid: -1 }
    const b = this.city.byId.get(bid)
    if (!b || Math.abs(x - b.cx) > b.fw / 2 + 0.3 || Math.abs(z - b.cz) > b.fd / 2 + 0.3) return { y: ground, bid: -1 }
    const a = this.anim.get(bid)
    if (a?.topple) return { y: ground, bid: -1 }
    return { y: Math.max(ground, b.base + b.elevated + b.height * (a?.hScale ?? 1)), bid }
  }

  isRubble(b) {
    return !!this.anim.get(b.id)?.rubble
  }

  gridGeometry() {
    const V = GRID + 1
    const pos = new Float32Array(V * V * 3)
    const uv = new Float32Array(V * V * 2)
    for (let vj = 0; vj < V; vj++)
      for (let vi = 0; vi < V; vi++) {
        const k = vj * V + vi
        pos[k * 3] = -HALF + vi * CELL
        pos[k * 3 + 2] = -HALF + vj * CELL
        uv[k * 2] = vi / GRID
        uv[k * 2 + 1] = 1 - vj / GRID
      }
    const index = []
    for (let vj = 0; vj < GRID; vj++)
      for (let vi = 0; vi < GRID; vi++) {
        const a = vj * V + vi
        const b = a + 1
        const c = a + V
        const d = c + 1
        index.push(a, c, b, b, c, d)
      }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex(index)
    return g
  }

  buildTerrain() {
    const g = this.gridGeometry()
    this.terrainGeo = g
    this.updateTerrainHeights()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = GRID * PX
    this.terrainCanvas = canvas
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    this.terrainTex = tex
    const lamp = document.createElement('canvas')
    lamp.width = lamp.height = 1024
    this.lampCanvas = lamp
    this.lampTex = new THREE.CanvasTexture(lamp)
    this.lampTex.colorSpace = THREE.SRGBColorSpace
    this.paintTerrain()
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, emissive: 0xffffff, emissiveMap: this.lampTex, emissiveIntensity: 0 })
    this.terrainMat = mat
    const mesh = new THREE.Mesh(g, mat)
    mesh.receiveShadow = true
    this.terrain = mesh
    this.root.add(mesh)
  }

  buildRoads() {
    const { road, walk } = buildRoadMeshes(this.city, this.renderer, (vi, vj) => this.vertexHeight(vi, vj), this.lampTex)
    this.roadMesh = road
    this.walkMesh = walk
    this.root.add(road, walk)
  }

  paintLamps() {
    this.life.paintLampMap(this.lampCanvas.getContext('2d'), this.lampCanvas.width)
    this.lampTex.needsUpdate = true
  }

  updateTerrainHeights() {
    const g = this.terrainGeo
    const pos = g.attributes.position.array
    const V = GRID + 1
    for (let vj = 0; vj < V; vj++) for (let vi = 0; vi < V; vi++) pos[(vj * V + vi) * 3 + 1] = this.vertexHeight(vi, vj)
    g.attributes.position.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
    g.computeBoundingBox()
    if (this.outerMesh) this.updateOuterHeights()
    if (this.subsurface.city) {
      this.subsurface.build(this.city)
      this.subsurface.setQuake(this.subsurface.quake)
    }
  }

  /** Show the generated landscape around the district, or just the district on a cut-away block. */
  setShowWorld(v) {
    this.showWorld = v
    if (v && !this.outerMesh && this.city) this.buildOuter()
    this.applyWorldVisibility()
  }

  applyWorldVisibility() {
    const v = this.showWorld
    if (this.outerMesh) this.outerMesh.visible = v
    if (this.forestMesh) this.forestMesh.visible = v
    for (const m of this.outerRivers || []) m.visible = v
    this.subsurface.group.visible = !v
    // without surroundings you may orbit low enough to look at the cross-section
    this.controls.maxPolarAngle = v ? 1.42 : 1.68
  }

  // ----------------------------------------------------- surrounding landscape
  outerCoords() {
    const xs = []
    for (let x = -OUTER; x < -HALF; x += 100) xs.push(x)
    for (let x = -HALF; x <= HALF; x += CELL) xs.push(x)
    for (let x = HALF + 100; x <= OUTER; x += 100) xs.push(x)
    return xs
  }

  outerHeight(x, z) {
    const { city, noise } = this
    // inside (or on the edge of) the district: match the district terrain exactly
    if (Math.abs(x) <= HALF + 0.01 && Math.abs(z) <= HALF + 0.01) {
      const vi = Math.round((x + HALF) / CELL)
      const vj = Math.round((z + HALF) / CELL)
      const onEdge = vi === 0 || vj === 0 || vi === GRID || vj === GRID
      return this.vertexHeight(vi, vj) - (onEdge ? 0 : 6)
    }
    const ex = clamp(x, -HALF, HALF)
    const ez = clamp(z, -HALF, HALF)
    const edgeH = this.vertexHeight(Math.round((ex + HALF) / CELL), Math.round((ez + HALF) / CELL))
    const dist = Math.hypot(x - ex, z - ez)
    // the river keeps flowing north–south beyond the district
    const rx = (z < 0 ? city.riverCenter[0] : city.riverCenter[GRID - 1]) * CELL - HALF
    const bank = 20 - (z + HALF) * 0.0015
    const dr = Math.abs(x - rx)
    const hw = RIVER_HALF_WIDTH * CELL
    let natural
    if (dr < hw) {
      const t = dr / hw
      natural = bank - RIVER_DEPTH * (1 - Math.pow(t, 3.2))
    } else {
      const valley = smoothstep(hw, 900, dr)
      const hills = (noise.fbm(x * 0.0016, z * 0.0016, 5) * 45 + 30) * valley
      const ridged = (1 - Math.abs(noise.fbm(x * 0.0007 + 40, z * 0.0007 - 13, 5))) ** 3
      const far = smoothstep(500, 3200, Math.hypot(x, z))
      const mountains = ridged * 420 * far * valley
      natural = bank + 0.5 + Math.max(0, dr - hw) * 0.012 + Math.max(0, hills) + mountains
    }
    const w = smoothstep(0, 350, dist)
    return lerp(edgeH, natural, w)
  }

  buildOuter() {
    const xs = this.outerCoords()
    const n = xs.length
    const pos = new Float32Array(n * n * 3)
    const col = new Float32Array(n * n * 3)
    const index = []
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i
        pos[k * 3] = xs[i]
        pos[k * 3 + 2] = xs[j]
      }
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i
        const b = a + 1
        const c = a + n
        const d = c + 1
        index.push(a, c, b, b, c, d)
      }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    g.setIndex(index)
    this.outerGeo = g
    this.outerN = n
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }))
    mesh.receiveShadow = true
    this.outerMesh = mesh
    this.root.add(mesh)
    this.updateOuterHeights()
    this.buildOuterForest()
  }

  updateOuterHeights() {
    const g = this.outerGeo
    const pos = g.attributes.position.array
    const col = g.attributes.color.array
    const n = this.outerN
    const { noise } = this
    for (let k = 0; k < n * n; k++) pos[k * 3 + 1] = this.outerHeight(pos[k * 3], pos[k * 3 + 2])
    g.computeVertexNormals()
    const nor = g.attributes.normal.array
    for (let k = 0; k < n * n; k++) {
      const x = pos[k * 3]
      const z = pos[k * 3 + 2]
      const y = pos[k * 3 + 1]
      const slope = 1 - nor[k * 3 + 1]
      const f = noise.fbm(x * 0.004, z * 0.004, 3)
      const above = y - (20 - (z + HALF) * 0.0015)
      // meadow → forest → rock → snow
      _c.setRGB(0.36 + f * 0.05, 0.47 + f * 0.06, 0.25)
      if (f > 0.05 || above > 40) _c.lerp(new THREE.Color(0.17, 0.27, 0.15), smoothstep(0.0, 0.25, f) * 0.85 + smoothstep(40, 90, above) * 0.3)
      _c.lerp(new THREE.Color(0.45, 0.42, 0.38), smoothstep(0.25, 0.55, slope) + smoothstep(220, 330, above))
      _c.lerp(new THREE.Color(0.93, 0.94, 0.96), smoothstep(360, 430, above) * (1 - smoothstep(0.5, 0.8, slope)))
      if (above < 0.5) _c.setRGB(0.38, 0.33, 0.24)
      col.set([_c.r, _c.g, _c.b], k * 3)
    }
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate = true
    g.computeBoundingSphere()
  }

  buildOuterForest() {
    const { noise } = this
    const geo = new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0)
    const max = 4500
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), max)
    let n = 0
    let tries = 0
    while (n < max && tries < max * 6) {
      tries++
      const x = (Math.random() * 2 - 1) * 2600
      const z = (Math.random() * 2 - 1) * 2600
      if (Math.abs(x) < HALF + 15 && Math.abs(z) < HALF + 15) continue
      const f = noise.fbm(x * 0.004, z * 0.004, 3)
      if (f < 0.04) continue
      const y = this.outerHeight(x, z)
      const above = y - (20 - (z + HALF) * 0.0015)
      if (above < 1.5 || above > 300) continue
      const s = 6 + Math.random() * 7
      _m.makeScale(s * 0.38, s * 1.6, s * 0.38).setPosition(x, y - 0.5, z)
      mesh.setMatrixAt(n, _m)
      mesh.setColorAt(n++, _c.setHSL(0.3 + Math.random() * 0.06, 0.4, 0.14 + Math.random() * 0.07))
    }
    mesh.count = n
    mesh.castShadow = false
    mesh.receiveShadow = true
    this.forestMesh = mesh
    this.root.add(mesh)
  }

  paintTerrain() {
    const { city, noise } = this
    const ctx = this.terrainCanvas.getContext('2d')
    const P = CITY_TYPES[city.type]
    const fieldCols = ['#7d9a4a', '#8fa356', '#a39c5a', '#6f8f43', '#94a862', '#b3a46a']
    const Z = (i, j) => city.z[idx(clamp(i, 0, GRID - 1), clamp(j, 0, GRID - 1))]
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k = idx(i, j)
        const t = city.cellType[k]
        const n = noise.fbm(i * 0.2, j * 0.2, 2)
        let col
        if (t === CELL_ROAD) col = '#3b3e44'
        else if (t === CELL_RIVER) col = '#4a4030'
        else if (t === CELL_BANK) col = '#b5a477'
        else if (t === CELL_PARK) col = `hsl(105, 42%, ${33 + n * 6}%)`
        else if (t === CELL_POND) col = '#58613f'
        else {
          const dist = Math.hypot(i - city.center.i, j - city.center.j)
          if (dist > P.radius * 1.05 && city.type === 'rural') {
            const fi = Math.floor((i + 3) / 7)
            const fj = Math.floor((j + 1) / 5)
            const h = Math.abs(Math.sin(fi * 12.9898 + fj * 78.233 + city.seed) * 43758.5453) % 1
            col = fieldCols[Math.floor(h * fieldCols.length)]
          } else col = `hsl(${92 + n * 10}, ${34 + n * 8}%, ${36 + n * 5}%)`
        }
        ctx.fillStyle = col
        ctx.fillRect(i * PX, j * PX, PX, PX)
        if (t === CELL_GRASS) {
          // steep ground shows soil and rock
          const slope = Math.max(Math.abs(Z(i + 1, j) - Z(i - 1, j)), Math.abs(Z(i, j + 1) - Z(i, j - 1))) / (2 * CELL)
          const rock = smoothstep(0.12, 0.35, slope)
          if (rock > 0) {
            ctx.fillStyle = `rgba(${118 + n * 20},${104 + n * 15},${84},${rock * 0.85})`
            ctx.fillRect(i * PX, j * PX, PX, PX)
          }
          if (city.type === 'rural' && Math.hypot(i - city.center.i, j - city.center.j) > P.radius * 1.05) {
            ctx.fillStyle = 'rgba(0,0,0,0.06)'
            for (let r = 0; r < PX; r += 4) ctx.fillRect(i * PX, j * PX + r, PX, 1)
          }
        }
      }
    // smooth river channel & sandy banks following the real centreline
    const { riverCenter } = city
    for (let py = 0; py < GRID * PX; py++) {
      const fj = py / PX - 0.5
      const j0 = clamp(Math.floor(fj), 0, GRID - 1)
      const j1 = clamp(j0 + 1, 0, GRID - 1)
      const c = lerp(riverCenter[j0], riverCenter[j1], fj - Math.floor(fj)) * PX
      const hw = RIVER_HALF_WIDTH * PX
      const bank = hw + 1.3 * PX
      for (let px = Math.floor(c - bank - 2); px <= Math.ceil(c + bank + 2); px++) {
        const i = Math.floor(px / PX)
        const j = Math.floor(py / PX)
        if (i < 0 || i >= GRID) continue
        const t = city.cellType[idx(i, j)]
        if (t === CELL_ROAD || city.buildingAt[idx(i, j)] >= 0) continue
        const d = Math.abs(px + 0.5 - c)
        if (d < hw) ctx.fillStyle = d < hw * 0.7 ? '#3f382b' : (px * 3 + py * 5) % 7 < 1 ? '#6e6250' : '#5d4f38'
        else if (d < bank) ctx.fillStyle = (px * 7 + py * 13) % 11 < 1 ? '#a8966a' : '#b5a477'
        else if (t === CELL_BANK || t === CELL_RIVER) ctx.fillStyle = 'hsl(95, 36%, 37%)'
        else continue
        ctx.fillRect(px, py, 1, 1)
      }
    }
    // lots
    for (const b of city.buildings) {
      if (b.removed) continue
      const x = b.x * PX
      const y = b.y * PX
      const w = b.w * PX
      const d = b.d * PX
      if (b.type === 'house') {
        ctx.fillStyle = 'rgba(80,120,60,0.5)'
        ctx.fillRect(x + 1, y + 1, w - 2, d - 2)
        ctx.fillStyle = '#8a8780'
        ctx.fillRect(x + w / 2 - 2, y + d - 6, 4, 6)
      } else {
        ctx.fillStyle = b.type === 'industrial' ? '#7c7a72' : '#9a978e'
        ctx.fillRect(x, y, w, d)
        if (b.type !== 'industrial' && b.floors < 10) {
          // parking bays
          ctx.fillStyle = 'rgba(255,255,255,0.35)'
          for (let s = x + 3; s < x + w - 3; s += 3) ctx.fillRect(s, y + d - 5, 0.6, 4)
        }
      }
    }
    // road details: kerbs, sidewalks, lane markings, zebra crossings
    const isRoad = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID && (city.cellType[idx(i, j)] === CELL_ROAD || city.bridge[idx(i, j)])
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        if (city.cellType[idx(i, j)] !== CELL_ROAD) continue
        const x = i * PX
        const y = j * PX
        const L = isRoad(i - 1, j)
        const R = isRoad(i + 1, j)
        const U = isRoad(i, j - 1)
        const D = isRoad(i, j + 1)
        ctx.fillStyle = '#9f9d95'
        if (!U) ctx.fillRect(x, y, PX, 3)
        if (!D) ctx.fillRect(x, y + PX - 3, PX, 3)
        if (!L) ctx.fillRect(x, y, 3, PX)
        if (!R) ctx.fillRect(x + PX - 3, y, 3, PX)
        ctx.fillStyle = '#6f6d68'
        if (!U) ctx.fillRect(x, y + 3, PX, 0.5)
        if (!D) ctx.fillRect(x, y + PX - 3.5, PX, 0.5)
        if (!L) ctx.fillRect(x + 3, y, 0.5, PX)
        if (!R) ctx.fillRect(x + PX - 3.5, y, 0.5, PX)
        const ns = U || D
        const ew = L || R
        if (ew && !ns) {
          ctx.fillStyle = '#e2c55a'
          ctx.fillRect(x, y + PX / 2 - 0.4, PX, 0.8)
        } else if (ns && !ew) {
          ctx.fillStyle = '#e2c55a'
          ctx.fillRect(x + PX / 2 - 0.4, y, 0.8, PX)
        } else if (ns && ew) {
          ctx.fillStyle = 'rgba(235,235,230,0.7)'
          for (let s = 3.5; s < PX - 3; s += 1.6) {
            if (U) ctx.fillRect(x + s, y, 0.8, 2.2)
            if (D) ctx.fillRect(x + s, y + PX - 2.2, 0.8, 2.2)
            if (L) ctx.fillRect(x, y + s, 2.2, 0.8)
            if (R) ctx.fillRect(x + PX - 2.2, y + s, 2.2, 0.8)
          }
        }
        if (Math.random() < 0.15) {
          ctx.fillStyle = 'rgba(0,0,0,0.12)'
          ctx.fillRect(x + Math.random() * PX, y + Math.random() * PX, 2, 1.2)
        }
      }
    for (let k = 0; k < GRID * GRID; k++)
      if (city.levee[k] > 0) {
        ctx.fillStyle = '#6d6047'
        ctx.fillRect((k % GRID) * PX, Math.floor(k / GRID) * PX, PX, PX)
      }
    this.terrainTex.needsUpdate = true
  }

  // ------------------------------------------------------------------ water
  buildWater() {
    const g = this.gridGeometry()
    const V = GRID + 1
    g.setAttribute('aWater', new THREE.BufferAttribute(new Float32Array(V * V * 4), 4))
    this.waterGeo = g
    this.waterMat = this.waterMat || this.trackEnv(makeWaterMaterial({ envMap: this.sky.texture, uTime: this.uTime, uRain: this.uRain }))
    this.envMaterials.add(this.waterMat)
    const mesh = new THREE.Mesh(g, this.waterMat)
    mesh.receiveShadow = true
    mesh.renderOrder = 2
    this.water = mesh
    this.root.add(mesh)
    this.wetVert = new Uint8Array(V * V)
    this.vh = new Float32Array(V * V)
    // the river continues beyond the district to the north and south
    this.outerRivers = []
    for (const s of [-1, 1]) {
      const len = OUTER - HALF
      const w = RIVER_HALF_WIDTH * CELL * 2.2
      const geo = new THREE.PlaneGeometry(w, len, 1, 20).rotateX(-Math.PI / 2)
      const n = geo.attributes.position.count
      const aw = new Float32Array(n * 4)
      for (let q = 0; q < n; q++) aw.set([3, 0, 0, s * 1.2], q * 4)
      geo.setAttribute('aWater', new THREE.BufferAttribute(aw, 4))
      const m = new THREE.Mesh(geo, this.waterMat)
      const rx = (s < 0 ? this.city.riverCenter[0] : this.city.riverCenter[GRID - 1]) * CELL - HALF
      m.position.set(rx, 0, s * (HALF + len / 2))
      m.renderOrder = 2
      this.outerRivers.push(m)
      this.root.add(m)
    }
  }

  /** Rebuild the water surface from a FloodSim (h, zg, vx, vz arrays). */
  updateWater(sim) {
    const { h, zg } = sim
    const vxA = sim.vx
    const vzA = sim.vz
    const g = this.waterGeo
    const pos = g.attributes.position.array
    const aw = g.attributes.aWater.array
    const V = GRID + 1
    const ct = this.city.cellType
    const wet = this.wetVert
    const vh = this.vh
    for (let vj = 0; vj < V; vj++)
      for (let vi = 0; vi < V; vi++) {
        let s = 0
        let n = 0
        let flood = 0
        let fx = 0
        let fz = 0
        for (let dj = -1; dj <= 0; dj++)
          for (let di = -1; di <= 0; di++) {
            const i = vi + di
            const j = vj + dj
            if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
            const k = j * GRID + i
            if (h[k] > 0.03) {
              s += zg[k] + h[k]
              n++
              if (ct[k] !== CELL_RIVER) flood++
              if (vxA) {
                fx += vxA[k]
                fz += vzA[k]
              }
            }
          }
        const v = vj * V + vi
        vh[v] = this.vertexHeight(vi, vj)
        if (n) {
          wet[v] = 1
          const y = s / n
          pos[v * 3 + 1] = y
          aw[v * 4] = Math.max(0, y - vh[v])
          aw[v * 4 + 1] = flood / n
          aw[v * 4 + 2] = fx / n
          aw[v * 4 + 3] = fz / n
        } else wet[v] = 0
      }
    // dry vertices next to water take the neighbouring water level so the
    // surface meets the terrain flat instead of sloping into the ground
    for (let vj = 0; vj < V; vj++)
      for (let vi = 0; vi < V; vi++) {
        const v = vj * V + vi
        if (wet[v]) continue
        let y = -Infinity
        if (vi > 0 && wet[v - 1]) y = Math.max(y, pos[(v - 1) * 3 + 1])
        if (vi < V - 1 && wet[v + 1]) y = Math.max(y, pos[(v + 1) * 3 + 1])
        if (vj > 0 && wet[v - V]) y = Math.max(y, pos[(v - V) * 3 + 1])
        if (vj < V - 1 && wet[v + V]) y = Math.max(y, pos[(v + V) * 3 + 1])
        pos[v * 3 + 1] = y > -Infinity ? y : vh[v] - 2
        aw[v * 4] = y > -Infinity ? Math.max(0, y - vh[v]) * 0.5 : 0
        aw[v * 4 + 1] = 1
        aw[v * 4 + 2] = 0
        aw[v * 4 + 3] = 0
      }
    g.attributes.position.needsUpdate = true
    g.attributes.aWater.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
    // outer river level follows the edge rows
    for (const [m, j] of [
      [this.outerRivers[0], 0],
      [this.outerRivers[1], GRID - 1],
    ]) {
      let s = 0
      let n = 0
      for (let i = 0; i < GRID; i++) {
        const k = j * GRID + i
        if (ct[k] === CELL_RIVER && h[k] > 0.05) {
          s += zg[k] + h[k]
          n++
        }
      }
      if (n) m.position.y = s / n
    }
  }

  buildTrees() {
    const { city } = this
    const trees = city.trees.filter((t) => city.buildingAt[idx(t.i, t.j)] < 0 && city.cellType[idx(t.i, t.j)] !== CELL_ROAD && city.cellType[idx(t.i, t.j)] !== CELL_POND && city.levee[idx(t.i, t.j)] === 0)
    if (this.treeGroup) {
      this.root.remove(this.treeGroup)
      this.treeGroup.traverse((o) => o.geometry?.dispose())
    }
    const group = new THREE.Group()
    const n = trees.length
    const crownGeo = new THREE.IcosahedronGeometry(1, 1)
    const coneGeo = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0)
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 1, 5).translate(0, 0.5, 0)
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), Math.max(1, n))
    const cones = new THREE.InstancedMesh(coneGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }), Math.max(1, n))
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 }), Math.max(1, n))
    let ci = 0
    let ki = 0
    trees.forEach((t, q) => {
      const x = cellToWorld(t.i) + t.ox
      const z = cellToWorld(t.j) + t.oz
      const y = this.groundAt(x, z)
      const s = t.s
      _m.makeScale(s, 3 * s, s).setPosition(x, y, z)
      trunks.setMatrixAt(q, _m)
      _c.setHSL(0.27 + (t.ox % 0.05), 0.45, 0.22 + (t.s - 0.7) * 0.12)
      if (t.kind === 1) {
        _m.makeScale(3 * s, 8 * s, 3 * s).setPosition(x, y + 2 * s, z)
        cones.setMatrixAt(ki, _m)
        cones.setColorAt(ki++, _c.offsetHSL(0.03, 0, -0.04))
      } else {
        _m.makeScale(3.4 * s, 3.2 * s, 3.4 * s).setPosition(x, y + 5 * s, z)
        crowns.setMatrixAt(ci, _m)
        crowns.setColorAt(ci++, _c)
      }
    })
    crowns.count = ci
    cones.count = ki
    trunks.count = n
    for (const m of [crowns, cones, trunks]) {
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
    }
    this.treeGroup = group
    this.root.add(group)
  }

  // ------------------------------------------------------------- buildings
  rebuildBuildings() {
    const { city } = this
    for (const m of [this.bMesh, this.roofMesh, this.unitMesh]) {
      if (!m) continue
      this.root.remove(m)
      m.geometry.dispose()
      m.material.dispose()
      this.envMaterials.delete(m.material)
    }
    for (const s of this.iconSprites || []) this.root.remove(s)
    const list = city.buildings.filter((b) => !b.removed)
    this.bList = list
    this.bIndex = new Map(list.map((b, i) => [b.id, i]))
    const n = Math.max(1, list.length)
    // vertical segments let tall buildings bend while they sway
    const geo = new THREE.BoxGeometry(1, 1, 1, 1, 10, 1).translate(0, 0.5, 0)
    const info = new Float32Array(n * 4)
    list.forEach((b, i) => {
      const T = BUILDING_TYPES[b.type]
      info.set([b.floorH, T.windows, Math.floor(b.seed * 997), 1], i * 4)
    })
    this.bInfo = new THREE.InstancedBufferAttribute(info, 4)
    this.bSway = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.bSway.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aInfo', this.bInfo)
    geo.setAttribute('aSway', this.bSway)
    const mat = this.trackEnv(makeBuildingMaterial({ uNight: this.uNight, envMap: this.sky.texture }))
    const mesh = new THREE.InstancedMesh(geo, mat, n)
    mesh.customDepthMaterial = makeSwayDepthMaterial()
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.count = list.length
    this.bMesh = mesh
    this.root.add(mesh)

    const houses = list.filter((b) => b.type === 'house')
    this.roofList = houses
    this.roofIndex = new Map(houses.map((b, i) => [b.id, i]))
    this.roofMesh = new THREE.InstancedMesh(gableGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.85 }), Math.max(1, houses.length))
    this.roofMesh.count = houses.length
    this.roofMesh.castShadow = true
    this.roofMesh.receiveShadow = true
    houses.forEach((b, i) => this.roofMesh.setColorAt(i, _c.set(b.roofColor)))
    this.root.add(this.roofMesh)

    const units = list.filter((b) => b.floors >= 4)
    this.unitList = units
    this.unitIndex = new Map(units.map((b, i) => [b.id, i]))
    this.unitMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x8c9196, roughness: 0.7 }), Math.max(1, units.length))
    this.unitMesh.count = units.length
    this.unitMesh.castShadow = true
    this.root.add(this.unitMesh)

    this.iconSprites = []
    for (const b of list) {
      const tex = this.icons[b.type]
      if (!tex) continue
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }))
      s.scale.set(16, 16, 1)
      s.position.set(b.cx, b.base + b.elevated + b.height + 14, b.cz)
      s.userData.bid = b.id
      this.iconSprites.push(s)
      this.root.add(s)
    }
    this.updateAllBuildings()
    this.refreshColors()
  }

  /** Instance matrix for a building, including tilt and topple rotation. */
  composeBuilding(b, out) {
    const a = this.anim.get(b.id)
    let fw = b.fw
    let fd = b.fd
    let H = b.height
    let tx = 0
    let tz = 0
    if (a) {
      H *= a.hScale
      fw *= a.spread
      fd *= a.spread
      tx = a.tiltX
      tz = a.tiltZ
    }
    out.set(fw, 0, 0, 0, 0, H, 0, 0, 0, 0, fd, 0, 0, 0, 0, 1)
    if (tx || tz) out.premultiply(_r.makeRotationFromEuler(_e.set(tx, 0, tz)))
    out.elements[12] = b.cx
    out.elements[13] = b.base + b.elevated
    out.elements[14] = b.cz
    if (a?.topple) {
      const T = a.topple
      _t.makeTranslation(-T.px, -T.py, -T.pz)
      out.premultiply(_t)
      out.premultiply(_r.makeRotationAxis(_a.set(T.ax, 0, T.az), T.theta))
      out.premultiply(_t.makeTranslation(T.px, T.py, T.pz))
    }
    return { H, tx, tz }
  }

  updateBuilding(b) {
    const i = this.bIndex.get(b.id)
    if (i === undefined) return
    const r = this.composeBuilding(b, _m)
    this.bMesh.setMatrixAt(i, _m)
    const a = this.anim.get(b.id)
    const sx = a && !a.rubble ? a.ux * a.vis : 0
    const sz = a && !a.rubble ? a.uz * a.vis : 0
    this.bSway.setXYZ(i, sx, sz, a && !a.rubble ? a.sink || 0 : 0)
    const gone = a && (a.hScale < 0.5 || a.topple || a.partial)
    const top = b.base + b.elevated + r.H
    const ri = this.roofIndex.get(b.id) ?? -1
    if (ri >= 0) {
      const along = b.fw >= b.fd
      const rh = Math.min(b.fw, b.fd) * 0.32
      if (gone) _m.makeScale(0, 0, 0)
      else {
        _m.makeScale((along ? b.fw : b.fd) * 1.08, rh, (along ? b.fd : b.fw) * 1.1)
        if (!along) _m.premultiply(_r.makeRotationY(Math.PI / 2))
        if (r.tx || r.tz) _m.premultiply(_r.makeRotationFromEuler(_e.set(r.tx, 0, r.tz)))
        _v.set(0, r.H, 0)
        if (r.tx || r.tz) _v.applyEuler(_e.set(r.tx, 0, r.tz))
        _m.setPosition(b.cx + _v.x + sx, b.base + b.elevated + _v.y, b.cz + _v.z + sz)
      }
      this.roofMesh.setMatrixAt(ri, _m)
      this.roofMesh.instanceMatrix.needsUpdate = true
    }
    const ui = this.unitIndex.get(b.id) ?? -1
    if (ui >= 0) {
      if (gone) _m.makeScale(0, 0, 0)
      else {
        const s = (b.seed * 0.2 + 0.25) * Math.min(b.fw, b.fd)
        _m.makeScale(s, 2.6, s * 1.3)
        _m.setPosition(b.cx + sx + (b.seed - 0.5) * b.fw * 0.3, top, b.cz + sz)
      }
      this.unitMesh.setMatrixAt(ui, _m)
      this.unitMesh.instanceMatrix.needsUpdate = true
    }
    this.bMesh.instanceMatrix.needsUpdate = true
    this.bSway.needsUpdate = true
  }

  updateAllBuildings() {
    for (const b of this.bList) this.updateBuilding(b)
    this.bMesh.computeBoundingSphere()
  }

  setColorFn(fn) {
    this.colorFn = fn
    this.refreshColors()
  }

  refreshColors() {
    if (!this.bList) return
    const info = this.bInfo.array
    this.bList.forEach((b, i) => {
      const c = this.colorFn ? this.colorFn(b) : null
      const a = this.anim.get(b.id)
      _c.set(c ?? b.color)
      if (!c && a) {
        if (a.burnt) _c.lerp(new THREE.Color(0x1d1a18), 0.85)
        else if (a.burning) _c.lerp(new THREE.Color(0x2a2522), Math.min(0.7, a.burning))
        else if (a.rubble) _c.lerp(new THREE.Color(0x5e574e), 0.65)
        else if (a.ds) _c.lerp(new THREE.Color(0x6a5d50), a.ds * 0.12)
        if (a.wet) _c.lerp(new THREE.Color(0x5a4a33), Math.min(0.55, a.wet))
      }
      this.bMesh.setColorAt(i, _c)
      info[i * 4 + 3] = a && (a.rubble || a.burnt || a.ds >= 3 || a.dark || a.partial) ? 0 : 1
    })
    if (this.bMesh.instanceColor) this.bMesh.instanceColor.needsUpdate = true
    this.bInfo.needsUpdate = true
  }

  /** Levees, pumps, bridges and elevated-building plinths. */
  rebuildStatic() {
    const { city } = this
    if (this.staticMesh) {
      this.root.remove(this.staticMesh)
      this.staticMesh.geometry.dispose()
      this.staticMesh.material.dispose()
    }
    const items = []
    for (let k = 0; k < GRID * GRID; k++) {
      const i = k % GRID
      const j = Math.floor(k / GRID)
      if (city.levee[k] > 0) {
        items.push({ x: cellToWorld(i), z: cellToWorld(j), y: city.z[k] - 0.5, sx: CELL, sz: CELL, sy: city.levee[k] + 0.5, c: 0x8a8273 })
      }
    }
    // bridges: an arched deck from road to road, railings, piers and abutments
    for (const sp of city.bridgeSpans || []) {
      const x0 = cellToWorld(sp.i0) + CELL * 0.35
      const x1 = cellToWorld(sp.i1) - CELL * 0.35
      const z = cellToWorld(sp.j)
      const segs = Math.max(4, Math.round((x1 - x0) / 4))
      for (let q = 0; q < segs; q++) {
        const xa = x0 + ((x1 - x0) * q) / segs
        const xb = x0 + ((x1 - x0) * (q + 1)) / segs
        const ya = this.deckAt(xa, z)
        const yb = this.deckAt(xb, z)
        const len = Math.hypot(xb - xa, yb - ya) + 0.05
        const rz = Math.atan2(yb - ya, xb - xa)
        const xm = (xa + xb) / 2
        const ym = (ya + yb) / 2
        items.push({ x: xm, z, y: ym - 1.3, sx: len, sz: CELL * 0.98, sy: 1.3, c: 0x8a867c, rz })
        items.push({ x: xm, z, y: ym - 0.02, sx: len, sz: CELL * 0.86, sy: 0.06, c: 0x3d3f43, rz })
        items.push({ x: xm, z: z - CELL * 0.46, y: ym, sx: len, sz: 0.35, sy: 1.0, c: 0xb4b0a6, rz })
        items.push({ x: xm, z: z + CELL * 0.46, y: ym, sx: len, sz: 0.35, sy: 1.0, c: 0xb4b0a6, rz })
      }
      // piers stand in the channel every ~20 m
      for (let x = x0 + 12; x < x1 - 8; x += 20) {
        const k = idx(Math.floor((x + HALF) / CELL), sp.j)
        if (city.cellType[k] !== CELL_RIVER) continue
        const top = this.deckAt(x, z) - 1.3
        items.push({ x, z, y: city.z[k] - 1, sx: 2.4, sz: CELL * 0.75, sy: top - city.z[k] + 1, c: 0x6b675f })
      }
      // abutments where the deck meets the embankment
      for (const xe of [x0, x1]) {
        const top = this.deckAt(xe, z) - 1.3
        const bottom = this.groundAt(xe + (xe === x0 ? 6 : -6), z) - 1
        items.push({ x: xe + (xe === x0 ? 2 : -2), z, y: bottom, sx: 4, sz: CELL, sy: Math.max(0.5, top - bottom), c: 0x6f6a60 })
      }
    }
    for (const p of city.pumps) {
      const x = cellToWorld(p.i)
      const z = cellToWorld(p.j)
      const y = city.z[idx(p.i, p.j)] - 0.2
      items.push({ x, z, y, sx: 7, sz: 6, sy: 4.5, c: p.failed ? 0xb24a3a : 0x3f6e9a })
      items.push({ x: x + 2, z, y: y + 4.5, sx: 1.2, sz: 1.2, sy: 3, c: 0x6d7880 })
    }
    for (const b of city.buildings) {
      if (b.removed || !b.elevated) continue
      items.push({ x: b.cx, z: b.cz, y: b.base, sx: b.fw + 1.2, sz: b.fd + 1.2, sy: b.elevated, c: 0x9b978c })
    }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.85 }), Math.max(1, items.length))
    mesh.count = items.length
    items.forEach((it, q) => {
      _m.makeScale(it.sx, it.sy, it.sz)
      if (it.rz) _m.premultiply(_r.makeRotationZ(it.rz))
      _m.setPosition(it.x, it.y, it.z)
      mesh.setMatrixAt(q, _m)
      mesh.setColorAt(q, _c.set(it.c))
    })
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.staticMesh = mesh
    this.root.add(mesh)
    this.buildRoadClosures()
  }

  /** Road surface height on a bridge (gentle arch between the two road ends). */
  deckAt(x, z) {
    const j = Math.floor((z + HALF) / CELL)
    const sp = this.city?.bridgeSpans?.find((s) => s.j === j)
    if (!sp) return null
    const x0 = cellToWorld(sp.i0)
    const x1 = cellToWorld(sp.i1)
    const t = clamp((x - x0) / (x1 - x0), 0, 1)
    return lerp(sp.h0, sp.h1, t) + 0.12 + Math.sin(t * Math.PI) * Math.min(1.5, (x1 - x0) * 0.012)
  }

  /** Barricades and "ROAD CLOSED" signs where a road runs into the river. */
  buildRoadClosures() {
    const { city } = this
    for (const m of [this.closureMesh, this.signMesh]) {
      if (!m) continue
      this.root.remove(m)
      m.geometry.dispose()
    }
    const isRoad = (i, j) => i >= 0 && j >= 0 && i < GRID && j < GRID && (city.cellType[idx(i, j)] === CELL_ROAD || city.bridge[idx(i, j)])
    const spots = []
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        if (city.cellType[idx(i, j)] !== CELL_ROAD || city.bridge[idx(i, j)]) continue
        for (let d = 0; d < 4; d++) {
          const dx = [1, 0, -1, 0][d]
          const dz = [0, 1, 0, -1][d]
          const ii = i + dx
          const jj = j + dz
          if (ii < 0 || jj < 0 || ii >= GRID || jj >= GRID) continue
          const t = city.cellType[idx(ii, jj)]
          if ((t === CELL_BANK || t === CELL_RIVER) && !city.bridge[idx(ii, jj)] && isRoad(i - dx, j - dz)) spots.push({ i, j, dx, dz })
        }
      }
    if (!this.signTex) {
      const c = document.createElement('canvas')
      c.width = 256
      c.height = 128
      const g = c.getContext('2d')
      g.fillStyle = '#fff'
      g.fillRect(0, 0, 256, 128)
      g.fillStyle = '#c62828'
      g.fillRect(6, 6, 244, 116)
      g.fillStyle = '#fff'
      g.font = 'bold 46px system-ui, sans-serif'
      g.textAlign = 'center'
      g.fillText('ROAD', 128, 56)
      g.fillText('CLOSED', 128, 106)
      this.signTex = new THREE.CanvasTexture(c)
      this.signTex.colorSpace = THREE.SRGBColorSpace
    }
    const parts = []
    for (const s of spots) {
      const cx = cellToWorld(s.i) + s.dx * 3.6
      const cz = cellToWorld(s.j) + s.dz * 3.6
      const y = this.groundAt(cx, cz)
      // posts and a red/white striped rail across the road
      for (const off of [-3.4, 3.4]) parts.push({ x: cx + (s.dx ? 0 : off), z: cz + (s.dx ? off : 0), y, sx: 0.15, sy: 1.2, sz: 0.15, c: 0x333333 })
      for (let q = 0; q < 7; q++) {
        const off = -3.15 + q * 1.05
        parts.push({ x: cx + (s.dx ? 0 : off), z: cz + (s.dx ? off : 0), y: y + 0.75, sx: s.dx ? 0.12 : 1.05, sy: 0.35, sz: s.dx ? 1.05 : 0.12, c: q % 2 ? 0xf5f5f5 : 0xd32f2f })
      }
      parts.push({ x: cx - s.dx * 0.6, z: cz - s.dz * 0.6, y, sx: 0.1, sy: 1.6, sz: 0.1, c: 0x555555 })
      s.sign = { x: cx - s.dx * 0.62, z: cz - s.dz * 0.62, y: y + 2.0, ry: Math.atan2(-s.dx, -s.dz) }
    }
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.6 }), Math.max(1, parts.length))
    parts.forEach((p, q) => {
      _m.makeScale(p.sx, p.sy, p.sz).setPosition(p.x, p.y, p.z)
      mesh.setMatrixAt(q, _m)
      mesh.setColorAt(q, _c.set(p.c))
    })
    mesh.count = parts.length
    mesh.castShadow = true
    const signs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshStandardMaterial({ map: this.signTex, roughness: 0.5, side: THREE.DoubleSide, emissive: 0x330000 }), Math.max(1, spots.length))
    spots.forEach((sp, q) => {
      _m.makeRotationY(sp.sign.ry).setPosition(sp.sign.x, sp.sign.y, sp.sign.z)
      signs.setMatrixAt(q, _m)
    })
    signs.count = spots.length
    this.closureMesh = mesh
    this.signMesh = signs
    this.root.add(mesh, signs)
  }

  // ---------------------------------------------------------- interaction
  pick(clientX, clientY) {
    if (!this.terrain) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    let building = null
    const hb = this.raycaster.intersectObject(this.bMesh, false)[0]
    if (hb && hb.instanceId !== undefined) building = this.bList[hb.instanceId]
    const ht = this.raycaster.intersectObject(this.terrain, false)[0]
    const pt = hb?.point ?? ht?.point
    if (!pt) return null
    const tp = ht?.point ?? pt
    const i = clamp(Math.floor((tp.x + HALF) / CELL), 0, GRID - 1)
    const j = clamp(Math.floor((tp.z + HALF) / CELL), 0, GRID - 1)
    return { i, j, building, point: pt }
  }

  setHighlight(spec) {
    if (!spec) {
      this.highlight.visible = false
      return
    }
    const { x, y, w, d, h = 4, color = 0x4ade80, base } = spec
    this.highlight.visible = true
    this.highlight.material.color.set(color)
    const cx = cellToWorld(x) + ((w - 1) * CELL) / 2
    const cz = cellToWorld(y) + ((d - 1) * CELL) / 2
    let zb = base
    if (zb === undefined) {
      zb = Infinity
      for (let j = y; j < y + d; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < GRID && j < GRID) zb = Math.min(zb, this.city.z[idx(i, j)])
    }
    this.highlight.scale.set(w * CELL, h, d * CELL)
    this.highlight.position.set(cx, zb, cz)
  }

  focus(x, z, dist = 700) {
    this.controls.target.set(x, this.groundAt(x, z) + 5, z)
    const dir = new THREE.Vector3(-0.55, 0.62, 0.56).normalize()
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist)
    this.controls.update()
  }

  // -------------------------------------------------------------- shaking
  /** Queue ground shaking. pga in g, realDur in seconds of real time. */
  addShake(pga, realDur, M, main = false) {
    // in cut-away view the shaking starts when the S-waves reach the city
    const lag = this.subsurface.group.visible ? this.subsurface.trigger(M, main) : 0
    const freqs = []
    const lowF = clamp(1.4 - (M - 5) * 0.25, 0.25, 1.4)
    for (let k = 0; k < 5; k++) freqs.push({ f: lowF * (1 + k * 0.8 + Math.random() * 0.5), px: Math.random() * 6.28, pz: Math.random() * 6.28, w: 1 })
    // great earthquakes radiate strong long-period waves that make tall towers resonate
    if (M >= 7.3) freqs.push({ f: 0.14 + Math.random() * 0.12, px: Math.random() * 6.28, pz: Math.random() * 6.28, w: 1.5 + (M - 7.3) })
    this.shakes.push({ t0: this.realTime + lag, dur: realDur, pga, freqs })
    return lag
  }

  groundAccel(t) {
    let ax = 0
    let az = 0
    let env = 0
    for (const s of this.shakes) {
      const tau = t - s.t0
      if (tau < 0 || tau > s.dur) continue
      const rise = Math.min(1.5, s.dur * 0.2)
      const e = tau < rise ? (tau / rise) ** 2 : Math.exp((-3 * (tau - rise)) / (s.dur - rise))
      let sx = 0
      let sz = 0
      for (const f of s.freqs) {
        sx += Math.sin(6.283 * f.f * tau + f.px) * f.w
        sz += Math.sin(6.283 * f.f * tau + f.pz) * f.w
      }
      const amp = s.pga * 9.81 * e * 0.45
      ax += sx * amp
      az += sz * amp
      env = Math.max(env, s.pga * e)
    }
    return { ax, az, env }
  }

  animFor(b) {
    let a = this.anim.get(b.id)
    if (!a) {
      // fundamental period ≈ 0.1 s per storey; tall towers sway slowly and far
      const T = clamp(0.1 * b.floors, 0.15, 6)
      a = { ux: 0, uz: 0, vx: 0, vz: 0, w: (2 * Math.PI) / T, vis: b.floors >= 15 ? 4 : 3, hScale: 1, spread: 1, tiltX: 0, tiltZ: 0, ds: 0, active: false }
      this.anim.set(b.id, a)
    }
    return a
  }

  /** Start a collapse after `delay` seconds of real time. */
  collapse(b, delay = 0, style = 'quake') {
    const a = this.animFor(b)
    if (a.collapse || a.rubble) return
    // Ductile modern frames sway hard and then come down vertically
    // (progressive collapse). Whole-building overturning needs a weak base:
    // liquefied soil (Niigata 1964) or a brittle older frame (Taiwan 2016).
    let kind = 'pancake'
    let wait = 0
    if (style === 'quake') {
      const r = Math.random()
      const modern = ['rc_high', 'steel', 'isolated', 'rc_mod'].includes(b.construction)
      const soft = this.city.soil[idx(b.x + Math.floor(b.w / 2), b.y + Math.floor(b.d / 2))] === 2
      const brittle = ['urm', 'rc_low', 'wood_old'].includes(b.construction)
      if (b.floors >= 5 && (soft || (brittle && b.floors >= 6)) && r < (soft ? 0.55 : 0.35)) kind = 'topple'
      else if (b.floors >= 5 && r < 0.3) kind = 'partial'
      if (modern) wait = 1.5 + Math.random() * 2
    }
    const ang = Math.random() * Math.PI * 2
    // free-fall-like progressive collapse: ~0.65 g net downward acceleration
    const fall = Math.sqrt((2 * b.height) / (0.65 * 9.81))
    a.collapse = {
      t0: this.realTime + delay + wait,
      dur: (style === 'flood' ? 1.5 : 1) * (fall + 0.6),
      dirX: Math.cos(ang),
      dirZ: Math.sin(ang),
      spawned: 0,
      style,
      kind,
      started: false,
    }
    a.active = true
  }

  setDamage(b, ds) {
    const a = this.animFor(b)
    a.ds = Math.max(a.ds, ds)
    if (ds >= 3 && !a.collapse && !a.tiltSet) {
      a.tiltSet = true
      a.tiltX = (Math.random() - 0.5) * 0.04 * (ds - 2)
      a.tiltZ = (Math.random() - 0.5) * 0.04 * (ds - 2)
      a.active = true
    }
  }

  becomeRubble(b, a) {
    a.rubble = true
    a.topple = null
    a.partial = false
    a.hScale = clamp(clamp(b.height * 0.1, 2.5, 8) / b.height, 0.05, 0.6)
    a.spread = 1.15
    a.ux = a.uz = a.vx = a.vz = 0
    this.updateBuilding(b)
    this.debris.wakeAll()
    this.life.blockAround(b)
    this.rubbleDirty = true
  }

  stepCollapse(b, a, t) {
    const c = a.collapse
    if (!c.started) {
      c.started = true
      if (c.kind === 'topple') {
        // rigid rotation about the base edge, like a falling column
        a.topple = {
          theta: 0.06,
          omega: 0.12,
          ax: c.dirZ,
          az: -c.dirX,
          px: b.cx + (c.dirX * b.fw) / 2,
          py: b.base + b.elevated,
          pz: b.cz + (c.dirZ * b.fd) / 2,
        }
      } else if (c.kind === 'partial') {
        // upper storeys shear off and fall as one block
        const f = 0.3 + Math.random() * 0.25
        const H = b.height
        a.partial = true
        a.hScale = 1 - f
        const v = 1.5 + Math.random() * 2.5
        this.debris.spawn(b.cx, b.base + b.elevated + H * (1 - f) + (H * f) / 2 + 0.3, b.cz, c.dirX * v, 0.5, c.dirZ * v, 0, b.color, {
          dims: [b.fw * 0.98, H * f, b.fd * 0.98],
          fragile: true,
          src: b.id,
        })
        for (let q = 0; q < 30; q++) this.spawnDust(b, 1, b.base + H * (1 - f))
        this.rubbleDirty = true
      }
    }
    if (c.kind === 'topple') {
      const T = a.topple
      const dt = Math.min(0.05, this.frameDt)
      const H = b.height
      for (let s = 0; s < 3; s++) {
        T.omega += ((3 * 9.81) / (2 * H)) * Math.sin(T.theta) * (dt / 3)
        T.theta += T.omega * (dt / 3)
      }
      if (Math.random() < 0.4) this.spawnDust(b, 0.7)
      // the leading face sweeps through the air; stop at the first contact
      const st = Math.sin(T.theta)
      const ct = Math.cos(T.theta)
      // sample the whole leading face: along its height and across its width
      const px = -c.dirZ
      const pz = c.dirX
      const halfW = 0.48 * (Math.abs(px) * b.fw + Math.abs(pz) * b.fd)
      contact: for (let f = 0.15; f <= 1.0001; f += 0.085) {
        for (const lat of [-halfW, -halfW / 2, 0, halfW / 2, halfW]) {
          const qx = T.px + c.dirX * st * H * f + px * lat
          const qz = T.pz + c.dirZ * st * H * f + pz * lat
          const qy = T.py + ct * H * f
          const surf = this.surfaceAt(qx, qz, b.id)
          if (qy <= surf.y + 0.3 || T.theta > 1.5) {
            this.breakTopple(b, a, surf.bid)
            break contact
          }
        }
      }
      return true
    }
    if (c.kind === 'partial') {
      // the stub that remains slumps after a moment
      if (t - c.t0 > 2.5 && Math.random() < 0.4) {
        c.kind = 'pancake'
        c.t0 = t
        c.h0 = a.hScale
      }
      return true
    }
    // pancake: storeys crush down onto each other
    const p = clamp((t - c.t0) / c.dur, 0, 1)
    const e = p * p
    const h0 = c.h0 ?? 1
    const rub = clamp(clamp(b.height * 0.1, 2.5, 8) / b.height, 0.05, 0.6)
    a.hScale = h0 - (h0 - rub) * e
    a.sink = (1 - a.hScale) * b.height
    a.spread = 1 + 0.12 * e
    a.tiltX = c.dirX * 0.04 * e
    a.tiltZ = c.dirZ * 0.04 * e
    const target = Math.min(140, Math.round(b.area / 120) + 15)
    const want = Math.floor(target * Math.min(1, p * 1.3))
    for (; c.spawned < want; c.spawned++) this.spawnDebris(b, Math.min(a.hScale, 0.25))
    // dust and debris burst out of the crush zone at street level
    const k = c.style === 'flood' ? 0.3 : 1
    for (let q = 0; q < (p > 0.02 ? 3 : 0); q++) this.spawnDust(b, k * 1.2, b.base + Math.random() * 3)
    if (p >= 1) {
      this.becomeRubble(b, a)
      for (let q = 0; q < 25; q++) this.spawnDust(b, c.style === 'flood' ? 0.3 : 1.5)
    }
    return true
  }

  /** A toppling building hits the ground or a neighbour and breaks apart; pieces keep their momentum. */
  breakTopple(b, a, hitBid = -1) {
    const T = a.topple
    const H = b.height
    // rotational kinetic energy of a rigid column: ½·(⅓·m·H²)·ω²
    const mass = b.area * 800
    const ke = 0.5 * ((mass * H * H) / 3) * T.omega * T.omega
    if (hitBid >= 0) this.onImpact?.(hitBid, ke * 0.6)
    // anyone under the falling building
    const c = a.collapse
    for (let f = 0.2; f <= 1.0001; f += 0.1) {
      const hit = this.life.hitArea(T.px + c.dirX * Math.sin(T.theta) * H * f, T.pz + c.dirZ * Math.sin(T.theta) * H * f, Math.max(b.fw, b.fd) * 0.5, ke)
      if (hit.killed || hit.crushed) this.onStreetHit?.(hit)
    }
    this.composeBuilding(b, _m)
    const n = Math.min(180, Math.round(b.area / 90) + 30)
    const axis = _a.set(T.ax, 0, T.az).normalize()
    for (let q = 0; q < n; q++) {
      // a random point inside the (rotated) building volume
      _v.set(Math.random() - 0.5, Math.random() * 0.98 + 0.02, Math.random() - 0.5).applyMatrix4(_m)
      const rx = _v.x - T.px
      const ry = _v.y - T.py
      const rz = _v.z - T.pz
      // v = ω × r
      const vx = T.omega * (axis.y * rz - axis.z * ry)
      const vy = T.omega * (axis.z * rx - axis.x * rz)
      const vz = T.omega * (axis.x * ry - axis.y * rx)
      const size = clamp(Math.sqrt(b.fw * b.fd) * (0.08 + Math.random() * 0.14), 1, 5.5)
      this.debris.spawn(_v.x, _v.y, _v.z, vx + (Math.random() - 0.5) * 3, vy + Math.random() * 2, vz + (Math.random() - 0.5) * 3, size, Math.random() < 0.3 ? 0x56524c : b.color, { src: b.id })
    }
    for (let q = 0; q < 50; q++) this.spawnDust(b, 1.8)
    this.becomeRubble(b, a)
  }

  /** Falling debris landed on something. */
  debrisLanded(it, v, bid) {
    const mass = it.sx * it.sy * it.sz * 900
    const E = 0.5 * mass * v * v
    if (bid >= 0 && bid !== it.src) {
      const acc = (this.impactAcc.get(bid) || 0) + E
      if (acc > 1.5e5) {
        this.impactAcc.set(bid, 0)
        this.onImpact?.(bid, acc)
      } else this.impactAcc.set(bid, acc)
    }
    const hit = this.life.hitArea(it.x, it.z, Math.max(it.sx, it.sz) * 0.5, E)
    if (hit.killed || hit.crushed) this.onStreetHit?.(hit)
    if (E > 2e6) for (let q = 0; q < 6; q++) this.dust.emit(it.x + (Math.random() - 0.5) * it.sx, it.y, it.z + (Math.random() - 0.5) * it.sz, (Math.random() - 0.5) * 6, 1.5, (Math.random() - 0.5) * 6, 10, 7, 6, [0.62, 0.57, 0.5, 0.55], [0.7, 0.66, 0.6, 0])
  }

  /** A falling block broke apart on impact. */
  shatter(it) {
    const n = clamp(Math.round((it.sx * it.sy * it.sz) / 25), 15, 90)
    for (let q = 0; q < n; q++) {
      const x = it.x + (Math.random() - 0.5) * it.sx
      const y = it.y + (Math.random() - 0.5) * it.sy * 0.6
      const z = it.z + (Math.random() - 0.5) * it.sz
      const size = clamp(Math.cbrt((it.sx * it.sy * it.sz) / n) * (0.6 + Math.random() * 0.8), 0.6, 5)
      this.debris.spawn(x, y, z, it.vx * 0.3 + (Math.random() - 0.5) * 8, Math.random() * 4, it.vz * 0.3 + (Math.random() - 0.5) * 8, size, Math.random() < 0.3 ? 0x56524c : it.color, { src: it.src })
    }
    for (let q = 0; q < 30; q++) {
      const v = 4 + Math.random() * 6
      const ang = Math.random() * Math.PI * 2
      this.dust.emit(it.x + (Math.random() - 0.5) * it.sx, it.y, it.z + (Math.random() - 0.5) * it.sz, Math.cos(ang) * v, 1 + Math.random() * 2, Math.sin(ang) * v, 12, 8, 7 + Math.random() * 5, [0.62, 0.57, 0.5, 0.6], [0.7, 0.66, 0.6, 0])
    }
  }

  /** Cladding, glass and masonry shaken loose from tall buildings. */
  shedFacade(b, a, env, dt) {
    if (b.floors < 7 || a.rubble || a.topple) return
    const rate = env * (b.floors / 8) * (1 + a.ds * 0.8) * 1.4
    let n = rate * dt
    while (n > 0) {
      if (Math.random() > n) break
      n -= 1
      const face = Math.floor(Math.random() * 4)
      const nx = face === 0 ? 1 : face === 1 ? -1 : 0
      const nz = face === 2 ? 1 : face === 3 ? -1 : 0
      const along = Math.random() - 0.5
      const x = b.cx + (nx ? (nx * b.fw) / 2 : along * b.fw) + nx * 0.6
      const z = b.cz + (nz ? (nz * b.fd) / 2 : along * b.fd) + nz * 0.6
      const h = b.height * (0.35 + Math.random() * 0.6)
      const y = b.base + b.elevated + h
      const out = 1 + Math.random() * 3
      const glass = BUILDING_TYPES[b.type].windows >= 2 && Math.random() < 0.6
      const size = glass ? 0.4 + Math.random() * 0.5 : 0.5 + Math.random() * 1.1
      this.debris.spawn(x + a.ux * a.vis, y, z + a.uz * a.vis, nx * out + a.vx, 0, nz * out + a.vz, size, glass ? 0x9fc0d4 : b.color, { src: b.id })
    }
  }

  setEnvironment({ hour = 12, rain = 0, haze = 0 }) {
    const h = ((hour % 24) + 24) % 24
    const elev = Math.sin(((h - 6) / 12) * Math.PI) // -1..1
    const az = ((h - 6) / 12) * Math.PI
    const dayF = clamp(elev * 2.2 + 0.25, 0, 1)
    const overcast = clamp(rain / 25, 0, 1)
    const night = clamp(1 - dayF * 1.3 + overcast * 0.35, 0, 1)
    this.nightF = night
    this.uNight.value = clamp(1 - dayF * 1.4, 0, 1) + overcast * 0.25
    const sunDir = new THREE.Vector3(Math.cos(az) * 0.8, Math.max(0.15, elev), 0.45 + Math.sin(az) * 0.2).normalize()
    this.sun.position.copy(sunDir).multiplyScalar(1600)
    const warm = clamp(1 - Math.abs(elev) * 3, 0, 1) * dayF
    const sunCol = new THREE.Color(0.6, 0.7, 1.0).lerp(new THREE.Color(1, 0.97, 0.92), dayF).lerp(new THREE.Color(1, 0.62, 0.35), warm)
    this.sun.color.copy(sunCol)
    // moonlight + a brighter exposure keep the night readable
    this.sun.intensity = lerp(0.9, 2.5, dayF) * (1 - overcast * 0.55)
    this.hemi.intensity = lerp(1.05, 1.0, dayF) * (1 - overcast * 0.15)
    this.hemi.color.set(0xdfeeff).lerp(new THREE.Color(0x9fb4e0), 1 - dayF)
    this.hemi.groundColor.set(0x4a5a3a).lerp(new THREE.Color(0x3a3530), 1 - dayF)
    this.renderer.toneMappingExposure = lerp(1.45, 1.05, dayF)
    const daySky = new THREE.Color(0x9cc1e3).lerp(new THREE.Color(0x7b8590), overcast)
    const nightSky = new THREE.Color(0x24324f)
    const sky = nightSky.clone().lerp(daySky, dayF).lerp(new THREE.Color(0xe7a072), warm * 0.4 * (1 - overcast))
    if (haze) sky.lerp(new THREE.Color(0x9c8d78), haze)
    this.scene.background = sky
    this.scene.fog.color.copy(sky)
    this.scene.fog.near = lerp(1400, 260, Math.max(overcast, haze * 0.8))
    this.scene.fog.far = lerp(5600, 1500, Math.max(overcast, haze * 0.6))
    this.rainIntensity = rain
    this.uRain.value = rain
    if (this.terrainMat) this.terrainMat.emissiveIntensity = night * 0.55
    if (this.roadMesh) {
      // wet asphalt turns glossy and mirrors the street lights
      const wet = clamp(rain / 8, 0, 1)
      this.roadMesh.material.emissiveIntensity = night * 0.5
      this.roadMesh.material.roughness = lerp(0.88, 0.22, wet)
      this.roadMesh.material.envMapIntensity = wet
      if (!this.roadMesh.material.envMap) this.trackEnv(this.roadMesh.material)
      this.walkMesh.material.emissiveIntensity = night * 0.45
      this.walkMesh.material.roughness = lerp(0.9, 0.45, wet)
    }
    // refresh reflections now and then as the sky changes
    if (this.realTime - this.lastEnvT > 1.5) {
      this.lastEnvT = this.realTime
      const top = new THREE.Color(0x3d6aa8).lerp(new THREE.Color(0x6b737c), overcast).lerp(new THREE.Color(0x0c1424), 1 - dayF)
      if (this.sky.update({ top, horizon: sky, ground: new THREE.Color(0x353a30).multiplyScalar(0.3 + dayF * 0.7), sunDir, sunCol: sunCol.clone().multiplyScalar(dayF * (1 - overcast)) })) {
        for (const m of this.envMaterials) m.envMap = this.sky.texture
      }
    }
  }

  setLifeContext(ctx) {
    this.lifeCtx = ctx
  }

  update(dt) {
    this.realTime += dt
    this.frameDt = dt
    this.uTime.value += dt
    this.controls.update()
    const t = this.realTime
    this.shakes = this.shakes.filter((s) => t - s.t0 < s.dur + 0.1)
    const g = this.groundAccel(t)

    // cut-away view: the whole block moves with the ground
    this.subsurface.update(dt)
    const movers = [this.root, this.life.group, this.debris.mesh]
    if (this.subsurface.group.visible && g.env > 0.002) {
      this.blockShake.set(clamp(g.ax * 0.05, -3, 3), 0, clamp(g.az * 0.05, -3, 3))
      for (const o of movers) o.position.copy(this.blockShake)
    } else if (this.blockShake.lengthSq()) {
      this.blockShake.set(0, 0, 0)
      for (const o of movers) o.position.set(0, 0, 0)
    }

    // camera shake
    this.camera.position.sub(this.camShake)
    this.camShake.set(0, 0, 0)
    if (g.env > 0.005) {
      const k = Math.min(3, g.env * 6)
      this.camShake.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k * 0.6, (Math.random() - 0.5) * k)
      this.camera.position.add(this.camShake)
    }

    // building response: damped single-degree-of-freedom oscillators + collapses
    if (this.bList && this.anim.size) {
      const shaking = g.env > 0.001
      const sub = 4
      const h = Math.min(dt, 0.05) / sub
      for (const b of this.bList) {
        const a = this.anim.get(b.id)
        if (!a) continue
        if (shaking) a.active = true
        if (!a.active) continue
        let moving = false
        if (!a.rubble && !a.topple) {
          for (let s = 0; s < sub; s++) {
            const w = a.w
            const axx = -g.ax - 2 * 0.05 * w * a.vx - w * w * a.ux
            const azz = -g.az - 2 * 0.05 * w * a.vz - w * w * a.uz
            a.vx += axx * h
            a.vz += azz * h
            a.ux += a.vx * h
            a.uz += a.vz * h
          }
          const lim = b.height * 0.012
          a.ux = clamp(a.ux, -lim, lim)
          a.uz = clamp(a.uz, -lim, lim)
          moving = Math.hypot(a.ux, a.uz) > 0.002 || Math.hypot(a.vx, a.vz) > 0.002
          if (shaking && g.env > 0.15) this.shedFacade(b, a, g.env, dt)
        }
        if (a.collapse && !a.rubble) {
          // stay awake until a scheduled collapse has run its course
          moving = true
          if (t >= a.collapse.t0) this.stepCollapse(b, a, t)
        }
        this.updateBuilding(b)
        if (!moving && !shaking) a.active = false
      }
    }
    if (this.rubbleDirty) {
      this.rubbleDirty = false
      this.refreshColors()
    }

    // fire & smoke from burning buildings
    if (this.burning && this.burning.length) {
      for (const b of this.burning) {
        const a = this.anim.get(b.id)
        const top = b.base + b.elevated + b.height * (a?.hScale ?? 1)
        const n = Math.min(6, 1 + Math.floor((b.fw * b.fd) / 150))
        for (let q = 0; q < n; q++) {
          const x = b.cx + (Math.random() - 0.5) * b.fw * 0.9
          const z = b.cz + (Math.random() - 0.5) * b.fd * 0.9
          const y = b.base + Math.random() * (top - b.base) * 0.9 + 1
          if (Math.random() < 0.8) this.fire.emit(x, y, z, 0, 4 + Math.random() * 5, 0, 5 + Math.random() * 5, -2, 0.7 + Math.random() * 0.6, [1, 0.55, 0.15, 0.9], [0.9, 0.2, 0.05, 0])
          if (Math.random() < 0.35) this.smoke.emit(x, top + 2, z, 0, 6 + Math.random() * 4, 0, 8, 9, 6 + Math.random() * 4, [0.15, 0.13, 0.12, 0.6], [0.3, 0.29, 0.28, 0])
        }
      }
    }
    this.life.update(dt, { ...this.lifeCtx, shaking: g.env, night: this.nightF })
    this.fire.update(dt)
    this.smoke.update(dt, 3)
    this.dust.update(dt, 1)
    this.debris.update(dt)
    // drops stop on roofs and streets; in cut-away view it only rains over the block
    this.rain.update(dt, this.rainIntensity || 0, this.controls.target, (x, z) => this.surfaceAt(x, z).y, this.subsurface.group.visible ? HALF - 2 : 0)
    this.renderer.render(this.scene, this.camera)
  }

  spawnDebris(b, hFrac) {
    const top = b.base + b.elevated + b.height * hFrac
    const x = b.cx + (Math.random() - 0.5) * b.fw
    const z = b.cz + (Math.random() - 0.5) * b.fd
    const y = b.base + Math.random() * (top - b.base)
    const out = 2 + Math.random() * 5
    const ang = Math.random() * Math.PI * 2
    const size = clamp(Math.sqrt(b.fw * b.fd) * (0.05 + Math.random() * 0.1), 0.6, 4)
    this.debris.spawn(x, y, z, Math.cos(ang) * out, Math.random() * 3, Math.sin(ang) * out, size, Math.random() < 0.3 ? 0x56524c : b.color, { src: b.id })
  }

  spawnDust(b, k = 1, atY) {
    const x = b.cx + (Math.random() - 0.5) * b.fw * 1.3
    const z = b.cz + (Math.random() - 0.5) * b.fd * 1.3
    const y = (atY ?? b.base) + Math.random() * 6
    const v = 3 + Math.random() * 4
    const ang = Math.random() * Math.PI * 2
    this.dust.emit(x, y, z, Math.cos(ang) * v, 1 + Math.random() * 2, Math.sin(ang) * v, 8 * k, 6 * k, 5 + Math.random() * 5, [0.62, 0.57, 0.5, 0.55], [0.7, 0.66, 0.6, 0])
  }

  dispose() {
    this.ro.disconnect()
    this.life.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
