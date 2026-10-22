// Three.js scene: terrain and surrounding landscape, buildings, water,
// city life, props and effects.
import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { GRID, CELL, CELL_ROAD, CELL_RIVER, CELL_BANK, CELL_PARK, CELL_POND, CELL_GRASS, BUILDING_TYPES, CITY_TYPES, RIVER_HALF_WIDTH, RIVER_DEPTH } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { makeNoise2D, clamp, lerp, smoothstep, normCdf } from './math.js'
import { Particles, Debris, Rain } from './effects.js'
import { StormClouds, WindStreaks } from './weather.js'
import { StormFx } from './stormFx.js'
import { vortexWind } from './stormHazards.js'
import { depthColor } from './floodMap.js'
import { makeWaterMaterial, SkyEnvironment } from './materials.js'
import { BuildingParts } from './buildingMesh.js'
import { buildProps, finishRect } from './props.js'
import { GROUND_PLAZA, GROUND_FIELD, GROUND_COURT } from './sites.js'
import { CityLife } from './cityLife.js'
import { buildRoadMeshes } from './roads.js'
import { Subsurface } from './subsurface.js'
import { loadModels } from './quaternius.js'
import { Wreckage } from './wreckage.js'
import { buildingPeriod } from './quakeSim.js'
import { M_SHOP } from './archetypes.js'

/** Does b throw facade pieces in strong shaking: tall cladding, or masonry parapets. */
export const sheddingFacade = (b) => b.floors >= 7 || b.construction === 'urm'

