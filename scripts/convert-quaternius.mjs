// Converts Quaternius CC0 FBX models (https://quaternius.com) into compact,
// instancing-ready binaries for MetroRisk.
//
//   node scripts/convert-quaternius.mjs <input dir> [output dir]
//
// <input dir> holds cars/, transport/, men/ and women/ with the FBX files from
// the Cars, Public Transport, Animated Men and Animated Women packs.
// Output (default public/models/quaternius): one .bin per model + manifest.json.
//
// Vehicles: materials are baked into vertex colours, the model is turned to
// face +x and scaled to real-world length; body paint is flagged so the game
// can recolour it. People: simplified to a few thousand vertices, and the rig
// is converted to rigid limbs (aPart) with hip/shoulder pivots (aPivot) so
// thousands can walk with a vertex shader instead of skeletons.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

globalThis.self = globalThis // FBXLoader expects a browser-ish global
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const T = (p) => 'file:///' + path.join(root, 'node_modules/three', p).replace(/\\/g, '/')
const THREE = await import(T('build/three.module.js'))
const { FBXLoader } = await import(T('examples/jsm/loaders/FBXLoader.js'))
const { mergeGeometries, mergeVertices } = await import(T('examples/jsm/utils/BufferGeometryUtils.js'))
const { SimplifyModifier } = await import(T('examples/jsm/modifiers/SimplifyModifier.js'))

const input = process.argv[2]
const output = process.argv[3] || path.join(root, 'public/models/quaternius')
if (!input) {
  console.error('usage: node scripts/convert-quaternius.mjs <input dir> [output dir]')
  process.exit(1)
}

// real lengths (m); paint: whether the body colour may be varied in game
const VEHICLES = {
  'cars/NormalCar1': { name: 'sedan', length: 4.6, paint: true },
  'cars/NormalCar2': { name: 'hatch', length: 4.3, paint: true },
  'cars/SportsCar': { name: 'sports', length: 4.5, paint: true },
  'cars/SportsCar2': { name: 'sports2', length: 4.5, paint: true },
  'cars/SUV': { name: 'suv', length: 4.8, paint: true },
  'cars/Taxi': { name: 'taxi', length: 4.7, paint: false },
  'cars/Cop': { name: 'police', length: 4.9, paint: false },
  'transport/Ambulance': { name: 'ambulance', length: 6.2, width: 2.2, paint: false },
  'transport/Bus': { name: 'bus', length: 12, width: 2.5, paint: false },
  'transport/SchoolBus': { name: 'schoolbus', length: 11, width: 2.5, paint: false },
}
const PEOPLE = [
  'men/Smooth_Male_Casual',
  'men/Smooth_Male_LongSleeve',
  'men/Smooth_Male_Shirt',
  'men/Smooth_Male_Suit',
  'women/Smooth_Female_Alternative',
  'women/Smooth_Female_Casual',
  'women/Smooth_Female_Dress',
  'women/Smooth_Female_TankTop',
]
// some packs leave every material white: colour them by name
const NAMED = {
  White: '#f1f1ef',
  Red: '#c62828',
  Windows: '#16202a',
  Bumper: '#2b2b2d',
  Lights: '#ffe7a6',
  Grey: '#80868c',
  Yellow: '#f2b705',
  Details: '#3a3c40',
  Bottom: '#1f5aa6',
  Top: '#eef0f1',
  Material: '#1a1a1b',
  Wheel: '#1a1a1b',
}
const NOT_PAINT = /window|black|grey|gray|light|bumper|detail|wheel|material|orange|tyre|tire|rim/i

function parse(file) {
  const buf = fs.readFileSync(file)
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
  obj.updateMatrixWorld(true)
  return obj
}

/** Geometry in world space with per-vertex colour (+ paint flag, material name per vertex). */
function bake(mesh, { paintable }) {
  let g = mesh.geometry.clone()
  if (g.index) g = g.toNonIndexed()
  g.applyMatrix4(mesh.matrixWorld)
  const n = g.attributes.position.count
  const col = new Float32Array(n * 3)
  const paint = new Float32Array(n)
  const matName = new Array(n)
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }]
  const c = new THREE.Color()
  for (const gr of groups) {
    const m = mats[gr.materialIndex] || mats[0]
    const name = (m.name || '').replace(/\.\d+$/, '')
    const white = m.color && m.color.r > 0.99 && m.color.g > 0.99 && m.color.b > 0.99
    if (white && NAMED[name]) c.set(NAMED[name])
    else c.copy(m.color || c.set('#cccccc'))
    const isPaint = paintable && !NOT_PAINT.test(name) && !/wheel/i.test(mesh.name)
    for (let v = gr.start; v < gr.start + gr.count && v < n; v++) {
      if (isPaint) col.set([1, 1, 1], v * 3)
      else col.set([c.r, c.g, c.b], v * 3)
      paint[v] = isPaint ? 1 : 0
      matName[v] = name
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  g.setAttribute('aPaint', new THREE.BufferAttribute(paint, 1))
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'aPaint', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k)
  g.clearGroups()
  return { g, matName }
}

