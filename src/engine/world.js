// Three.js scene: terrain, buildings, water surface, props and effects.
import * as THREE from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { GRID, CELL, CELL_ROAD, CELL_RIVER, CELL_BANK, CELL_PARK, CELL_POND, CELL_GRASS, BUILDING_TYPES, CITY_TYPES, RIVER_HALF_WIDTH } from './config.js'
import { idx, cellToWorld } from './cityGen.js'
import { makeNoise2D, clamp, lerp } from './math.js'
import { Particles, Debris, Rain } from './effects.js'

const HALF = (GRID * CELL) / 2
const PX = 16 // texture pixels per cell
const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _c = new THREE.Color()
const _v = new THREE.Vector3()

function gableGeometry() {
  // ridge along X, footprint 1×1, height 1
  const p = [
    // slopes
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0, -0.5, 0, 0.5, 0.5, 1, 0, -0.5, 1, 0,
    0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, -0.5, 1, 0, 0.5, 1, 0,
    // gable ends
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
    scene.fog = new THREE.Fog(0x9fb8cf, 900, 3200)
    const camera = new THREE.PerspectiveCamera(48, 1, 1, 9000)
    camera.position.set(-520, 520, 620)
    this.camera = camera
    const controls = new MapControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = 1.38
    controls.minDistance = 25
    controls.maxDistance = 1900
    controls.screenSpacePanning = false
    controls.zoomToCursor = true
    this.controls = controls

    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 1.0)
    scene.add(this.hemi)
    const sun = new THREE.DirectionalLight(0xffffff, 2.4)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const sc = sun.shadow.camera
    sc.left = -640
    sc.right = 640
    sc.top = 640
    sc.bottom = -640
    sc.near = 50
    sc.far = 2600
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.6
    scene.add(sun)
    scene.add(sun.target)
    this.sun = sun

    this.uNight = { value: 0 }
    // soft studio environment for reflections on water and glass only
    const pmrem = new THREE.PMREMGenerator(renderer)
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.root = new THREE.Group()
    scene.add(this.root)

    // outer landscape so the district doesn't float in a void
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: 0x55703f, roughness: 1 }))
    outer.rotation.x = -Math.PI / 2
    outer.position.y = 4
    outer.receiveShadow = true
    scene.add(outer)
    this.outer = outer

    this.fire = new Particles(scene, 2500, true)
    this.smoke = new Particles(scene, 3500, false)
    this.dust = new Particles(scene, 3000, false)
    this.debris = new Debris(scene, 3000)
    this.debris.groundAt = (x, z) => this.groundAt(x, z)
    this.rain = new Rain(scene)

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

    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ------------------------------------------------------------------ city
  buildCity(city) {
    this.city = city
    for (const c of [...this.root.children]) {
      this.root.remove(c)
      c.traverse?.((o) => {
        o.geometry?.dispose()
        if (o.material && o.material !== this.waterMat) o.material.dispose?.()
      })
    }
    this.anim.clear()
    this.shakes = []
    this.fire.clear()
    this.smoke.clear()
    this.dust.clear()
    this.debris.clear()
    this.noise = makeNoise2D(city.seed + 99)
    let zmin = Infinity
    for (let k = 0; k < city.z.length; k++) zmin = Math.min(zmin, city.z[k])
    this.outer.position.y = zmin + 1.5
    this.buildTerrain()
    this.buildWater()
    this.buildTrees()
    this.rebuildBuildings()
    this.rebuildStatic()
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
    this.paintTerrain()
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }))
    mesh.receiveShadow = true
    this.terrain = mesh
    this.root.add(mesh)

    // skirt walls around the edge
    const skirt = new THREE.Group()
    const mat = new THREE.MeshStandardMaterial({ color: 0x5b4a36, roughness: 1 })
    const bottom = this.outer.position.y - 0.5
    for (let s = 0; s < 4; s++) {
      const pts = []
      for (let t = 0; t <= GRID; t++) {
        const [vi, vj] = s === 0 ? [t, 0] : s === 1 ? [GRID, t] : s === 2 ? [GRID - t, GRID] : [0, GRID - t]
        pts.push([-HALF + vi * CELL, this.vertexHeight(vi, vj), -HALF + vj * CELL])
      }
      const pos = []
      for (let t = 0; t < GRID; t++) {
        const [a, b] = [pts[t], pts[t + 1]]
        pos.push(a[0], a[1], a[2], a[0], bottom, a[2], b[0], b[1], b[2], b[0], b[1], b[2], a[0], bottom, a[2], b[0], bottom, b[2])
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      geo.computeVertexNormals()
      skirt.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5b4a36, roughness: 1, side: THREE.DoubleSide })))
    }
    mat.dispose()
    this.root.add(skirt)
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
  }

  paintTerrain() {
    const { city, noise } = this
    const ctx = this.terrainCanvas.getContext('2d')
    const P = CITY_TYPES[city.type]
    const fieldCols = ['#7d9a4a', '#8fa356', '#a39c5a', '#6f8f43', '#94a862', '#b3a46a']
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const k = idx(i, j)
        const t = city.cellType[k]
        const n = noise.fbm(i * 0.2, j * 0.2, 2)
        let col
        if (t === CELL_ROAD) col = '#3b3e44'
        else if (t === CELL_RIVER) col = '#5d4f38'
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
        if (t === CELL_GRASS && city.type === 'rural' && Math.hypot(i - city.center.i, j - city.center.j) > P.radius * 1.05) {
          ctx.fillStyle = 'rgba(0,0,0,0.06)'
          for (let r = 0; r < PX; r += 4) ctx.fillRect(i * PX, j * PX + r, PX, 1)
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
        if (d < hw) ctx.fillStyle = d < hw * 0.6 ? '#4f4433' : '#5d4f38'
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
      }
    }
    // road details
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
        ctx.fillStyle = '#a8a69e'
        if (!U) ctx.fillRect(x, y, PX, 2)
        if (!D) ctx.fillRect(x, y + PX - 2, PX, 2)
        if (!L) ctx.fillRect(x, y, 2, PX)
        if (!R) ctx.fillRect(x + PX - 2, y, 2, PX)
        ctx.fillStyle = '#d9c35a'
        if ((L || R) && !U && !D) ctx.fillRect(x + 2, y + PX / 2 - 0.5, PX / 2 - 3, 1)
        else if ((U || D) && !L && !R) ctx.fillRect(x + PX / 2 - 0.5, y + 2, 1, PX / 2 - 3)
        else if (L && R && U && D) {
          ctx.fillStyle = 'rgba(230,230,230,0.6)'
          for (let s = 3; s < PX - 2; s += 3) ctx.fillRect(x + s, y + 1, 1.5, 2)
        }
      }
    // levee footprints
    for (let k = 0; k < GRID * GRID; k++)
      if (city.levee[k] > 0) {
        ctx.fillStyle = '#6d6047'
        ctx.fillRect((k % GRID) * PX, Math.floor(k / GRID) * PX, PX, PX)
      }
    this.terrainTex.needsUpdate = true
  }

  buildWater() {
    const g = this.gridGeometry()
    const V = GRID + 1
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * V * 3), 3))
    this.waterGeo = g
    this.waterMat = this.waterMat || new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.84, roughness: 0.06, metalness: 0.0, envMap: this.envMap, envMapIntensity: 0.9 })
    const mesh = new THREE.Mesh(g, this.waterMat)
    mesh.receiveShadow = true
    mesh.renderOrder = 2
    this.water = mesh
    this.root.add(mesh)
    this.waterVisible = false
  }

  /** h: water depth per cell; zg: bed elevation incl. levees */
  updateWater(h, zg) {
    const g = this.waterGeo
    const pos = g.attributes.position.array
    const col = g.attributes.color.array
    const V = GRID + 1
    const ct = this.city.cellType
    for (let vj = 0; vj < V; vj++)
      for (let vi = 0; vi < V; vi++) {
        let s = 0
        let n = 0
        let dsum = 0
        let flood = 0
        for (let dj = -1; dj <= 0; dj++)
          for (let di = -1; di <= 0; di++) {
            const i = vi + di
            const j = vj + dj
            if (i < 0 || j < 0 || i >= GRID || j >= GRID) continue
            const k = j * GRID + i
            if (h[k] > 0.04) {
              s += zg[k] + h[k]
              dsum += h[k]
              n++
              if (ct[k] !== CELL_RIVER) flood++
            }
          }
        const v = vj * V + vi
        if (n) {
          pos[v * 3 + 1] = s / n + 0.05
          const d = dsum / n
          const f = flood / n
          // river teal-brown → muddy flood brown, darker when deep
          const dk = clamp(1 - d / 8, 0.45, 1)
          col[v * 3] = lerp(0.2, 0.5, f) * dk
          col[v * 3 + 1] = lerp(0.36, 0.42, f) * dk
          col[v * 3 + 2] = lerp(0.42, 0.3, f) * dk
        } else {
          pos[v * 3 + 1] = this.vertexHeight(vi, vj) - 0.8
        }
      }
    g.attributes.position.needsUpdate = true
    g.attributes.color.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
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
    const crownGeo = new THREE.IcosahedronGeometry(1, 0)
    const coneGeo = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0)
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
  makeBuildingMaterial() {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.04, envMap: this.envMap, envMapIntensity: 0.35 })
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = this.uNight
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aInfo;\nvarying vec4 vInfo;\nvarying vec3 vLocal;\nvarying vec3 vONormal;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vInfo = aInfo;
          vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vLocal = position * sc; vONormal = normal;`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying vec4 vInfo;\nvarying vec3 vLocal;\nvarying vec3 vONormal;\nfloat gWin = 0.0; float gLit = 0.0;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          if (vInfo.y > 0.5 && abs(vONormal.y) < 0.5) {
            float fh = vInfo.x;
            float horiz = abs(vONormal.x) > 0.5 ? vLocal.z : vLocal.x;
            float spacing = vInfo.y > 2.5 ? 1.5 : (vInfo.y > 1.5 ? 2.1 : 2.8);
            float cx = horiz / spacing + 0.5;
            float cy = vLocal.y / fh;
            float fx = fract(cx); float fy = fract(cy);
            float wf = vInfo.y > 2.5 ? 0.88 : (vInfo.y > 1.5 ? 0.7 : 0.5);
            gWin = step(0.5 - wf * 0.5, fx) * step(fx, 0.5 + wf * 0.5) * step(0.3, fy) * step(fy, 0.86);
            if (vLocal.y < 0.6) gWin = 0.0;
            float rnd = fract(sin(dot(floor(vec2(cx, cy)) + vInfo.z * vec2(17.0, 31.0) + vONormal.xz * 3.1, vec2(12.9898, 78.233))) * 43758.5453);
            gLit = step(0.5, rnd) * gWin;
            vec3 glass = vInfo.y > 2.5 ? vec3(0.30, 0.40, 0.50) : vec3(0.16, 0.19, 0.23);
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, gWin * 0.92);
          }`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, gWin);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gLit * uNight * vInfo.w * vec3(1.0, 0.78, 0.46) * 1.3;')
    }
    return mat
  }

  rebuildBuildings() {
    const { city } = this
    for (const m of [this.bMesh, this.roofMesh, this.unitMesh]) {
      if (!m) continue
      this.root.remove(m)
      m.geometry.dispose()
      m.material.dispose()
    }
    for (const s of this.iconSprites || []) this.root.remove(s)
    const list = city.buildings.filter((b) => !b.removed)
    this.bList = list
    this.bIndex = new Map(list.map((b, i) => [b.id, i]))
    const n = Math.max(1, list.length)
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
    const info = new Float32Array(n * 4)
    list.forEach((b, i) => {
      const T = BUILDING_TYPES[b.type]
      info.set([b.floorH, T.windows, b.seed * 10, 1], i * 4)
    })
    this.bInfo = new THREE.InstancedBufferAttribute(info, 4)
    geo.setAttribute('aInfo', this.bInfo)
    const mesh = new THREE.InstancedMesh(geo, this.makeBuildingMaterial(), n)
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

  composeBuilding(b, out) {
    const a = this.anim.get(b.id)
    let fw = b.fw
    let fd = b.fd
    let H = b.height
    let dx = 0
    let dz = 0
    let tx = 0
    let tz = 0
    if (a) {
      H *= a.hScale
      fw *= a.spread
      fd *= a.spread
      dx = a.ux * a.vis
      dz = a.uz * a.vis
      tx = a.tiltX
      tz = a.tiltZ
    }
    out.set(fw, dx, 0, 0, 0, H, 0, 0, 0, dz, fd, 0, 0, 0, 0, 1)
    if (tx || tz) {
      _r.makeRotationFromEuler(new THREE.Euler(tx, 0, tz))
      out.premultiply(_r)
    }
    out.elements[12] = b.cx
    out.elements[13] = b.base + b.elevated
    out.elements[14] = b.cz
    return { H, dx, dz, tx, tz }
  }

  updateBuilding(b) {
    const i = this.bIndex.get(b.id)
    if (i === undefined) return
    const r = this.composeBuilding(b, _m)
    this.bMesh.setMatrixAt(i, _m)
    const a = this.anim.get(b.id)
    const gone = a && a.hScale < 0.5
    const top = b.base + b.elevated + r.H
    const ri = this.roofIndex.get(b.id) ?? -1
    if (ri >= 0) {
      const along = b.fw >= b.fd
      const rh = Math.min(b.fw, b.fd) * 0.32
      if (gone) _m.makeScale(0, 0, 0)
      else {
        _m.makeScale((along ? b.fw : b.fd) * 1.08, rh, (along ? b.fd : b.fw) * 1.1)
        if (!along) _m.premultiply(_r.makeRotationY(Math.PI / 2))
        if (r.tx || r.tz) _m.premultiply(_r.makeRotationFromEuler(new THREE.Euler(r.tx, 0, r.tz)))
        _v.set(r.dx, r.H, r.dz)
        if (r.tx || r.tz) _v.applyEuler(new THREE.Euler(r.tx, 0, r.tz))
        _m.setPosition(b.cx + _v.x, b.base + b.elevated + _v.y, b.cz + _v.z)
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
        _m.setPosition(b.cx + r.dx + (b.seed - 0.5) * b.fw * 0.3, top, b.cz + r.dz)
      }
      this.unitMesh.setMatrixAt(ui, _m)
      this.unitMesh.instanceMatrix.needsUpdate = true
    }
    this.bMesh.instanceMatrix.needsUpdate = true
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
      info[i * 4 + 3] = a && (a.rubble || a.burnt || a.ds >= 3 || a.dark) ? 0 : 1
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
      if (city.bridge[k]) {
        const y = city.bankZ[j] + 0.7
        items.push({ x: cellToWorld(i), z: cellToWorld(j), y: y - 1.2, sx: CELL + 0.2, sz: CELL * 0.92, sy: 1.2, c: 0x77736b })
        items.push({ x: cellToWorld(i), z: cellToWorld(j) - CELL * 0.44, y, sx: CELL, sz: 0.4, sy: 1.1, c: 0xb0aca0 })
        items.push({ x: cellToWorld(i), z: cellToWorld(j) + CELL * 0.44, y, sx: CELL, sz: 0.4, sy: 1.1, c: 0xb0aca0 })
        if (i % 2 === 0) items.push({ x: cellToWorld(i), z: cellToWorld(j), y: city.z[k] - 1, sx: 1.6, sz: 1.6, sy: y - city.z[k], c: 0x6b675f })
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
      _m.makeScale(it.sx, it.sy, it.sz).setPosition(it.x, it.y, it.z)
      mesh.setMatrixAt(q, _m)
      mesh.setColorAt(q, _c.set(it.c))
    })
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.staticMesh = mesh
    this.root.add(mesh)
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
    this.controls.target.set(x, 10, z)
    const dir = new THREE.Vector3(-0.55, 0.62, 0.56).normalize()
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist)
    this.controls.update()
  }

  // -------------------------------------------------------------- effects
  /** Queue ground shaking. pga in g, realDur in seconds of real time. */
  addShake(pga, realDur, M) {
    const freqs = []
    const lowF = clamp(1.4 - (M - 5) * 0.25, 0.25, 1.4)
    for (let k = 0; k < 5; k++) freqs.push({ f: lowF * (1 + k * 0.8 + Math.random() * 0.5), px: Math.random() * 6.28, pz: Math.random() * 6.28 })
    this.shakes.push({ t0: this.realTime, dur: realDur, pga, freqs })
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
        sx += Math.sin(6.283 * f.f * tau + f.px)
        sz += Math.sin(6.283 * f.f * tau + f.pz)
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
      const T = clamp(0.1 * b.floors, 0.15, 6)
      a = { ux: 0, uz: 0, vx: 0, vz: 0, w: (2 * Math.PI) / T, vis: 3, hScale: 1, spread: 1, tiltX: 0, tiltZ: 0, ds: 0, active: false }
      this.anim.set(b.id, a)
    }
    return a
  }

  /** Start a collapse after `delay` seconds of real time. */
  collapse(b, delay = 0, style = 'quake') {
    const a = this.animFor(b)
    if (a.collapse) return
    a.collapse = { t0: this.realTime + delay, dur: 1.6 + Math.random() * 1.6 + b.floors * 0.04, dirX: (Math.random() - 0.5) * 0.5, dirZ: (Math.random() - 0.5) * 0.5, spawned: 0, style }
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

  setEnvironment({ hour = 12, rain = 0, haze = 0 }) {
    const h = ((hour % 24) + 24) % 24
    const elev = Math.sin(((h - 6) / 12) * Math.PI) // -1..1
    const az = ((h - 6) / 12) * Math.PI
    const dayF = clamp(elev * 2.2 + 0.25, 0, 1)
    const overcast = clamp(rain / 25, 0, 1)
    this.uNight.value = clamp(1 - dayF * 1.4, 0, 1) + overcast * 0.25
    const sunDir = new THREE.Vector3(Math.cos(az) * 0.8, Math.max(0.15, elev), 0.45 + Math.sin(az) * 0.2).normalize()
    this.sun.position.copy(sunDir).multiplyScalar(1400)
    const warm = clamp(1 - Math.abs(elev) * 3, 0, 1) * dayF
    const sunCol = new THREE.Color(0.55, 0.65, 0.95).lerp(new THREE.Color(1, 0.97, 0.92), dayF).lerp(new THREE.Color(1, 0.62, 0.35), warm)
    this.sun.color.copy(sunCol)
    this.sun.intensity = lerp(0.6, 2.5, dayF) * (1 - overcast * 0.6) // moonlight keeps the night readable
    this.hemi.intensity = lerp(0.75, 1.0, dayF) * (1 - overcast * 0.2)
    this.hemi.color.set(0xdfeeff).lerp(new THREE.Color(0x8ea6d8), 1 - dayF)
    const daySky = new THREE.Color(0x9cc1e3).lerp(new THREE.Color(0x7b8590), overcast)
    const nightSky = new THREE.Color(0x1b2640)
    const sky = nightSky.clone().lerp(daySky, dayF).lerp(new THREE.Color(0xe7a072), warm * 0.4 * (1 - overcast))
    if (haze) sky.lerp(new THREE.Color(0x9c8d78), haze)
    this.scene.background = sky
    this.scene.fog.color.copy(sky)
    this.scene.fog.near = lerp(900, 220, Math.max(overcast, haze * 0.8))
    this.scene.fog.far = lerp(3400, 1300, Math.max(overcast, haze * 0.6))
    this.rainIntensity = rain
  }

  update(dt) {
    this.realTime += dt
    this.controls.update()
    const t = this.realTime
    this.shakes = this.shakes.filter((s) => t - s.t0 < s.dur + 0.1)
    const g = this.groundAccel(t)

    // camera shake
    this.camera.position.sub(this.camShake)
    this.camShake.set(0, 0, 0)
    if (g.env > 0.005) {
      const k = Math.min(3, g.env * 6)
      this.camShake.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k * 0.6, (Math.random() - 0.5) * k)
      this.camera.position.add(this.camShake)
    }

    // building response: damped SDOF oscillators + collapses
    let colorDirty = false
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
        if (!a.rubble) {
          const gx = g
          for (let s = 0; s < sub; s++) {
            const w = a.w
            const axx = -gx.ax - 2 * 0.05 * w * a.vx - w * w * a.ux
            const azz = -gx.az - 2 * 0.05 * w * a.vz - w * w * a.uz
            a.vx += axx * h
            a.vz += azz * h
            a.ux += a.vx * h
            a.uz += a.vz * h
          }
          const drift = Math.hypot(a.ux, a.uz)
          a.ux = clamp(a.ux, -b.height * 0.02, b.height * 0.02)
          a.uz = clamp(a.uz, -b.height * 0.02, b.height * 0.02)
          moving = drift > 0.002 || Math.hypot(a.vx, a.vz) > 0.002
        }
        if (a.collapse && t >= a.collapse.t0 && !a.rubble) {
          const c = a.collapse
          const p = clamp((t - c.t0) / c.dur, 0, 1)
          const e = p * p
          const rub = clamp(clamp(b.height * 0.12, 2.5, 9) / b.height, 0.06, 0.6)
          a.hScale = 1 - (1 - rub) * e
          a.spread = 1 + 0.18 * e
          a.tiltX = c.dirX * e
          a.tiltZ = c.dirZ * e
          const target = Math.min(140, Math.round(b.area / 120) + 15)
          const want = Math.floor(target * Math.min(1, p * 1.3))
          for (; c.spawned < want; c.spawned++) this.spawnDebris(b, a, 1 - e)
          if (p > 0.05 && Math.random() < 0.7) this.spawnDust(b, c.style === 'flood' ? 0.3 : 1)
          if (p >= 1) {
            a.rubble = true
            a.ux = a.uz = a.vx = a.vz = 0
            colorDirty = true
            for (let q = 0; q < 25; q++) this.spawnDust(b, c.style === 'flood' ? 0.3 : 1.5)
          }
          moving = true
        }
        this.updateBuilding(b)
        if (!moving && !shaking) a.active = false
      }
    }
    if (colorDirty) this.refreshColors()

    // fire & smoke from burning buildings
    if (this.burning && this.burning.length) {
      for (const b of this.burning) {
        const a = this.anim.get(b.id)
        const top = b.base + b.elevated + b.height * (a?.hScale ?? 1)
        const n = Math.min(6, 1 + Math.floor(b.fw * b.fd / 150))
        for (let q = 0; q < n; q++) {
          const x = b.cx + (Math.random() - 0.5) * b.fw * 0.9
          const z = b.cz + (Math.random() - 0.5) * b.fd * 0.9
          const y = b.base + Math.random() * (top - b.base) * 0.9 + 1
          if (Math.random() < 0.8) this.fire.emit(x, y, z, 0, 4 + Math.random() * 5, 0, 5 + Math.random() * 5, -2, 0.7 + Math.random() * 0.6, [1, 0.55, 0.15, 0.9], [0.9, 0.2, 0.05, 0])
          if (Math.random() < 0.35) this.smoke.emit(x, top + 2, z, 0, 6 + Math.random() * 4, 0, 8, 9, 6 + Math.random() * 4, [0.15, 0.13, 0.12, 0.6], [0.3, 0.29, 0.28, 0])
        }
      }
    }
    this.fire.update(dt)
    this.smoke.update(dt, 3)
    this.dust.update(dt, 1)
    this.debris.update(dt)
    this.rain.update(dt, this.rainIntensity || 0, this.controls.target)
    this.renderer.render(this.scene, this.camera)
  }

  spawnDebris(b, a, hFrac) {
    const top = b.base + b.elevated + b.height * hFrac
    const x = b.cx + (Math.random() - 0.5) * b.fw
    const z = b.cz + (Math.random() - 0.5) * b.fd
    const y = b.base + Math.random() * (top - b.base)
    const out = 2 + Math.random() * 5
    const ang = Math.random() * Math.PI * 2
    const size = clamp(Math.sqrt(b.fw * b.fd) * (0.05 + Math.random() * 0.1), 0.6, 4)
    this.debris.spawn(x, y, z, Math.cos(ang) * out, Math.random() * 3, Math.sin(ang) * out, size, Math.random() < 0.3 ? 0x56524c : b.color)
  }

  spawnDust(b, k = 1) {
    const x = b.cx + (Math.random() - 0.5) * b.fw * 1.3
    const z = b.cz + (Math.random() - 0.5) * b.fd * 1.3
    const y = b.base + Math.random() * 6
    const v = 3 + Math.random() * 4
    const ang = Math.random() * Math.PI * 2
    this.dust.emit(x, y, z, Math.cos(ang) * v, 1 + Math.random() * 2, Math.sin(ang) * v, 8 * k, 6 * k, 5 + Math.random() * 5, [0.62, 0.57, 0.5, 0.55], [0.7, 0.66, 0.6, 0])
  }

  dispose() {
    this.ro.disconnect()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