const HALF = (GRID * CELL) / 2
const PX = 16 // terrain texture pixels per cell
const OFF_BLOCK = { y: -1e6, bid: -1 }
const OUTER = 3600 // half-size of the surrounding landscape (m)
const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _t = new THREE.Matrix4()
const _c = new THREE.Color()
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()
const _e = new THREE.Euler()

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
    // water sloshing in the shaking: (amplitude m, direction x, direction z)
    this.uQuake = { value: new THREE.Vector3(0, 1, 0) }
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
    // there is no ground beyond the cut-away block: debris thrown past the edge falls away
    this.debris.surfaceAt = (x, z, src) => (Math.abs(x) > HALF || Math.abs(z) > HALF ? OFF_BLOCK : this.surfaceAt(x, z, src))
    this.debris.edgeAt = (x, z) => this.groundAt(x, z)
    this.debris.half = HALF
    this.debris.onLand = (it, v, bid) => this.debrisLanded(it, v, bid)
    this.debris.onShatter = (it) => this.shatter(it)
    this.rain = new Rain(scene)
    this.clouds = new StormClouds(scene)
    this.streaks = new WindStreaks(scene)
    this.leaves = new Particles(scene, 1500, false)
    this.spray = new Particles(scene, 1500, false)
    this.stormFx = new StormFx(scene, this.dust)
    // wind for swaying trees: (direction x, direction z, sway amplitude m, speed m/s)
    this.uWind = { value: new THREE.Vector4(1, 0, 0, 0) }
    this.cloudTint = new THREE.Color(0x5c6470)
    this.cloudCover = 0
    // collapsing buildings break into rigid pieces once the physics engine has loaded
    // (until then, or if it fails to load, collapses stay scripted)
    this.wreck = new Wreckage(this)
    this.wreck.onHitBuilding = (bid, e) => this.pieceHit(bid, e)
    this.wreck.onHitGround = (x, y, z, r, e) => this.pieceLanded(x, y, z, r, e)
    this.wreck.onSettle = (x, y, z, size) => this.pieceSettled(x, z, size)
    this.wreck.onRetire = (bid) => this.wreckRetired(bid)
    this.wreck.onBreak = (x, y, z) => this.dustBurst(x, y, z, 14, 8)
    this.wreck.onShatter = (x, y, z, size) => this.crumble(x, y, z, size)
    this.wreck.start()
    this.life = new CityLife(scene, this)
    this.lifeCtx = {}
    this.impactAcc = new Map()
    this.facadeKills = new Map() // building id → people in the street killed by its facade
    this.subsurface = new Subsurface(this)
    // CC0 Quaternius vehicles stream in; built-in ones are used until then
    loadModels().then((m) => {
      if (!m) return
      this.life.models = m
      this.onAssetsLoaded?.()
    })
    // the district is always shown as a cut-away block; the generated landscape
    // around it is switched off for now (fewer generated assets, faster)
    this.showWorld = false
    this.blockShake = new THREE.Vector3()

    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)),
      new THREE.LineBasicMaterial({ color: 0x4ade80, depthTest: false, transparent: true }),
    )
    this.highlight.renderOrder = 10
    this.highlight.visible = false
    scene.add(this.highlight)

    this.bld = new BuildingParts({ uNight: this.uNight, envMap: this.sky.texture, cell: CELL })
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
    this.floodBaseY = null
    if (this.tornado) this.setTornado(null)
    this.city = city
    this.clearGround()
    this.burning = [] // fires of the previous city must not follow us onto the new one
    this.burningTrees = []
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
    this.facadeKills.clear()
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
    this.buildProps()
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
    if (a?.heap) {
      const hh = this.wreck.heapAt(b, a.heapH, a.spread, x, z)
      return hh < 0 ? { y: ground, bid: -1 } : { y: Math.max(ground, b.base + b.elevated - (a.settle || 0) + hh), bid }
    }
    // the roof of whichever part is under the point: a podium, a tower, or open ground in a courtyard
    const row = this.bIndex?.get(bid)
    const top = row === undefined ? b.height * (a?.hScale ?? 1) : this.bld.roofAt(row, x - b.cx, z - b.cz)
    if (top < 0) return { y: ground, bid: -1 }
    return { y: Math.max(ground, b.base + b.elevated - (a?.settle || 0) + top), bid }
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
    // remember each vertex's height above the terrain so roads can follow ground movement
    for (const m of [road, walk]) {
      const p = m.geometry.attributes.position.array
      const off = new Float32Array(p.length / 3)
      for (let q = 0; q < off.length; q++) off[q] = p[q * 3 + 1] - this.vertexHeight(Math.round((p[q * 3] + HALF) / CELL), Math.round((p[q * 3 + 2] + HALF) / CELL))
      m.userData.off = off
    }
    this.root.add(road, walk)
  }

  /** Re-seat road and sidewalk vertices on the (deformed) terrain. */
  refreshRoadHeights() {
    for (const m of [this.roadMesh, this.walkMesh]) {
      if (!m?.userData.off) continue
      const attr = m.geometry.attributes.position
      const p = attr.array
      const off = m.userData.off
      for (let q = 0; q < off.length; q++) p[q * 3 + 1] = this.vertexHeight(Math.round((p[q * 3] + HALF) / CELL), Math.round((p[q * 3 + 2] + HALF) / CELL)) + off[q]
      attr.needsUpdate = true
      m.geometry.computeVertexNormals()
      m.geometry.computeBoundingSphere()
    }
  }

  /** Ground failure from the earthquake: terrain movement, scars, sand boils and fissures. */
  updateGround(g) {
    this.groundFx = g
    if (g.dirtyZ) {
      g.dirtyZ = false
      this.updateTerrainHeights()
      this.refreshRoadHeights()
      this.buildTrees()
      this.buildProps()
    }
    if (g.dirtyFx) {
      g.dirtyFx = false
      this.paintTerrain()
      this.buildGroundMarks()
    }
    for (const sl of g.fxQueue.splice(0)) this.landslideFx(g, sl)
  }

  clearGround() {
    this.groundFx = null
    for (const m of [this.boilMesh, this.crackMesh]) {
      if (!m) continue
      this.root.remove(m)
      m.geometry.dispose()
      m.material.dispose()
    }
    this.boilMesh = this.crackMesh = null
  }

  /** Sand boils and open fissures on top of the road surface (the terrain texture shows the rest). */
  buildGroundMarks() {
    const g = this.groundFx
    const { city } = this
    const onRoad = (k) => city.cellType[k] === CELL_ROAD && !city.bridge[k]
    const boils = g.boils.filter((s) => onRoad(s.k))
    const cracks = g.cracks.filter((c) => onRoad(c.k))
    if (!this.boilMesh) {
      this.boilMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.15, 1, 10).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9a907e, roughness: 1 }), 1600)
      this.crackMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 1 }), 2400)
      this.boilMesh.receiveShadow = true
      this.root.add(this.boilMesh, this.crackMesh)
    }
    boils.forEach((s, q) => {
      const x = s.x - HALF
      const z = s.z - HALF
      _m.makeScale(s.r, 0.1 + s.r * 0.05, s.r).setPosition(x, this.groundAt(x, z) + 0.04, z)
      this.boilMesh.setMatrixAt(q, _m)
    })
    this.boilMesh.count = boils.length
    this.boilMesh.instanceMatrix.needsUpdate = true
    cracks.forEach((c, q) => {
      const x = c.x - HALF
      const z = c.z - HALF
      _m.makeScale(c.len, 0.05, c.w).premultiply(_r.makeRotationY(c.ang))
      _m.setPosition(x, this.groundAt(x, z) + 0.085, z)
      this.crackMesh.setMatrixAt(q, _m)
    })
    this.crackMesh.count = cracks.length
    this.crackMesh.instanceMatrix.needsUpdate = true
  }

  /** Draw scars, deposits, wet liquefied ground, sand boils and fissures into the terrain texture. */
  paintGroundFx(ctx) {
    const g = this.groundFx
    const { noise } = this
    for (let k = 0; k < GRID * GRID; k++) {
      const i = k % GRID
      const j = (k - i) / GRID
      const n = noise.fbm(i * 0.4, j * 0.4, 2)
      if (g.slid[k] === 1) ctx.fillStyle = `rgb(${104 + n * 25},${80 + n * 18},${56 + n * 10})`
      else if (g.slid[k] === 2) ctx.fillStyle = `rgb(${124 + n * 20},${106 + n * 15},${82 + n * 10})`
      else if (g.liqCount[k]) ctx.fillStyle = `rgba(118,112,98,${Math.min(0.55, 0.25 + g.liqCount[k] * 0.08)})`
      else continue
      ctx.fillRect(i * PX, j * PX, PX, PX)
    }
    const s = PX / CELL
    ctx.fillStyle = 'rgba(172,162,140,0.95)'
    for (const b of g.boils) {
      ctx.beginPath()
      ctx.arc(b.x * s, b.z * s, Math.max(1, b.r * s), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.strokeStyle = 'rgba(25,20,15,0.85)'
    ctx.lineCap = 'round'
    for (const c of g.cracks) {
      const dx = (Math.cos(c.ang) * c.len * s) / 2
      const dz = (-Math.sin(c.ang) * c.len * s) / 2
      ctx.lineWidth = Math.max(0.6, c.w * s)
      ctx.beginPath()
      ctx.moveTo(c.x * s - dx, c.z * s - dz)
      ctx.lineTo(c.x * s + dx * 0.2 - dz * 0.25, c.z * s + dz * 0.2 + dx * 0.25)
      ctx.lineTo(c.x * s + dx, c.z * s + dz)
      ctx.stroke()
    }
  }

  /** Earth and rock pour down the slope from a landslide scar. */
  landslideFx(g, sl) {
    const cells = sl.cells.slice(0, 30)
    for (const k of cells) {
      const i = k % GRID
      const j = (k - i) / GRID
      const x = cellToWorld(i)
      const z = cellToWorld(j)
      const y = this.groundAt(x, z)
      const ax = g.aspX[k]
      const az = g.aspZ[k]
      for (let q = 0; q < 4; q++) {
        const v = 5 + Math.random() * 7
        this.debris.spawn(x + (Math.random() - 0.5) * CELL, y + 1 + Math.random() * 2, z + (Math.random() - 0.5) * CELL, ax * v, 1 + Math.random() * 2, az * v, 0.8 + Math.random() * 1.8, Math.random() < 0.5 ? 0x6e5a44 : 0x857563)
      }
      for (let q = 0; q < 10; q++)
        this.dust.emit(x + (Math.random() - 0.5) * CELL, y + Math.random() * 3, z + (Math.random() - 0.5) * CELL, ax * 4 + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, az * 4 + (Math.random() - 0.5) * 3, 12, 8, 7 + Math.random() * 5, [0.55, 0.47, 0.38, 0.6], [0.62, 0.56, 0.48, 0])
    }
  }

  paintLamps() {
    this.life.paintLampMap(this.lampCanvas.getContext('2d'), this.lampCanvas.width)
    this.lampTex.needsUpdate = true
  }

  updateTerrainHeights() {
    this.floodBaseY = null
    const g = this.terrainGeo
    const pos = g.attributes.position.array
    const V = GRID + 1
    for (let vj = 0; vj < V; vj++) for (let vi = 0; vi < V; vi++) pos[(vj * V + vi) * 3 + 1] = this.vertexHeight(vi, vj)
    g.attributes.position.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
    g.computeBoundingBox()
    if (this.outerMesh) this.updateOuterHeights()
    this.wreck.groundChanged()
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
    const C = city.coast
    if (C) {
      // the coastline runs on east and west; offshore the seabed shelves away
      const zs = (C.shoreMean + 0.5) * CELL - HALF
      const off = z - zs
      if (off > 0) return lerp(edgeH, C.msl - Math.min(25, 0.8 + off * 0.03), smoothstep(0, 250, dist))
    }
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
    if (C) {
      // a low coastal plain behind the beach, rising slowly inland
      const inland = (C.shoreMean + 0.5) * CELL - HALF - z
      natural = lerp(C.msl + 1.2 + inland * 0.004, natural, smoothstep(150, 1400, inland))
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
      const above = y - this.outerBase(z)
      // meadow → forest → rock → snow
      _c.setRGB(0.36 + f * 0.05, 0.47 + f * 0.06, 0.25)
      if (f > 0.05 || above > 40) _c.lerp(new THREE.Color(0.17, 0.27, 0.15), smoothstep(0.0, 0.25, f) * 0.85 + smoothstep(40, 90, above) * 0.3)
      _c.lerp(new THREE.Color(0.45, 0.42, 0.38), smoothstep(0.25, 0.55, slope) + smoothstep(220, 330, above))
      _c.lerp(new THREE.Color(0.93, 0.94, 0.96), smoothstep(360, 430, above) * (1 - smoothstep(0.5, 0.8, slope)))
      if (above < 0.5) _c.setRGB(0.38, 0.33, 0.24)
      // beaches along the coast, sand and silt under the sea
      if (this.city.coast && y < this.city.coast.msl + 1.4) _c.setRGB(0.66, 0.6, 0.45).lerp(new THREE.Color(0.3, 0.3, 0.26), smoothstep(0, 8, this.city.coast.msl - y))
      col.set([_c.r, _c.g, _c.b], k * 3)
    }
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate = true
    g.computeBoundingSphere()
  }

  /** Height the surrounding land's colours and forest are measured from: the river's banks, or on the coast the sea. */
  outerBase(z) {
    const bank = 20 - (z + HALF) * 0.0015
    return this.city.coast ? Math.min(bank, this.city.coast.msl + 1.6) : bank
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
      const above = y - this.outerBase(z)
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
        else if (city.sea[k]) {
          // sand under the shallows, darker silt further out
          const dz = city.coast.msl - city.z[k]
          col = `hsl(${42 - smoothstep(0, 6, dz) * 8}, ${32 - smoothstep(0, 6, dz) * 12}%, ${58 - smoothstep(0, 7, dz) * 26 + n * 3}%)`
        } else if (t === CELL_RIVER) col = '#4a4030'
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
        if (t === CELL_ROAD || city.buildingAt[idx(i, j)] >= 0 || city.sea[idx(i, j)]) continue
        const d = Math.abs(px + 0.5 - c)
        if (d < hw) ctx.fillStyle = d < hw * 0.7 ? '#3f382b' : (px * 3 + py * 5) % 7 < 1 ? '#6e6250' : '#5d4f38'
        else if (d < bank) ctx.fillStyle = (px * 7 + py * 13) % 11 < 1 ? '#a8966a' : '#b5a477'
        else if (t === CELL_BANK || t === CELL_RIVER) ctx.fillStyle = 'hsl(95, 36%, 37%)'
        else continue
        ctx.fillRect(px, py, 1, 1)
      }
    }
    this.paintGrounds(ctx)
    // lots
    for (const b of city.buildings) {
      if (b.removed) continue
      const x = b.x * PX
      const y = b.y * PX
      const w = b.w * PX
      const d = b.d * PX
      // the street side of the lot: a driveway or a row of parking bays
      const f = b.facing ?? 0
      const strip = (depth, along) => {
        if (f === 0) return [x + along, y + d - depth]
        if (f === 2) return [x + along, y]
        if (f === 1) return [x + w - depth, y + along]
        return [x, y + along]
      }
      if (b.type === 'house') {
        ctx.fillStyle = 'rgba(80,120,60,0.5)'
        ctx.fillRect(x + 1, y + 1, w - 2, d - 2)
        ctx.fillStyle = '#8a8780'
        const [sx, sy] = strip(6, (f % 2 ? d : w) / 2 - 2)
        ctx.fillRect(sx, sy, f % 2 ? 6 : 4, f % 2 ? 4 : 6)
      } else if (BUILDING_TYPES[b.type].landmark || b.variant) {
        // civic and campus buildings stand on stone paving
        ctx.fillStyle = '#c4bdae'
        ctx.fillRect(x + 1, y + 1, w - 2, d - 2)
      } else {
        ctx.fillStyle = b.type === 'industrial' ? '#7c7a72' : '#9a978e'
        ctx.fillRect(x, y, w, d)
        if (b.type !== 'industrial' && b.floors < 10) {
          // parking bays
          ctx.fillStyle = 'rgba(255,255,255,0.35)'
          const len = f % 2 ? d : w
          for (let s = 3; s < len - 3; s += 3) {
            const [sx, sy] = strip(5, s)
            ctx.fillRect(sx + (f % 2 ? 0.5 : 0), sy + (f % 2 ? 0 : 0.5), f % 2 ? 4 : 0.6, f % 2 ? 0.6 : 4)
          }
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
    for (let k = 0; k < GRID * GRID; k++) {
      if (city.levee[k] > 0) {
        ctx.fillStyle = city.seawall?.[k] ? '#8d8a82' : '#6d6047'
        ctx.fillRect((k % GRID) * PX, Math.floor(k / GRID) * PX, PX, PX)
      }
      // a mangrove belt: dark tangled roots on the mud
      if (city.mangrove?.[k]) {
        const x = (k % GRID) * PX
        const y = Math.floor(k / GRID) * PX
        ctx.fillStyle = '#3d4a2c'
        ctx.fillRect(x, y, PX, PX)
        ctx.fillStyle = 'rgba(28,38,22,0.8)'
        for (let q = 0; q < 6; q++) ctx.fillRect(x + ((k * 7 + q * 5) % PX), y + ((k * 3 + q * 11) % PX), 3, 3)
      }
    }
    if (this.groundFx) this.paintGroundFx(ctx)
    this.terrainTex.needsUpdate = true
  }

  /** Squares, lawns, playing fields, courts and park paths. */
  paintGrounds(ctx) {
    const { city } = this
    if (!city.ground) return
    for (let k = 0; k < GRID * GRID; k++) {
      const g = city.ground[k]
      if (!g || city.buildingAt[k] >= 0) continue
      const x = (k % GRID) * PX
      const y = Math.floor(k / GRID) * PX
      if (g === GROUND_PLAZA) {
        ctx.fillStyle = '#cbc4b4'
        ctx.fillRect(x, y, PX, PX)
        ctx.fillStyle = 'rgba(70,60,50,0.12)'
        for (let s = 0; s < PX; s += 4) {
          ctx.fillRect(x + s, y, 0.5, PX)
          ctx.fillRect(x, y + s, PX, 0.5)
        }
      } else {
        // mown grass in stripes
        const base = g === GROUND_COURT ? null : g === GROUND_FIELD ? [112, 48, 35] : [98, 46, 38]
        if (base) {
          for (let s = 0; s < PX; s += 4) {
            ctx.fillStyle = `hsl(${base[0]}, ${base[1]}%, ${base[2] + ((y + s) / 4) % 2 * 3}%)`
            ctx.fillRect(x, y + s, PX, 4)
          }
        }
      }
    }
    const R = (r, inset = 0) => [r.x * PX + inset, r.y * PX + inset, r.w * PX - 2 * inset, r.d * PX - 2 * inset]
    for (const s of city.sites || []) {
      const field = finishRect(city, s, GROUND_FIELD)
      if (field) {
        // running track around a pitch
        const [x, y, w, h] = R(field, 2)
        ctx.lineWidth = 7
        ctx.strokeStyle = '#b5583f'
        ctx.beginPath()
        ctx.roundRect(x + 3.5, y + 3.5, w - 7, h - 7, Math.min(w, h) / 2 - 3.5)
        ctx.stroke()
        ctx.lineWidth = 0.4
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'
        for (const o of [1, 3.5, 6]) {
          ctx.beginPath()
          ctx.roundRect(x + o, y + o, w - 2 * o, h - 2 * o, Math.max(1, Math.min(w, h) / 2 - o))
          ctx.stroke()
        }
        const ix = x + 12
        const iy = y + 12
        const iw = w - 24
        const ih = h - 24
        if (iw > 8 && ih > 8) {
          ctx.lineWidth = 0.6
          ctx.strokeRect(ix, iy, iw, ih)
          ctx.beginPath()
          if (iw >= ih) ctx.moveTo(ix + iw / 2, iy), ctx.lineTo(ix + iw / 2, iy + ih)
          else ctx.moveTo(ix, iy + ih / 2), ctx.lineTo(ix + iw, iy + ih / 2)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.15, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
      const court = finishRect(city, s, GROUND_COURT)
      if (court) {
        const [x, y, w, h] = R(court)
        if (s.kind === 'primary') {
          // a sandy playground with soft rubber under the climbing frames
          ctx.fillStyle = '#d6c193'
          ctx.fillRect(x, y, w, h)
          for (const [fx, fy, c] of [[0.2, 0.3, '#3f7f9a'], [0.6, 0.55, '#b8584a'], [0.35, 0.7, '#4f8f4a']]) {
            ctx.fillStyle = c
            ctx.beginPath()
            ctx.arc(x + w * fx, y + h * fy, Math.min(w, h) * 0.14, 0, Math.PI * 2)
            ctx.fill()
          }
        } else {
          ctx.fillStyle = '#4f7f6a'
          ctx.fillRect(x, y, w, h)
          ctx.fillStyle = '#3f6f8f'
          ctx.fillRect(x + 3, y + 3, w - 6, h - 6)
          ctx.strokeStyle = 'rgba(255,255,255,0.85)'
          ctx.lineWidth = 0.5
          ctx.strokeRect(x + 4, y + 4, w - 8, h - 8)
          ctx.beginPath()
          if (w >= h) ctx.moveTo(x + w / 2, y + 4), ctx.lineTo(x + w / 2, y + h - 4)
          else ctx.moveTo(x + 4, y + h / 2), ctx.lineTo(x + w - 4, y + h / 2)
          ctx.stroke()
        }
      }
      const plaza = finishRect(city, s, GROUND_PLAZA)
      if (plaza && s.kind !== 'university') {
        // a compass rose of darker stone in the middle of the square
        const [x, y, w, h] = R(plaza)
        ctx.strokeStyle = 'rgba(110,95,80,0.45)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    // gravel paths winding through the parks
    ctx.lineCap = 'round'
    for (const p of city.parks || []) {
      const [x, y, w, h] = R(p)
      const cx = x + w / 2
      const cy = y + h / 2
      ctx.strokeStyle = '#d4c8a6'
      ctx.lineWidth = p.big ? 4 : 3
      ctx.beginPath()
      for (const [fx, fy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        ctx.moveTo(x + w * fx, y + h * fy)
        ctx.quadraticCurveTo(x + w * (0.5 + (fy - 0.5) * 0.6), y + h * (0.5 - (fx - 0.5) * 0.6), cx, cy)
      }
      ctx.stroke()
      if (p.big || p.w * p.d >= 12) {
        ctx.beginPath()
        ctx.arc(cx, cy, Math.min(w, h) * 0.32, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = '#d4c8a6'
        ctx.beginPath()
        ctx.arc(cx, cy, Math.min(w, h) * 0.12, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.lineCap = 'butt'
  }

  // ------------------------------------------------------------------ water
  buildWater() {
    const g = this.gridGeometry()
    const V = GRID + 1
    g.setAttribute('aWater', new THREE.BufferAttribute(new Float32Array(V * V * 4), 4))
    this.waterGeo = g
    this.waterMat = this.waterMat || this.trackEnv(makeWaterMaterial({ envMap: this.sky.texture, uTime: this.uTime, uRain: this.uRain, uQuake: this.uQuake }))
    this.envMaterials.add(this.waterMat)
    const mesh = new THREE.Mesh(g, this.waterMat)
    mesh.receiveShadow = true
    mesh.renderOrder = 2
    this.water = mesh
    this.root.add(mesh)
    this.wetVert = new Uint8Array(V * V)
    this.vh = new Float32Array(V * V)
    // the river continues beyond the district to the north and south (on the coast, only north: the sea is south)
    this.outerRivers = []
    this.outerSea = null
    this.outerSouth = null
    if (this.city.coast) this.buildOuterSea()
    for (const s of this.city.coast ? [-1] : [-1, 1]) {
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
      if (s < 0) this.outerNorth = m
      else this.outerSouth = m
      this.outerRivers.push(m)
      this.root.add(m)
    }
  }

  /** Open sea beyond a coastal district: south of it, and east and west along the coast. */
  buildOuterSea() {
    const C = this.city.coast
    const zs = (C.shoreMean + 0.5) * CELL - HALF
    const parts = [
      [-OUTER, OUTER, HALF, OUTER],
      [-OUTER, -HALF, zs, HALF],
      [HALF, OUTER, zs, HALF],
    ]
    this.outerSea = []
    for (const [x0, x1, z0, z1] of parts) {
      const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, 8, 8).rotateX(-Math.PI / 2)
      const n = geo.attributes.position.count
      const aw = new Float32Array(n * 4)
      for (let q = 0; q < n; q++) aw.set([12, 0, 0, 0], q * 4)
      geo.setAttribute('aWater', new THREE.BufferAttribute(aw, 4))
      const m = new THREE.Mesh(geo, this.waterMat)
      m.position.set((x0 + x1) / 2, C.msl, (z0 + z1) / 2)
      m.renderOrder = 2
      this.outerSea.push(m)
      this.outerRivers.push(m)
      this.root.add(m)
    }
  }

  /** Rebuild the water surface from a FloodSim (h, zg, vx, vz arrays). */
  updateWater(sim) {
    this.waterSim = sim
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
    // the open sea stands at the level the sim holds its edge at
    if (this.outerSea && sim.coast) for (const m of this.outerSea) m.position.y = sim.seaZ
    // outer river level follows the edge rows
    for (const [m, j] of [
      [this.outerNorth, 0],
      [this.outerSouth, GRID - 1],
    ]) {
      if (!m) continue
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

  /** Benches, fountains, gazebos, goals and lamps in parks, squares and school grounds. */
  buildProps() {
    if (this.propGroup) {
      this.root.remove(this.propGroup)
      this.propGroup.traverse((o) => o.geometry?.dispose())
      this.propGroup.children[0]?.material.dispose()
    }
    this.propGroup = buildProps(this.city, (x, z) => this.groundAt(x, z))
    this.root.add(this.propGroup)
    // every prop part, by cell, so falling wreckage can knock it over
    const parts = []
    for (const { mesh, list } of this.propGroup.userData.parts || []) list.forEach((it, q) => parts.push({ mesh, q, it }))
    this.propIdx = this.indexByCell(parts, (p) => [p.it.x, p.it.z])
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
    // a tree knocked down by falling wreckage lies where it fell, pivoted about its foot
    const place = (t, x, y, z, m, dy) => {
      m.elements[13] += dy
      if (t.fallen) m.premultiply(_r.makeRotationAxis(_a.set(t.fallen.az, 0, -t.fallen.ax), t.fallen.th))
      m.elements[12] += x
      m.elements[13] += y
      m.elements[14] += z
      return m
    }
    trees.forEach((t, q) => {
      const x = cellToWorld(t.i) + t.ox
      const z = cellToWorld(t.j) + t.oz
      const y = this.groundAt(x, z)
      t.wx = x
      t.wz = z
      const s = t.s
      trunks.setMatrixAt(q, place(t, x, y, z, _m.makeScale(s, 3 * s, s), 0))
      _c.setHSL(0.27 + (t.ox % 0.05), 0.45, 0.22 + (t.s - 0.7) * 0.12)
      // burnt by fire: a charred, half-bare skeleton
      const burnt = t.burnt ? 0.5 : 1
      if (t.burnt) _c.set(0x231f1b)
      if (t.kind === 1) {
        cones.setMatrixAt(ki, place(t, x, y, z, _m.makeScale(3 * s * burnt, 8 * s * (0.4 + burnt * 0.6), 3 * s * burnt), 2 * s))
        cones.setColorAt(ki++, t.burnt ? _c : _c.offsetHSL(0.03, 0, -0.04))
      } else {
        crowns.setMatrixAt(ci, place(t, x, y, z, _m.makeScale(3.4 * s * burnt, 3.2 * s * burnt, 3.4 * s * burnt), 5 * s))
        crowns.setColorAt(ci++, _c)
      }
    })
    crowns.count = ci
    cones.count = ki
    trunks.count = n
    this.swayInWind(crowns.material, true)
    this.swayInWind(cones.material, false)
    this.swayInWind(trunks.material, false)
    for (const m of [crowns, cones, trunks]) {
      m.castShadow = true
      m.receiveShadow = true
      group.add(m)
    }
    this.treeGroup = group
    this.root.add(group)
    this.treeIdx = this.indexByCell(trees, (t) => [t.wx, t.wz])
    this.treesDirty = false
  }

  // ------------------------------------------------------------- buildings
  rebuildBuildings() {
    const { city } = this
    for (const m of this.bld.materials) this.envMaterials.delete(m)
    for (const s of this.iconSprites || []) this.root.remove(s)
    const list = city.buildings.filter((b) => !b.removed)
    this.bList = list
    this.bIndex = new Map(list.map((b, i) => [b.id, i]))
    this.bld.build(list)
    for (const m of this.bld.materials) this.trackEnv(m)
    if (this.bld.group.parent !== this.root) this.root.add(this.bld.group)

    this.iconSprites = []
    for (const b of list) {
      const tex = this.icons[b.type]
      if (!tex || b.noIcon) continue
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }))
      s.scale.set(16, 16, 1)
      s.position.set(b.cx, b.base + b.elevated + b.height + 14, b.cz)
      s.userData.bid = b.id
      this.iconSprites.push(s)
      this.root.add(s)
    }
    this.updateAllBuildings()
    this.refreshColors()
    // the wreckage rows were reallocated with the meshes
    this.wreck.reset()
  }

  /** Unit-box matrix for a building's footprint volume, including tilt and topple rotation. */
  composeBuilding(b, out) {
    const a = this.anim.get(b.id)
    this.composeFrame(b, out)
    const H = b.height * (a?.hScale ?? 1)
    out.multiply(_t.makeScale(b.fw, H, b.fd))
    return { H }
  }

  /** Building frame: local metres (origin at the base of the footprint centre) → world. */
  composeFrame(b, out) {
    const a = this.anim.get(b.id)
    let s = 1
    let tx = 0
    let tz = 0
    if (a) {
      s = a.spread
      // permanent lean from a failing foundation, plus any damage tilt
      tx = a.tiltX + (a.topple ? 0 : a.leanTx || 0)
      tz = a.tiltZ + (a.topple ? 0 : a.leanTz || 0)
    }
    out.makeScale(s, 1, s)
    if (tx || tz) out.premultiply(_r.makeRotationFromEuler(_e.set(tx, 0, tz)))
    out.elements[12] = b.cx
    out.elements[13] = b.base + b.elevated - (a?.settle || 0)
    out.elements[14] = b.cz
    if (a?.topple) {
      const T = a.topple
      _t.makeTranslation(-T.px, -T.py, -T.pz)
      out.premultiply(_t)
      out.premultiply(_r.makeRotationAxis(_a.set(T.ax, 0, T.az), T.theta))
      out.premultiply(_t.makeTranslation(T.px, T.py, T.pz))
    }
    return out
  }

  /**
   * How much of the building stands, in rest metres: storeys above `cut` have
   * sheared off, and `sink` metres of storeys have been crushed at the base.
   */
  standing(b, a) {
    const H = b.height
    // a rubble heap (drawn separately) is all that is left on the footprint
    if (a?.heap) return { cut: 0.05, sink: 0 }
    // broken into pieces: only the growing rubble mound is left on the footprint
    if (a?.broken) return { cut: H * Math.min(a.hScale, 0.6), sink: 0 }
    if (!a || a.hScale >= 0.999) return { cut: 1e4, sink: 0 }
    if (a.rubble) return { cut: H * a.hScale, sink: 0 }
    // a pancake starts from whatever was still standing (all of it, or the stub of a partial collapse)
    const h0 = a.collapse?.kind === 'pancake' ? (a.collapse.h0 ?? 1) : a.hScale
    return { cut: h0 >= 0.999 ? 1e4 : H * h0, sink: H * (h0 - a.hScale) }
  }

  updateBuilding(b) {
    const i = this.bIndex.get(b.id)
    if (i === undefined) return
    this.composeFrame(b, _m)
    const a = this.anim.get(b.id)
    const live = a && !a.rubble && !a.broken
    const { cut, sink } = this.standing(b, a)
    const lights = a && (a.rubble || a.broken || a.burnt || a.ds >= 3 || a.dark || a.partial) ? 0 : 1
    this.bld.set(i, _m, live ? a.ux * a.vis : 0, live ? a.uz * a.vis : 0, b.height, cut, sink, lights + (a?.rubble || a?.broken ? 2 : 0), live ? a.mx * a.vis : 0, live ? a.mz * a.vis : 0)
  }

  updateAllBuildings() {
    for (const b of this.bList) this.updateBuilding(b)
  }

  setColorFn(fn) {
    this.colorFn = fn
    this.refreshColors()
  }

  refreshColors() {
    if (!this.bList) return
    // damage, fire and flood stains are lerps toward fixed colours: fold them into one tint
    const body = [0, 0, 0, 0]
    const detail = [0, 0, 0, 0]
    this.bList.forEach((b, i) => {
      const c = this.colorFn ? this.colorFn(b) : null
      const a = this.anim.get(b.id)
      let r = 0
      let g = 0
      let bl = 0
      let keep = 1
      const toward = (hex, k) => {
        _c.set(hex)
        r = r * (1 - k) + _c.r * k
        g = g * (1 - k) + _c.g * k
        bl = bl * (1 - k) + _c.b * k
        keep *= 1 - k
      }
      if (c) toward(c, 1)
      else if (a) {
        if (a.burnt) toward(0x1d1a18, 0.85)
        else if (a.burning) toward(0x2a2522, Math.min(0.7, a.burning))
        else if (a.rubble) toward(0x5e574e, 0.65)
        else if (a.ds) toward(0x6a5d50, a.ds * 0.12)
        if (a.wet) toward(0x5a4a33, Math.min(0.55, a.wet))
      }
      const t = 1 - keep
      body[0] = t > 0 ? r / t : 0
      body[1] = t > 0 ? g / t : 0
      body[2] = t > 0 ? bl / t : 0
      body[3] = t
      detail[0] = body[0]
      detail[1] = body[1]
      detail[2] = body[2]
      detail[3] = c ? 0.9 : t
      // roofs (the detail parts of pitched-roof buildings) stripped by the wind: bare, dark timber
      if (!c && (a?.roofLost || a?.roofCover) && !a.rubble) {
        const k = a.roofLost ? 0.85 : 0.45
        detail[0] = detail[0] * detail[3] * (1 - k) + 0.2 * k
        detail[1] = detail[1] * detail[3] * (1 - k) + 0.16 * k
        detail[2] = detail[2] * detail[3] * (1 - k) + 0.12 * k
        detail[3] = 1 - (1 - detail[3]) * (1 - k)
        detail[0] /= detail[3]
        detail[1] /= detail[3]
        detail[2] /= detail[3]
      }
      this.bld.setTint(i, body, detail)
      this.updateBuilding(b)
    })
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
        // sea walls are pale concrete; river walls earth-coloured
        items.push({ x: cellToWorld(i), z: cellToWorld(j), y: city.z[k] - 0.5, sx: CELL, sz: CELL, sy: city.levee[k] + 0.5, c: city.seawall?.[k] ? 0xa7a49c : 0x8a8273 })
      }
    }
    // the river gate: piers across the mouth, the gate leaf raised while it is open
    const RG = city.riverGate
    if (RG) {
      const shut = !!this.gateShut
      for (const k of RG.cells) {
        const x = cellToWorld(k % GRID)
        const z = cellToWorld(Math.floor(k / GRID))
        items.push({ x, z, y: shut ? city.z[k] : RG.crest, sx: CELL, sz: 3, sy: shut ? RG.crest - city.z[k] : 2.5, c: 0x5d6b78 })
        items.push({ x: x - CELL / 2, z, y: city.z[k] - 1, sx: 1.6, sz: 4, sy: RG.crest + 3 - city.z[k], c: 0x9a9a92 })
      }
      const k = RG.cells[RG.cells.length - 1]
      items.push({ x: cellToWorld(k % GRID) + CELL / 2, z: cellToWorld(Math.floor(k / GRID)), y: city.z[k] - 1, sx: 1.6, sz: 4, sy: RG.crest + 3 - city.z[k], c: 0x9a9a92 })
    }
    // bridges: an arched deck from road to road, railings, piers and abutments
    for (const sp of city.bridgeSpans || []) {
      const x0 = cellToWorld(sp.i0) + CELL * 0.35
      const x1 = cellToWorld(sp.i1) - CELL * 0.35
      const z = cellToWorld(sp.j)
      const segs = Math.max(4, Math.round((x1 - x0) / 4))
      const drop = this.bridgeDrop(sp, x0, x1)
      for (let q = 0; q < segs; q++) {
        const xa = x0 + ((x1 - x0) * q) / segs
        const xb = x0 + ((x1 - x0) * (q + 1)) / segs
        const ya = this.deckAt(xa, z)
        const yb = this.deckAt(xb, z)
        const len = Math.hypot(xb - xa, yb - ya) + 0.05
        let rz = Math.atan2(yb - ya, xb - xa)
        const xm = (xa + xb) / 2
        let ym = (ya + yb) / 2
        let dark = 0
        if (drop && xm > drop.a && xm < drop.b) {
          // the fallen span lies broken in the channel, one end still propped on a pier
          const f = (xm - drop.a) / (drop.b - drop.a)
          const bed = city.z[idx(Math.floor((xm + HALF) / CELL), sp.j)]
          ym = bed + 1.2 + (1 - f) * Math.max(0, ym - bed - 1.2) * 0.35
          rz = (q % 2 ? 0.18 : -0.12) + (f < 0.5 ? 0.25 : -0.1)
          dark = 1
        } else if ((sp.ds ?? 0) >= 3 && Math.abs(xm - (x0 + x1) / 2) < (x1 - x0) * 0.3) {
          // unseated girders: the deck has dropped off its bearings and steps out of line
          ym -= q % 3 === 0 ? 0.45 : 0.25
          rz += q % 2 ? 0.025 : -0.02
        }
        const deck = dark ? 0x6c6a64 : 0x8a867c
        items.push({ x: xm, z, y: ym - 1.3, sx: len, sz: CELL * 0.98, sy: 1.3, c: deck, rz })
        items.push({ x: xm, z, y: ym - 0.02, sx: len, sz: CELL * 0.86, sy: 0.06, c: 0x3d3f43, rz })
        if (dark && q % 2) continue // railings torn off the fallen span
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
    this.wreck.setStatics(items)
    this.buildRoadClosures()
  }

  /** The stretch of deck (between two piers) that fell when a bridge collapsed, in world x. */
  bridgeDrop(sp, x0 = cellToWorld(sp.i0) + CELL * 0.35, x1 = cellToWorld(sp.i1) - CELL * 0.35) {
    if (!sp.collapsed) return null
    const piers = [x0]
    for (let x = x0 + 12; x < x1 - 8; x += 20) piers.push(x)
    piers.push(x1)
    const at = x0 + (x1 - x0) * (sp.dropAt ?? 0.5)
    for (let q = 0; q < piers.length - 1; q++) if (at >= piers[q] && at <= piers[q + 1]) return { a: piers[q], b: piers[q + 1] }
    return { a: piers[0], b: piers[1] }
  }

  /** A bridge was damaged: redraw it, and if a span fell, throw up spray and dust. */
  bridgeDamaged(sp) {
    this.rebuildStatic()
    const drop = this.bridgeDrop(sp)
    if (!drop) return
    const z = cellToWorld(sp.j)
    for (let x = drop.a; x < drop.b; x += 2.5) {
      const y = this.deckAt(x, z) ?? 0
      for (let q = 0; q < 4; q++) this.dust.emit(x, y - 1, z + (Math.random() - 0.5) * CELL, (Math.random() - 0.5) * 4, 1 + Math.random() * 3, (Math.random() - 0.5) * 4, 12, 8, 6 + Math.random() * 5, [0.62, 0.6, 0.56, 0.55], [0.75, 0.75, 0.72, 0])
      this.debris.spawn(x, y - 0.5, z + (Math.random() - 0.5) * CELL * 0.8, (Math.random() - 0.5) * 2, -1, (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.2, 0x8a867c)
    }
    this.life.bridgeCollapsed(sp, drop)
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
    // move the ray into the block's frame (it shifts while the ground shakes)
    const ray = this.raycaster.ray.clone()
    ray.origin.sub(this.root.position)
    const hb = this.bld.raycast(ray)
    if (hb) {
      building = this.bList[hb.row]
      hb.point.add(this.root.position)
    }
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
  addShake(pga, realDur, M, main = false, field = null, tm = null) {
    // in cut-away view the shaking starts when the S-waves reach the city
    const lag = this.subsurface.group.visible ? this.subsurface.trigger(M, main) : 0
    // The shaking is a band of frequencies around the ground's predominant one
    // (tm: its period, set by the earthquake and the soil, or by the scenario):
    // fast and jerky for small, close events on rock, slow and rolling for great
    // or distant ones on soft ground. Buildings whose own period falls in the
    // band resonate; the rest ride it out.
    const freqs = []
    const f0 = tm ? 1 / tm : clamp(1.4 - (M - 5) * 0.25, 0.25, 1.4) * 1.6
    for (let k = 0; k < 6; k++) {
      const x = (k - 2.5) / 2
      freqs.push({ f: f0 * Math.exp(x * 0.55 + (Math.random() - 0.5) * 0.12), px: Math.random() * 6.28, pz: Math.random() * 6.28, w: Math.exp(-x * x) })
    }
    // great earthquakes also radiate strong long-period waves that make tall towers resonate
    if (M >= 7.3 && f0 > 0.4) freqs.push({ f: 0.14 + Math.random() * 0.12, px: Math.random() * 6.28, pz: Math.random() * 6.28, w: 0.8 + 0.5 * (M - 7.3) })
    this.shakes.push({ t0: this.realTime + lag, dur: realDur, pga, freqs, field })
    return lag
  }

  groundAccel(t) {
    let ax = 0
    let az = 0
    let env = 0
    // the strongest shaking right now, and its surface PGA map (for what people feel)
    let field = null
    let frac = 0
    let best = 0
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
      if (s.field && s.pga * e > best) {
        best = s.pga * e
        field = s.field
        frac = e
      }
    }
    return { ax, az, env, field, frac }
  }

  animFor(b) {
    let a = this.anim.get(b.id)
    if (!a) {
      // tall towers sway slowly and far (the sway is drawn exaggerated, more so for the tall)
      a = { ux: 0, uz: 0, vx: 0, vz: 0, mx: 0, mz: 0, fr: null, vis: b.floors >= 15 ? 4 : 3, hScale: 1, spread: 1, tiltX: 0, tiltZ: 0, ds: 0, active: false }
      this.anim.set(b.id, a)
    }
    return a
  }

  /** Start a collapse after `delay` seconds of real time. */
  collapse(b, delay = 0, style = 'quake', opts = {}) {
    const a = this.animFor(b)
    if (a.collapse || a.rubble) return
    if (opts.lean) {
      // a building leaning on failed ground goes over the way it was already leaning
      const ang = opts.leanAng
      a.collapse = { t0: this.realTime + delay, dur: 1, dirX: Math.cos(ang), dirZ: Math.sin(ang), spawned: 0, style, kind: 'topple', theta0: opts.lean, started: false }
      a.active = true
      return
    }
    // Buildings very rarely fall over like dominoes: a frame that fails comes
    // down on its own footprint (storeys crushing onto each other, then breaking
    // up into rubble). Whole-building overturning needs gravity to get a lever:
    //  • the ground under it failed and it is already leaning (Niigata 1964);
    //  • it is slender (tall on a narrow base), so a small lean puts its centre
    //    of mass far out;
    //  • one side is weaker than the other: an open ground floor of shopfronts
    //    on the street, walls behind (soft, twisting storey; Tainan 2016,
    //    Kahramanmaraş 2023). It goes over toward the weak side.
    let kind = 'pancake'
    let wait = 0
    let ang = Math.random() * Math.PI * 2
    let theta0 = 0
    if (style === 'quake') {
      const modern = ['rc_high', 'steel', 'isolated', 'rc_mod'].includes(b.construction)
      const brittle = ['urm', 'rc_low', 'wood_old'].includes(b.construction)
      const soft = this.city.soil[idx(b.x + Math.floor(b.w / 2), b.y + Math.floor(b.d / 2))] === 2
      const slender = b.height / Math.max(4, Math.min(b.fw, b.fd))
      // a wide, low block with a weak side still comes straight down: there is no lever
      // (a braced ground floor has no weak side left)
      const open = brittle && !b.softFixed && b.floors >= 4 && slender >= 1.5 && this.openFront(b)
      // the angle it would have to lean before its centre of mass passes the edge of its base
      const tip = Math.atan(1 / slender)
      let pTopple = 0
      if ((opts.tilt ?? 0) > 0.01) {
        // gravity only gets a grip once the lean is a fair part of the tipping angle
        pTopple = clamp((opts.tilt / tip - 0.15) * 2.5, 0, 0.8)
        ang = opts.tiltAng
        theta0 = opts.tilt
      } else {
        // even slender towers mostly come down on themselves: a few per cent, rising with slenderness
        if (slender > 3.5) pTopple += Math.min(0.15, 0.04 * (slender - 3.5))
        if (open) pTopple += 0.1
        if (soft && b.floors >= 5) pTopple += 0.02
      }
      if (open && !theta0) {
        // toward the street front (the building's +z, turned by its facing)
        const th = ((b.facing ?? 0) * Math.PI) / 2
        ang = Math.atan2(Math.cos(th), Math.sin(th)) + (Math.random() - 0.5) * 0.5
      }
      if (b.floors >= 4 && Math.random() < pTopple) {
        kind = 'topple'
        theta0 = Math.max(theta0, 0.015)
      } else if (b.floors >= 5 && Math.random() < 0.22) kind = 'partial'
      if (modern) wait = 1.5 + Math.random() * 2
    }
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
      theta0,
      started: false,
    }
    a.active = true
  }

  /** Does b stand on an open ground floor of shopfronts (a soft, weak side) ? */
  openFront(b) {
    const row = this.bIndex.get(b.id)
    if (row === undefined) return false
    return this.bld.shapes[row].masses.some((m) => m.flags & M_SHOP && m.y < 0.5 && m.h > b.floorH * 1.5)
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
    // What is left on the footprint is a heap of crushed concrete and broken
    // blocks. With physics the big pieces lie on and around it; without, the
    // heap is all there is, and it is taller.
    const m = a.broken ? (a.collapse?.mound ?? clamp(b.height * 0.03, 0.8, 2)) : clamp(b.height * 0.1, 2.5, 8) * 0.8
    this.setHeap(b, a, m)
    a.ux = a.uz = a.vx = a.vz = 0
    this.updateBuilding(b)
    // chips resting on its roof fall onto the rubble
    this.debris.wakeNear(b.cx, b.cz, Math.max(b.fw, b.fd) * 0.6 + 1)
    this.life.blockAround(b)
    this.rubbleDirty = true
  }

  /**
   * A rubble heap h metres high on b's footprint: drawn as a mound with broken
   * blocks, and felt by falling pieces as a low box a little under its mean
   * height (so nothing lands in mid-air over its sloping edges).
   */
  setHeap(b, a, h) {
    a.heap = true
    a.heapH = h
    a.spread = 1.12
    a.hScale = clamp(h / b.height, 0.01, 0.6)
    this.wreck.heap(b, h, a.spread)
    this.wreck.setMound(b, h * 0.45, a.spread * 0.8)
  }

  /** Sway of a building at its top: displacement and velocity (world metres), for the pieces it breaks into. */
  swayOf(a) {
    return { x: a.ux * a.vis, z: a.uz * a.vis, vx: a.vx * a.vis, vz: a.vz * a.vis }
  }

  stepCollapse(b, a, t) {
    const c = a.collapse
    if (!c.started) {
      c.started = true
      // decided once: a collapse that began scripted stays scripted. With too many
      // pieces already moving (a great quake), further collapses are scripted too.
      c.phys = this.wreck.room() > 0
      // either way it no longer stands in the way of falling pieces (a sheared-off top leaves its stub)
      if (c.kind !== 'partial') this.wreck.removeBuilding(b)
      // a building coming down terrifies everyone who can see and hear it
      this.life.alarm(b.cx, b.cz, Math.max(25, b.height * 0.8), c.style === 'flood' || c.style === 'wind' ? 0.45 : 0.7, 0.97)
      if (c.kind === 'topple') {
        // rigid rotation about the base edge, like a falling column: gravity, acting
        // through the leaning centre of mass, takes it over slowly at first
        a.topple = {
          // the weak storey gives way on one side and the building goes over from
          // there (it does not stand balanced on an edge first)
          theta: Math.max(0.05, c.theta0 || 0),
          omega: 0.15,
          ax: c.dirZ,
          az: -c.dirX,
          px: b.cx + (c.dirX * b.fw) / 2,
          py: b.base + b.elevated - (a.settle || 0),
          pz: b.cz + (c.dirZ * b.fd) / 2,
        }
      } else if (c.kind === 'partial') {
        // upper storeys shear off (at a floor line) and fall as one block
        const H = b.height
        const keep = clamp(Math.round((H * (0.45 + Math.random() * 0.25)) / b.floorH) * b.floorH, b.floorH, H - b.floorH)
        a.partial = true
        // the storey where it sheared is crushed: the block drops onto what is left below
        const stub = Math.max(0.5, keep - b.floorH)
        a.hScale = stub / H
        const v = 1.5 + Math.random() * 2.5
        if (c.phys) {
          // the block keeps the sway it had when it sheared off; it breaks up where it lands
          this.composeFrame(b, _m)
          this.wreck.breakBuilding(b, { mode: 'chunks', above: keep, frame: _m, sway: this.swayOf(a), vel: [c.dirX * v, 0.5, c.dirZ * v], compound: true })
        } else {
          this.debris.spawn(b.cx, b.base + b.elevated + keep + (H - keep) / 2 + 0.3, b.cz, c.dirX * v, 0.5, c.dirZ * v, 0, b.color, {
            dims: [b.fw * 0.98, H - keep, b.fd * 0.98],
            fragile: true,
            src: b.id,
          })
        }
        // what remains standing is the stub
        this.wreck.addBuilding(b, stub)
        for (let q = 0; q < 30; q++) this.spawnDust(b, 1, b.base + stub + Math.random() * b.floorH)
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
        this.wreck.removeBuilding(b)
        // the block that sat on it comes down with it and breaks up too
        if (c.phys) this.wreck.crushWreck(b.id)
      }
      return true
    }
    // pancake: storeys crush down onto each other
    const p = clamp((t - c.t0) / c.dur, 0, 1)
    const e = p * p
    const h0 = c.h0 ?? 1
    if (c.phys) return this.crushPieces(b, a, c, p, h0)
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
    const k = c.style === 'flood' || c.style === 'wind' ? 0.3 : 1
    for (let q = 0; q < (p > 0.02 ? 3 : 0); q++) this.spawnDust(b, k * 1.2, b.base + Math.random() * 3)
    if (p >= 1) {
      this.becomeRubble(b, a)
      for (let q = 0; q < 25; q++) this.spawnDust(b, c.style === 'flood' || c.style === 'wind' ? 0.3 : 1.5)
    }
    return true
  }

  /**
   * Progressive collapse with physics: the building breaks into its facade
   * walls and floor slabs, which fall and pile up; the pulverised remainder
   * builds a low mound on the footprint as the collapse runs its course.
   */
  crushPieces(b, a, c, p, h0) {
    if (!c.broken) {
      c.broken = true
      // the failed soft storey (or two, under a tall block) is crushed to dust
      const drop = b.floors >= 3 ? b.floorH * (b.floors >= 12 ? 2 : 1) : 0
      this.composeFrame(b, _m)
      this.wreck.removeBuilding(b)
      this.wreck.breakBuilding(b, { mode: 'crush', below: h0 >= 0.999 ? Infinity : b.height * h0 + 0.01, drop, frame: _m, sway: this.swayOf(a) })
      a.broken = true
      a.partial = false
      c.mound = clamp(b.height * 0.04, 1.2, 3.5)
      for (let q = 0; q < 20; q++) this.spawnDust(b, 1.4, b.base + Math.random() * drop)
    }
    // the crushed material piles up on the footprint as the pieces come down
    const m = c.mound * clamp(p * 1.4, 0, 1)
    a.hScale = m / b.height
    a.spread = 1 + 0.1 * p
    // the floors that came down onto each other do not stay whole: once they have landed,
    // what is still an intact slab or panel is broken up by the crushing
    if (p >= 0.75 && !c.crushed) {
      c.crushed = true
      this.wreck.crushWreck(b.id)
    }
    const target = Math.min(40, Math.round(b.area / 300) + 6)
    const want = Math.floor(target * Math.min(1, p * 1.3))
    for (; c.spawned < want; c.spawned++) this.spawnDebris(b, Math.max(0.1, 1 - p))
    const k = c.style === 'flood' || c.style === 'wind' ? 0.3 : 1
    for (let q = 0; q < (p > 0.02 ? 3 : 0); q++) this.spawnDust(b, k * 1.2, b.base + Math.random() * 3)
    if (p >= 1) {
      this.becomeRubble(b, a)
      for (let q = 0; q < 25; q++) this.spawnDust(b, c.style === 'flood' || c.style === 'wind' ? 0.3 : 1.5)
    }
    return true
  }

  /** A toppling building hits the ground or a neighbour and breaks apart; pieces keep their momentum. */
  breakTopple(b, a, hitBid = -1) {
    const T = a.topple
    const H = b.height
    const c = a.collapse
    // rotational kinetic energy of a rigid column: ½·(⅓·m·H²)·ω²
    const mass = b.area * 800
    const ke = 0.5 * ((mass * H * H) / 3) * T.omega * T.omega
    if (c.phys) {
      // the column breaks into blocks along its storeys, each moving as it was (v = ω × r);
      // they hit the ground, the street and the neighbours themselves
      this.composeFrame(b, _m)
      this.wreck.breakBuilding(b, { mode: 'chunks', frame: _m, topple: { omega: T.omega, ax: T.ax, az: T.az, px: T.px, py: T.py, pz: T.pz } })
      a.broken = true
      if (hitBid >= 0) this.onImpact?.(hitBid, ke * 0.2)
      for (let q = 0; q < 40; q++) this.spawnDust(b, 1.8)
      for (let q = 0; q < 20; q++) this.spawnDebris(b, 0.2)
      this.becomeRubble(b, a)
      return
    }
    if (hitBid >= 0) this.onImpact?.(hitBid, ke * 0.6)
    // anyone under the falling building
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

  /**
   * A falling piece struck a standing building at (x, y, z), delivering
   * impulse (jx, jz) and e joules. Where it strikes matters to the damage
   * model: columns near the base carry the whole building above them, a
   * parapet or roof slab up top far less. The building is shoved, too: the
   * impulse goes into the storey it hit and the frame sways from it.
   */
  pieceHit(bid, e, x = 0, y = 0, z = 0, jx = 0, jz = 0) {
    const b = this.city?.byId.get(bid)
    if (!b) return
    const a = this.animFor(b)
    const rel = clamp((y - b.base - b.elevated) / b.height, 0, 1)
    e *= rel < 0.3 ? 1.4 : rel > 0.8 ? 0.6 : 1
    if (!a.rubble && !a.broken && !a.topple) {
      const fr = this.frameOf(b, a)
      const k = clamp(Math.ceil(rel * fr.n) - 1, 0, fr.n - 1)
      // lumped mass of that storey band: gross density ~300 kg/m³
      const m = (b.fw * b.fd * b.height * 300) / fr.n
      fr.vx[k] += jx / m
      fr.vz[k] += jz / m
      a.active = true
    }
    // chips and dust burst off the struck facade
    if (e > 5e4) {
      this.dustBurst(x, y, z, Math.min(10, 2 + e / 2e5), 4)
      const n = Math.min(6, Math.round(e / 1e5))
      for (let q = 0; q < n; q++) this.debris.spawn(x, y, z, (Math.random() - 0.5) * 4 - jx * 1e-5, Math.random() * 2, (Math.random() - 0.5) * 4 - jz * 1e-5, 0.4 + Math.random() * 0.6, Math.random() < 0.5 ? 0x8a8478 : b.color, { src: bid })
    }
    const acc = (this.impactAcc.get(bid) || 0) + e
    if (acc > 1.5e5) {
      this.impactAcc.set(bid, 0)
      this.onImpact?.(bid, acc)
    } else this.impactAcc.set(bid, acc)
  }

  /** A falling piece hit the ground, a road or the pile, losing e joules. */
  pieceLanded(x, y, z, r, e) {
    this.strikeAt(x, z, r, e)
    if (e > 1.5e6) this.dustBurst(x, y, z, Math.min(16, 4 + e / 1e6), 6 + r)
  }

  /** A piece broke up on impact: a puff of concrete dust and a spray of small chips. */
  crumble(x, y, z, size) {
    this.dustBurst(x, y, z, Math.min(12, 3 + size * 1.5), size)
    for (let q = 0; q < Math.min(8, Math.round(size * 1.5)); q++) {
      const ang = Math.random() * Math.PI * 2
      const v = 1 + Math.random() * 3
      this.debris.spawn(x + (Math.random() - 0.5) * size, y, z + (Math.random() - 0.5) * size, Math.cos(ang) * v, Math.random() * 2.5, Math.sin(ang) * v, 0.3 + Math.random() * 0.6, Math.random() < 0.6 ? 0x8a8478 : 0x6a655c)
    }
  }

  /**
   * Something heavy came down on (x, z) with energy e: people and cars under
   * it, and trees, lamps, benches and the like within reach are knocked over,
   * away from where it struck.
   */
  strikeAt(x, z, r, e) {
    const hit = this.life.hitArea(x, z, r, e)
    if (hit.killed || hit.crushed) this.onStreetHit?.(hit)
    if (e < 2e4) return hit
    const reach = r + Math.min(3, e / 5e5)
    for (const t of this.near(this.treeIdx, x, z, reach + 2)) {
      if (t.fallen) continue
      const dx = t.wx - x
      const dz = t.wz - z
      const d = Math.hypot(dx, dz)
      if (d > reach + 1.5 * t.s) continue
      const ang = d > 0.1 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2
      t.fallen = { ax: Math.cos(ang), az: Math.sin(ang), th: 1.25 + Math.random() * 0.3 }
      this.treesDirty = true
    }
    // street lights and traffic signals in the way come down too
    for (const p of this.life.polesNear(x, z, reach + 1)) {
      const dx = p.x - x
      const dz = p.z - z
      const d = Math.hypot(dx, dz)
      if (d > reach + 0.5) continue
      const ang = d > 0.1 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2
      this.life.knockPole(p, Math.cos(ang), Math.sin(ang))
    }
    for (const p of this.near(this.propIdx, x, z, reach + 1)) {
      if (p.it.fallen) continue
      const dx = p.it.x - x
      const dz = p.it.z - z
      if (Math.hypot(dx, dz) > reach + Math.max(p.it.w, p.it.d) * 0.5) continue
      const ang = Math.hypot(dx, dz) > 0.1 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2
      p.it.fallen = { ax: Math.cos(ang), az: Math.sin(ang), th: p.it.h > 1.5 ? 1.3 + Math.random() * 0.25 : 0.3 + Math.random() * 0.5 }
      p.mesh.setMatrixAt(p.q, this.propMatrix(p.it))
      p.mesh.instanceMatrix.needsUpdate = true
    }
    return hit
  }

  /** Items bucketed by cell (see indexByCell) within the cells around (x, z). */
  *near(index, x, z, r) {
    if (!index) return
    const i0 = clamp(Math.floor((x - r + HALF) / CELL), 0, GRID - 1)
    const i1 = clamp(Math.floor((x + r + HALF) / CELL), 0, GRID - 1)
    const j0 = clamp(Math.floor((z - r + HALF) / CELL), 0, GRID - 1)
    const j1 = clamp(Math.floor((z + r + HALF) / CELL), 0, GRID - 1)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) yield* index.get(idx(i, j)) || []
  }

  indexByCell(list, xz) {
    const m = new Map()
    for (const o of list) {
      const [x, z] = xz(o)
      if (Math.abs(x) >= HALF || Math.abs(z) >= HALF) continue
      const k = idx(Math.floor((x + HALF) / CELL), Math.floor((z + HALF) / CELL))
      const a = m.get(k)
      if (a) a.push(o)
      else m.set(k, [o])
    }
    return m
  }

  /** Placement of a prop part, knocked over about its foot if it was struck. */
  /**
   * Trees bend downwind and pump in the gusts. The gusts roll through the
   * canopy as waves travelling with the wind, so you can watch each one cross
   * the city. Trunks and cones bend more toward the top (local y 0 → 1); a
   * crown moves as a whole. Fallen trees (not upright) stay still.
   */
  swayInWind(mat, crown) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = this.uWind
      sh.uniforms.uTime = this.uTime
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec4 uWind;\nuniform float uTime;').replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  float upright = smoothstep(0.6, 0.95, normalize(instanceMatrix[1].xyz).y);
#else
  float upright = 1.0;
#endif
  float bend = ${crown ? '1.0 + 0.25 * position.y' : 'position.y * position.y'};
  float ph = uTime * (0.9 + uWind.w * 0.05) - dot(mvPosition.xz, uWind.xy) * 0.025;
  float gust = 0.55 + 0.3 * sin(ph) + 0.15 * sin(ph * 2.3 + mvPosition.x * 0.07) + 0.06 * sin(uTime * 9.0 + mvPosition.z * 0.4);
  float d = uWind.z * bend * upright * gust;
  mvPosition.xz += uWind.xy * d;
  mvPosition.y -= 0.15 * d;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`,
      )
    }
    mat.customProgramCacheKey = () => (crown ? 'sway-crown' : 'sway-stem')
  }

  /**
   * Depth lens draped over the land, streets included: dry ground greyed out,
   * standing water coloured by depth band, one cell per texel so each cell
   * reads as one depth. Buildings stand up through it.
   * map: { depth } (per cell, m), with zg (ground per cell) when the water is
   * live — the layer then rides on the water surface instead of sinking
   * under it. null hides it.
   */
  setFloodMap(map) {
    if (!map) {
      if (this.floodLayer) this.floodLayer.visible = false
      return
    }
    const N = GRID
    const V = N + 1
    if (!this.floodLayer) {
      const geo = new THREE.PlaneGeometry(N * CELL, N * CELL, N, N).rotateX(-Math.PI / 2)
      this.floodTexData = new Uint8Array(N * N * 4)
      const tex = new THREE.DataTexture(this.floodTexData, N, N, THREE.RGBAFormat)
      tex.magFilter = THREE.NearestFilter
      tex.minFilter = THREE.NearestFilter
      tex.colorSpace = THREE.SRGBColorSpace
      this.floodTex = tex
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, fog: false })
      this.floodLayer = new THREE.Mesh(geo, mat)
      // after the water, so the depth colours sit on top of it
      this.floodLayer.renderOrder = 3
      this.root.add(this.floodLayer)
    }
    // ground heights at the vertices (cached until the terrain changes)
    if (!this.floodBaseY) {
      this.floodBaseY = new Float32Array(V * V)
      for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) this.floodBaseY[r * V + c] = this.vertexHeight(c, r) + 0.6
    }
    const { depth, zg } = map
    const pos = this.floodLayer.geometry.attributes.position
    const ct = this.city.cellType
    for (let r = 0; r <= N; r++)
      for (let c = 0; c <= N; c++) {
        let y = this.floodBaseY[r * V + c]
        if (zg) {
          // on top of any deep water in the four cells around the vertex
          for (let dj = -1; dj <= 0; dj++)
            for (let di = -1; di <= 0; di++) {
              const i = c + di
              const j = r + dj
              if (i < 0 || j < 0 || i >= N || j >= N) continue
              const k = idx(i, j)
              if (depth[k] > 0.3 && ct[k] !== CELL_RIVER) y = Math.max(y, zg[k] + depth[k] + 0.15)
            }
        }
        pos.setY(r * V + c, y)
      }
    pos.needsUpdate = true
    this.floodLayer.geometry.computeBoundingSphere()
    const px = this.floodTexData
    const grey = [211, 215, 220]
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = idx(i, j)
        const o = ((N - 1 - j) * N + i) * 4
        if (ct[k] === CELL_RIVER) {
          // the channel shows through as itself
          px[o + 3] = 0
          continue
        }
        const col = depthColor(depth[k])
        const c = col ?? grey
        px[o] = c[0]
        px[o + 1] = c[1]
        px[o + 2] = c[2]
        px[o + 3] = col ? 235 : 190
      }
    this.floodTex.needsUpdate = true
    this.floodLayer.visible = true
  }

  /**
   * Name tags pinned over places that matter (hospitals, shelters, pumps…),
   * each with a status badge, kept over their spot as the camera moves.
   * list: [{ key, x, y, z, name, dot, badge, tone }] ('bad' | 'warn' | 'good'), or [] to clear.
   */
  setLabels(list) {
    if (!this.labelLayer) {
      const el = document.createElement('div')
      el.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;font:600 11px/1.2 system-ui,sans-serif'
      this.container.appendChild(el)
      this.labelLayer = el
      this.labels = new Map()
    }
    const keep = new Set()
    for (const L of list) {
      keep.add(L.key)
      let e = this.labels.get(L.key)
      if (!e) {
        const div = document.createElement('div')
        div.style.cssText = 'position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;padding:3px 8px 3px 6px;border-radius:999px;background:rgba(255,255,255,0.94);color:#1e293b;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.35)'
        div.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;flex:none"></span><span></span><span style="font-weight:700"></span>'
        this.labelLayer.appendChild(div)
        e = { div, L: null }
        this.labels.set(L.key, e)
      }
      if (!e.L || e.L.name !== L.name || e.L.badge !== L.badge || e.L.tone !== L.tone || e.L.dot !== L.dot) {
        const [dot, name, badge] = e.div.children
        dot.style.background = L.dot
        name.textContent = L.name
        badge.textContent = L.badge ?? ''
        badge.style.color = L.tone === 'bad' ? '#dc2626' : L.tone === 'warn' ? '#d97706' : '#059669'
      }
      e.L = L
    }
    for (const [k, e] of this.labels)
      if (!keep.has(k)) {
        e.div.remove()
        this.labels.delete(k)
      }
  }

  /**
   * Keep the name tags over their places. Tags that would overlap are
   * stacked upward, bad news first; one that cannot find room is hidden.
   */
  placeLabels() {
    if (!this.labels?.size) return
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    const RANK = { bad: 0, warn: 1, good: 2 }
    const items = []
    for (const e of this.labels.values()) {
      _v.set(e.L.x, e.L.y, e.L.z).project(this.camera)
      if (_v.z > 1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) {
        e.div.style.display = 'none'
        continue
      }
      e.div.style.display = 'flex'
      // measured once per text change (reading layout every frame is slow)
      if (e.wFor !== e.L.badge + e.L.name) {
        e.wFor = e.L.badge + e.L.name
        e.w = e.div.offsetWidth
        e.h = e.div.offsetHeight
      }
      items.push({ e, x: ((_v.x + 1) / 2) * w, y: ((1 - _v.y) / 2) * h, rank: RANK[e.L.tone] ?? 2, depth: _v.z })
    }
    items.sort((a, b) => a.rank - b.rank || a.depth - b.depth)
    const placed = []
    for (const it of items) {
      const { e } = it
      const left = it.x - e.w / 2
      let top = it.y - e.h * 1.2
      let tries = 0
      const hit = () => placed.some((r) => left < r.right && left + e.w > r.left && top < r.bottom && top + e.h > r.top)
      while (hit() && tries < 4) {
        top -= e.h + 3
        tries++
      }
      if (hit()) {
        e.div.style.display = 'none'
        continue
      }
      placed.push({ left, right: left + e.w, top, bottom: top + e.h })
      e.div.style.transform = `translate(${left}px, ${top}px)`
    }
  }

  /** A cloud-to-ground strike at (x, y, z) — or, with no point, a flash inside the clouds. */
  lightning(x, y, z) {
    if (x == null) return this.stormFx.cloudFlash(0.25 + Math.random() * 0.45)
    this.stormFx.strike(x, y, z)
    this.dustBurst(x, y, z, 6, 3)
  }

  /**
   * The tornado on the ground: { T (the vortex, see stormHazards.js), x, z } or null.
   * Windborne debris is sucked into it, and what stands in its core is knocked down.
   */
  setTornado(tor) {
    this.tornado = tor
    this.stormFx.setTornado(tor && { x: tor.x, z: tor.z, y: this.groundAt(tor.x, tor.z), rc: tor.T.rc, hemi: tor.T.hemi, mx: tor.T.mx, mz: tor.T.mz })
    this.debris.windAt = tor
      ? (x, z) => {
          const [wx, wz] = this.windVec ?? [0, 0]
          const d = Math.hypot(x - tor.x, z - tor.z)
          if (d > tor.T.rc * 8) return [wx, wz, 0]
          const v = vortexWind(tor.T, x, z, tor.x, tor.z)
          // the updraught in and around the core lofts what it picks up
          return [wx + v.vx - tor.T.mx, wz + v.vz - tor.T.mz, 30 * Math.exp(-((d / (tor.T.rc * 1.5)) ** 2))]
        }
      : null
  }

  /** Each frame the tornado is down: loose debris near it takes off, and it hits people, cars and poles in its core. */
  updateTornado() {
    const tor = this.tornado
    if (!tor) return
    const R = tor.T.rc * 1.6
    for (const it of this.debris.items) {
      if (it.dead || Math.abs(it.x - tor.x) > R || Math.abs(it.z - tor.z) > R) continue
      it.windborne = true
      it.sleep = false
      it.surf = null
    }
    this.tornadoHitT = (this.tornadoHitT ?? 0) - this.frameDt
    if (this.tornadoHitT > 0) return
    this.tornadoHitT = 0.25
    this.strikeAt(tor.x, tor.z, tor.T.rc * 0.7, 3e4)
  }

  /** Clouds, wind streaks, leaves stripped from the trees and spray blown off the water. */
  updateWeather(dt) {
    const wind = this.windVec ?? [0, 0]
    const c = this.controls.target
    this.clouds.update(dt, { cover: this.cloudCover, wind, center: c, camera: this.camera, tint: this.cloudTint })
    this.streaks.update(dt, wind, c, (x, z) => this.groundAt(x, z), this.nightF ?? 0)
    const sp = Math.hypot(wind[0], wind[1])
    if (sp > 14 && this.city) {
      const k = Math.min(1, (sp - 14) / 30)
      // leaves and twigs, from trees around the view
      const trees = this.city.trees
      for (let n = Math.round(k * 14); n > 0; n--) {
        const t = trees[Math.floor(Math.random() * trees.length)]
        if (!t || t.wx === undefined || t.burnt || Math.abs(t.wx - c.x) > 300 || Math.abs(t.wz - c.z) > 300) continue
        const y = this.groundAt(t.wx, t.wz) + (3 + Math.random() * 5) * t.s
        const brown = Math.random() < 0.35
        const col = brown ? [0.42, 0.33, 0.18, 0.95] : [0.25, 0.42, 0.16, 0.95]
        this.leaves.emit(t.wx + (Math.random() - 0.5) * 3, y, t.wz + (Math.random() - 0.5) * 3, wind[0] * (0.6 + Math.random() * 0.5), 1 + Math.random() * 3, wind[1] * (0.6 + Math.random() * 0.5), 0.7 + Math.random() * 0.6, 0, 2 + Math.random() * 2, col, [col[0], col[1], col[2], 0])
      }
      // spindrift: spray torn off the river and flood water
      const W = this.waterSim
      if (W && sp > 22) {
        for (let n = Math.round(k * 10); n > 0; n--) {
          const i = Math.floor(Math.random() * GRID)
          const j = Math.floor(Math.random() * GRID)
          const kk = idx(i, j)
          if (W.h[kk] < 0.4) continue
          const x = cellToWorld(i) + (Math.random() - 0.5) * CELL
          const z = cellToWorld(j) + (Math.random() - 0.5) * CELL
          if (Math.abs(x - c.x) > 450 || Math.abs(z - c.z) > 450) continue
          const y = W.zg[kk] + W.h[kk] + 0.5
          this.spray.emit(x, y, z, wind[0] * 0.8, 0.5 + Math.random(), wind[1] * 0.8, 4, 9, 1.6 + Math.random(), [0.86, 0.9, 0.94, 0.28 * k], [0.9, 0.93, 0.96, 0])
        }
      }
    }
    this.leaves.update(dt)
    this.spray.update(dt)
  }

  /**
   * Tall props in parks and squares (lamps, goals, hoops, signs) blown over by
   * a 3-s gust (m/s) blowing toward (wx, wz). Each has its own strength, and
   * falls once, the first time its fragility draw comes up.
   */
  windProps(gust, wx, wz) {
    if (!this.propIdx) return
    let changed = 0
    for (const cell of this.propIdx.values()) {
      for (const p of cell) {
        const it = p.it
        if (it.fallen || it.h < 1.5) continue
        it.windMed ??= 44 * (0.85 + 0.3 * Math.random())
        const P = normCdf(Math.log(gust / it.windMed) / 0.2)
        if (P <= (it.windP ?? 0)) continue
        const draw = (P - (it.windP ?? 0)) / (1 - (it.windP ?? 0))
        it.windP = P
        if (Math.random() >= draw) continue
        it.fallen = { ax: wx, az: wz, th: 1.3 + Math.random() * 0.25 }
        p.mesh.setMatrixAt(p.q, this.propMatrix(it))
        p.mesh.instanceMatrix.needsUpdate = true
        changed++
      }
    }
    return changed
  }

  propMatrix(it) {
    _m.makeScale(it.w, it.h, it.d)
    if (it.ry) _m.premultiply(_r.makeRotationY(it.ry))
    if (!it.fallen) return _m.setPosition(it.x, it.y, it.z)
    // rotate about where it stands on the ground
    const g = this.groundAt(it.x, it.z)
    _m.setPosition(0, it.y - g, 0)
    _m.premultiply(_r.makeRotationAxis(_a.set(it.fallen.az, 0, -it.fallen.ax), it.fallen.th))
    _m.elements[12] += it.x
    _m.elements[13] += g
    _m.elements[14] += it.z
    return _m
  }

  /** A piece came to rest; a big one lying across a street blocks it. */
  pieceSettled(x, z, size) {
    if (size < 2.5 || !this.city || Math.abs(x) >= HALF || Math.abs(z) >= HALF) return
    const k = idx(Math.floor((x + HALF) / CELL), Math.floor((z + HALF) / CELL))
    if (this.life.road?.[k]) this.life.block(k)
  }

  /** The pieces of an old pile were recycled: the building keeps a full rubble mound instead. */
  wreckRetired(bid) {
    const b = this.city?.byId.get(bid)
    const a = b && this.anim.get(bid)
    if (!a) return
    const m = clamp(b.height * 0.1, 2.5, 8) * 0.8
    if (a.collapse) a.collapse.mound = m
    if (a.rubble) this.setHeap(b, a, m)
    else a.hScale = clamp(m / b.height, 0.05, 0.6)
    this.updateBuilding(b)
  }

  dustBurst(x, y, z, n, size) {
    for (let q = 0; q < n; q++) {
      const v = 3 + Math.random() * 5
      const ang = Math.random() * Math.PI * 2
      this.dust.emit(x + (Math.random() - 0.5) * size, y, z + (Math.random() - 0.5) * size, Math.cos(ang) * v, 1 + Math.random() * 2, Math.sin(ang) * v, size, size * 0.7, 6 + Math.random() * 5, [0.62, 0.57, 0.5, 0.55], [0.7, 0.66, 0.6, 0])
    }
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
    const hit = this.strikeAt(it.x, it.z, Math.max(it.sx, it.sz) * 0.5, E)
    // people in the street killed by facade and parapet pieces, by the building they fell from
    if (it.facade && hit.killed) this.facadeKills.set(it.src, (this.facadeKills.get(it.src) || 0) + hit.killed)
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

  /**
   * Cladding, glass and masonry shaken loose from tall buildings, and parapets
   * and brick facades off unreinforced masonry of any height (Christchurch 2011).
   * Anchored facades (ties, parapet bracing, glazing film) shed far less.
   */
  shedFacade(b, a, env, dt) {
    if (!sheddingFacade(b) || a.rubble || a.topple) return
    const urm = b.floors < 7
    if (urm && env < 0.25) return
    const rate = env * (urm ? 0.5 : b.floors / 8) * (1 + a.ds * 0.8) * 1.4 * (b.facadeAnchored ? 0.15 : 1)
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
      this.debris.spawn(x + a.ux * a.vis, y, z + a.uz * a.vis, nx * out + a.vx, 0, nz * out + a.vz, size, glass ? 0x9fc0d4 : b.color, { src: b.id, facade: true })
    }
  }

  setEnvironment({ hour = 12, rain = 0, haze = 0, wind = [0, 0], cloud = 0 }) {
    this.cloudCover = cloud
    this.windVec = wind
    this.debris.wind = wind
    const h = ((hour % 24) + 24) % 24
    const elev = Math.sin(((h - 6) / 12) * Math.PI) // -1..1
    const az = ((h - 6) / 12) * Math.PI
    const dayF = clamp(elev * 2.2 + 0.25, 0, 1)
    // a typhoon's cloud deck darkens the sky even between rain bands
    const overcast = clamp(Math.max(rain / 25, Math.hypot(wind[0], wind[1]) / 30, cloud * 0.85), 0, 1)
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
    // the cloud deck: lit grey by day, near-black at night
    this.cloudTint.set(0x4f5762).multiplyScalar(0.3 + 0.7 * dayF)
    // how far the trees bend, and how fast the gusts roll through them
    const sp = Math.hypot(wind[0], wind[1])
    this.uWind.value.set(sp > 0 ? wind[0] / sp : 1, sp > 0 ? wind[1] / sp : 0, clamp((sp - 4) / 40, 0, 1) * 1.8, sp)
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

  /** frozen: the simulation is paused — only the camera moves; everything else holds still. */
  update(dt, frozen = false) {
    if (frozen) {
      this.controls.update()
      this.bld.flush()
      this.placeLabels()
      this.renderer.render(this.scene, this.camera)
      return
    }
    this.realTime += dt
    this.frameDt = dt
    this.uTime.value += dt
    this.controls.update()
    const t = this.realTime
    this.shakes = this.shakes.filter((s) => t - s.t0 < s.dur + 0.1)
    const g = this.groundAccel(t)

    // the river sloshes with the ground and keeps rocking for a while after
    // the shaking stops (a seiche dies away over tens of seconds)
    const Q = this.uQuake.value
    const slosh = clamp(g.env * 2.2, 0, 1.4)
    if (slosh > Q.x) Q.x += (slosh - Q.x) * Math.min(1, dt * 3)
    else Q.x *= Math.exp(-dt / 7)
    const am = Math.hypot(g.ax, g.az)
    if (g.env > 0.002 && am > 1e-4) {
      Q.y += (g.ax / am - Q.y) * Math.min(1, dt * 0.6)
      Q.z += (g.az / am - Q.z) * Math.min(1, dt * 0.6)
      const n = Math.hypot(Q.y, Q.z) || 1
      Q.y /= n
      Q.z /= n
    }

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
        if (!a.rubble && !a.topple && !a.broken) {
          moving = this.stepFrame(b, a, g, sub * h)
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
        const I = a?.burning ?? 1 // growing, fully developed or dying down
        const top = b.base + b.elevated + b.height * (a?.hScale ?? 1)
        const n = Math.min(6, 1 + Math.floor((b.fw * b.fd) / 150))
        for (let q = 0; q < n; q++) {
          if (Math.random() > 0.25 + I * 0.75) continue
          const x = b.cx + (Math.random() - 0.5) * b.fw * 0.9
          const z = b.cz + (Math.random() - 0.5) * b.fd * 0.9
          const y = b.base + Math.random() * (top - b.base) * 0.9 + 1
          if (Math.random() < 0.8) this.fire.emit(x, y, z, 0, 4 + Math.random() * 5, 0, 5 + Math.random() * 5, -2, 0.7 + Math.random() * 0.6, [1, 0.55, 0.15, 0.9], [0.9, 0.2, 0.05, 0])
          if (Math.random() < 0.35) this.smoke.emit(x, top + 2, z, 0, 6 + Math.random() * 4, 0, 8, 9, 6 + Math.random() * 4, [0.15, 0.13, 0.12, 0.6], [0.3, 0.29, 0.28, 0])
        }
      }
    }
    // burning trees, and debris thrown from burning buildings still alight
    for (const tr of this.burningTrees || []) {
      const y = this.groundAt(tr.x, tr.z)
      const s = tr.t.s
      if (Math.random() < 0.5 + (tr.I ?? 1) * 0.5) this.fire.emit(tr.x + (Math.random() - 0.5) * 3 * s, y + (2 + Math.random() * 6) * s, tr.z + (Math.random() - 0.5) * 3 * s, 0, 3 + Math.random() * 3, 0, 3 + Math.random() * 3, -1, 0.5 + Math.random() * 0.5, [1, 0.6, 0.2, 0.9], [0.9, 0.25, 0.05, 0])
      if (Math.random() < 0.15) this.smoke.emit(tr.x, y + 9 * s, tr.z, 0, 4, 0, 6, 7, 5, [0.2, 0.18, 0.16, 0.5], [0.35, 0.34, 0.33, 0])
    }
    for (const it of this.debris.items) {
      if (!(it.burn > 0) || it.dead) continue
      it.burn -= dt
      if (Math.random() < 0.35) this.fire.emit(it.x, it.y + it.sy * 0.5, it.z, 0, 2 + Math.random() * 2, 0, 2 + Math.random() * 2, -1, 0.4 + Math.random() * 0.4, [1, 0.55, 0.15, 0.9], [0.9, 0.2, 0.05, 0])
    }
    this.life.update(dt, { ...this.lifeCtx, shaking: g.env, field: g.field, frac: g.frac, burning: this.burning, burningTrees: this.burningTrees, fireOf: (b) => this.anim.get(b.id)?.burning ?? 0, night: this.nightF })
    this.fire.update(dt)
    this.smoke.update(dt, 3)
    this.dust.update(dt, 1)
    this.updateTornado()
    this.debris.update(dt)
    this.stormFx.update(dt, this.nightF ?? 0)
    this.wreck.update(dt)
    if (this.treesDirty && this.realTime - (this.treesT ?? -1) > 0.4) {
      this.treesT = this.realTime
      this.buildTrees()
    }
    // drops stop on roofs and streets; in cut-away view it only rains over the block
    this.rain.update(dt, this.rainIntensity || 0, this.controls.target, (x, z) => this.surfaceAt(x, z).y, this.subsurface.group.visible ? HALF - 2 : 0, this.windVec)
    this.updateWeather(dt)
    this.bld.flush()
    this.placeLabels()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * A building's frame as a shear building: storey masses on springs (the
   * columns) and dampers, each band of storeys one lumped mass. The ground
   * acceleration drives the base. Its first natural period is the building's
   * (ASCE 7 approximate period), so short stiff buildings snap back and forth
   * in fast, jerky shaking and tall towers swing in slow, rolling shaking;
   * higher modes give the S-shaped whip of a tall frame. Damage softens the
   * columns: a cracked frame sways slower and further.
   */
  frameOf(b, a) {
    if (a.fr) return a.fr
    const n = clamp(Math.round(b.floors / 4), 1, 5)
    const w1 = (2 * Math.PI) / buildingPeriod(b)
    // uniform shear building: ω₁ = 2√(k/m)·sin(π / (2(2n+1)))
    const kappa = (w1 / (2 * Math.sin(Math.PI / (2 * (2 * n + 1))))) ** 2
    a.fr = { n, kappa, w1, wMax: 2 * Math.sqrt(kappa), ux: new Float32Array(n), uz: new Float32Array(n), vx: new Float32Array(n), vz: new Float32Array(n), drift: 0 }
    return a.fr
  }

  /** Advance b's frame by dt under ground acceleration g; returns whether it is still moving. */
  stepFrame(b, a, g, dt) {
    const fr = this.frameOf(b, a)
    const { n, ux, uz, vx, vz } = fr
    // cracked columns lose stiffness (period lengthens by ~40 % at heavy damage)
    const soft = 1 - 0.12 * Math.min(a.ds, 4)
    const kappa = fr.kappa * soft * soft
    // stiffness-proportional damping: 5 % in the first mode, more in the higher ones
    const beta = (2 * 0.05) / (fr.w1 * soft)
    const sub = Math.max(1, Math.ceil((dt * fr.wMax) / 0.7))
    const h = dt / sub
    for (let s = 0; s < sub; s++) {
      // storey shear per unit mass: f_i = κ(u_i − u_{i−1}) + βκ(v_i − v_{i−1})
      let fxBelow = 0
      let fzBelow = 0
      for (let i = 0; i < n; i++) {
        const fx = kappa * (ux[i] - (i ? ux[i - 1] : 0) + beta * (vx[i] - (i ? vx[i - 1] : 0)))
        const fz = kappa * (uz[i] - (i ? uz[i - 1] : 0) + beta * (vz[i] - (i ? vz[i - 1] : 0)))
        if (i) {
          vx[i - 1] += (-g.ax - fxBelow + fx) * h
          vz[i - 1] += (-g.az - fzBelow + fz) * h
        }
        fxBelow = fx
        fzBelow = fz
      }
      vx[n - 1] += (-g.ax - fxBelow) * h
      vz[n - 1] += (-g.az - fzBelow) * h
      for (let i = 0; i < n; i++) {
        ux[i] += vx[i] * h
        uz[i] += vz[i] * h
      }
    }
    // storey drift: what cracks the columns (kept to what a frame can take before it goes)
    const dh = b.height / n
    const lim = dh * 0.015
    let drift = 0
    let moving = false
    for (let i = 0; i < n; i++) {
      const bx = i ? ux[i - 1] : 0
      const bz = i ? uz[i - 1] : 0
      ux[i] = bx + clamp(ux[i] - bx, -lim, lim)
      uz[i] = bz + clamp(uz[i] - bz, -lim, lim)
      drift = Math.max(drift, Math.hypot(ux[i] - bx, uz[i] - bz) / dh)
      if (Math.abs(vx[i]) + Math.abs(vz[i]) > 0.003 || Math.abs(ux[i]) + Math.abs(uz[i]) > 0.003) moving = true
    }
    fr.drift = drift
    a.ux = ux[n - 1]
    a.uz = uz[n - 1]
    a.vx = vx[n - 1]
    a.vz = vz[n - 1]
    // displacement at mid-height, between the lumped masses (the base is fixed)
    const f = n / 2 - 1
    const i0 = Math.floor(f)
    const t = f - i0
    const at = (u, i) => (i < 0 ? 0 : u[i])
    a.mx = at(ux, i0) * (1 - t) + at(ux, i0 + 1) * t
    a.mz = at(uz, i0) * (1 - t) + at(uz, i0 + 1) * t
    return moving
  }

  spawnDebris(b, hFrac) {
    const top = b.base + b.elevated + b.height * hFrac
    const x = b.cx + (Math.random() - 0.5) * b.fw
    const z = b.cz + (Math.random() - 0.5) * b.fd
    const y = b.base + Math.random() * (top - b.base)
    const out = 2 + Math.random() * 5
    const ang = Math.random() * Math.PI * 2
    const size = clamp(Math.sqrt(b.fw * b.fd) * (0.05 + Math.random() * 0.1), 0.6, 4)
    // a building that was on fire throws out debris that is still burning
    const burn = (this.anim.get(b.id)?.burning ?? 0) > 0.15 && Math.random() < 0.4 ? 15 + Math.random() * 45 : 0
    this.debris.spawn(x, y, z, Math.cos(ang) * out, Math.random() * 3, Math.sin(ang) * out, size, burn ? 0x2a2420 : Math.random() < 0.3 ? 0x56524c : b.color, { src: b.id, burn })
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
    this.wreck.dispose()
    this.bld.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