function centroid(g, pred) {
  const p = g.attributes.position
  const s = new THREE.Vector3()
  let n = 0
  for (let i = 0; i < p.count; i++)
    if (pred(i)) {
      s.x += p.getX(i)
      s.y += p.getY(i)
      s.z += p.getZ(i)
      n++
    }
  return n ? s.divideScalar(n) : null
}

function write(name, geo, attrs, meta, manifest) {
  geo = mergeVertices(geo, 1e-4)
  const index = geo.index.array
  const count = geo.attributes.position.count
  const chunks = []
  const layout = {}
  let offset = 0
  for (const a of attrs) {
    const arr = new Float32Array(geo.attributes[a].array)
    layout[a] = { offset, itemSize: geo.attributes[a].itemSize }
    chunks.push(Buffer.from(arr.buffer))
    offset += arr.byteLength
  }
  const idx = count < 65536 ? new Uint16Array(index) : new Uint32Array(index)
  layout.index = { offset, type: idx instanceof Uint16Array ? 'u16' : 'u32', count: idx.length }
  chunks.push(Buffer.from(idx.buffer))
  fs.writeFileSync(path.join(output, `${name}.bin`), Buffer.concat(chunks))
  manifest.push({ name, count, layout, ...meta })
  console.log(`${name}: ${count} vertices, ${(idx.length / 3) | 0} triangles`)
}

fs.mkdirSync(output, { recursive: true })
const manifest = { vehicles: [], people: [] }

// ------------------------------------------------------------------ vehicles
for (const [src, spec] of Object.entries(VEHICLES)) {
  const obj = parse(path.join(input, src + '.fbx'))
  const parts = []
  let front = null
  obj.traverse((o) => {
    if (!o.isMesh) return
    const { g } = bake(o, { paintable: spec.paint })
    if (/front/i.test(o.name)) front = centroid(g, () => true)
    g.deleteAttribute('skinIndex')
    g.deleteAttribute('skinWeight')
    parts.push(g)
  })
  let g = mergeGeometries(parts)
  g.computeBoundingBox()
  let b = g.boundingBox
  const center = b.getCenter(new THREE.Vector3())
  const alongZ = b.max.z - b.min.z > b.max.x - b.min.x
  // turn so the front faces +x
  const f = front ? front.clone().sub(center) : new THREE.Vector3(0, 0, 1)
  if (alongZ) g.rotateY(f.z > 0 ? Math.PI / 2 : -Math.PI / 2)
  else if (f.x < 0) g.rotateY(Math.PI)
  g.computeBoundingBox()
  b = g.boundingBox
  // fit within a real length AND width: some models are stubbier than the real vehicle,
  // so scaling by length alone makes them far too wide for a lane
  const s = Math.min(spec.length / (b.max.x - b.min.x), (spec.width ?? 2.0) / (b.max.z - b.min.z))
  g.scale(s, s, s)
  g.computeBoundingBox()
  b = g.boundingBox
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
  g.computeVertexNormals()
  write(spec.name, g, ['position', 'normal', 'color', 'aPaint'], { length: +(b.max.x - b.min.x).toFixed(2), width: +(b.max.z - b.min.z).toFixed(2), paint: spec.paint }, manifest.vehicles)
}

// ------------------------------------------------------------------ people
const PART_OF = (name) => {
  if (/Leg|Foot/.test(name)) return name.endsWith('L') || /L_end$/.test(name) ? 3 : 4
  if (/Arm|Palm|Hand|Finger|Thumb|Shoulder/.test(name)) return /L(_end)?$/.test(name) ? 5 : 6
  if (/Head|Neck/.test(name)) return 1
  return 0
}
const PIVOT_BONE = { 3: 'UpperLegL', 4: 'UpperLegR', 5: 'UpperArmL', 6: 'UpperArmR' }
for (const src of PEOPLE) {
  const obj = parse(path.join(input, src + '.fbx'))
  let mesh = null
  obj.traverse((o) => {
    if (o.isSkinnedMesh && !mesh) mesh = o
  })
  const { g, matName } = bake(mesh, { paintable: false })
  const bones = mesh.skeleton.bones
  const bonePos = {}
  for (const bn of bones) bonePos[bn.name] = bn.getWorldPosition(new THREE.Vector3())
  const n = g.attributes.position.count
  const si = g.attributes.skinIndex
  const sw = g.attributes.skinWeight
  const part = new Float32Array(n)
  for (let v = 0; v < n; v++) {
    let best = 0
    let w = -1
    for (let c = 0; c < 4; c++)
      if (sw.getComponent(v, c) > w) {
        w = sw.getComponent(v, c)
        best = si.getComponent(v, c)
      }
    part[v] = PART_OF(bones[best]?.name || '')
  }
  g.deleteAttribute('skinIndex')
  g.deleteAttribute('skinWeight')
  g.deleteAttribute('aPaint')
  // face +z (where the eyes are)
  g.computeBoundingBox()
  const center = g.boundingBox.getCenter(new THREE.Vector3())
  const eyes = centroid(g, (i) => matName[i] === 'Eyes')
  const turn = eyes && eyes.z < center.z ? Math.PI : 0
  // simplify each body part separately so limbs keep clean edges
  const pieces = []
  for (let p = 0; p <= 6; p++) {
    const keep = []
    for (let tri = 0; tri < n / 3; tri++) {
      const pa = part[tri * 3]
      if (pa === p) keep.push(tri)
    }
    if (!keep.length) continue
    const sub = new THREE.BufferGeometry()
    for (const a of ['position', 'normal', 'color']) {
      const src2 = g.attributes[a]
      const arr = new Float32Array(keep.length * 3 * src2.itemSize)
      keep.forEach((tri, q) => {
        for (let k = 0; k < 3; k++) for (let c = 0; c < src2.itemSize; c++) arr[(q * 3 + k) * src2.itemSize + c] = src2.array[(tri * 3 + k) * src2.itemSize + c]
      })
      sub.setAttribute(a, new THREE.BufferAttribute(arr, src2.itemSize))
    }
    // weld by position only, otherwise colour/normal seams split the mesh into islands
    const shape = new THREE.BufferGeometry()
    shape.setAttribute('position', sub.attributes.position.clone())
    let merged = mergeVertices(shape, 1e-2)
    const target = Math.max(60, Math.round(merged.attributes.position.count * (p === 1 ? 0.16 : 0.1)))
    merged = await new SimplifyModifier().modify(merged, merged.attributes.position.count - target)
    merged = merged.index ? merged.toNonIndexed() : merged
    const m = merged.attributes.position.count
    const pa = new Float32Array(m).fill(p)
    const pv = new Float32Array(m * 3)
    const pb = bonePos[PIVOT_BONE[p]]
    if (pb) for (let v = 0; v < m; v++) pv.set([pb.x, pb.y, pb.z], v * 3)
    merged.setAttribute('aPart', new THREE.BufferAttribute(pa, 1))
    merged.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3))
    if (!merged.attributes.color) {
      // the simplifier may drop colours: take them from the nearest original vertex
      const col = new Float32Array(m * 3)
      const sp = sub.attributes.position
      const sc = sub.attributes.color
      const mp = merged.attributes.position
      for (let v = 0; v < m; v++) {
        let bi = 0
        let bd = Infinity
        for (let o = 0; o < sp.count; o += 3) {
          const d = (sp.getX(o) - mp.getX(v)) ** 2 + (sp.getY(o) - mp.getY(v)) ** 2 + (sp.getZ(o) - mp.getZ(v)) ** 2
          if (d < bd) {
            bd = d
            bi = o
          }
        }
        col.set([sc.getX(bi), sc.getY(bi), sc.getZ(bi)], v * 3)
      }
      merged.setAttribute('color', new THREE.BufferAttribute(col, 3))
    }
    for (const k of Object.keys(merged.attributes)) if (!['position', 'normal', 'color', 'aPart', 'aPivot'].includes(k)) merged.deleteAttribute(k)
    pieces.push(merged)
  }
  let out = mergeGeometries(pieces)
  // normalise: centre, stand on y = 0, 1.74 m tall, facing +z (pivots follow)
  out.computeBoundingBox()
  const b = out.boundingBox
  const s = 1.74 / (b.max.y - b.min.y)
  const cx = (b.min.x + b.max.x) / 2
  const cz = (b.min.z + b.max.z) / 2
  const pv = out.attributes.aPivot.array
  for (let q = 0; q < pv.length; q += 3) {
    let x = (pv[q] - cx) * s
    let z = (pv[q + 2] - cz) * s
    if (turn) {
      x = -x
      z = -z
    }
    pv[q] = x
    pv[q + 1] = (pv[q + 1] - b.min.y) * s
    pv[q + 2] = z
  }
  out.translate(-cx, -b.min.y, -cz)
  out.scale(s, s, s)
  if (turn) out.rotateY(Math.PI)
  // the rig's bind pose is a T-pose: lower each arm about its shoulder to hang at the side
  {
    const pos = out.attributes.position.array
    const part = out.attributes.aPart.array
    for (let v = 0; v < part.length; v++) {
      if (part[v] !== 5 && part[v] !== 6) continue
      const px = pv[v * 3]
      const py = pv[v * 3 + 1]
      const a = px > 0 ? -(Math.PI / 2 - 0.1) : Math.PI / 2 - 0.1
      const c = Math.cos(a)
      const sn = Math.sin(a)
      const x = pos[v * 3] - px
      const y = pos[v * 3 + 1] - py
      pos[v * 3] = px + x * c - y * sn
      pos[v * 3 + 1] = py + x * sn + y * c
    }
  }
  // smooth shading: share vertices within each colour region, then average normals
  out.deleteAttribute('normal')
  out = mergeVertices(out, 1e-4)
  out.computeVertexNormals()
  const name = path.basename(src).replace('Smooth_', '').toLowerCase()
  write(name, out, ['position', 'normal', 'color', 'aPart', 'aPivot'], {}, manifest.people)
}

fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 1))
console.log('wrote', output)
