// Loads the CC0 Quaternius vehicles (https://quaternius.com),
// pre-converted by scripts/convert-quaternius.mjs into compact binaries.
import * as THREE from 'three'
import { addInstanceFade } from './assets.js'

const BASE = './models/quaternius/'

function geometryFrom(entry, buf) {
  const g = new THREE.BufferGeometry()
  for (const [name, l] of Object.entries(entry.layout)) {
    if (name === 'index') continue
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(buf, l.offset, entry.count * l.itemSize), l.itemSize))
  }
  const ix = entry.layout.index
  g.setIndex(new THREE.BufferAttribute(ix.type === 'u16' ? new Uint16Array(buf, ix.offset, ix.count) : new Uint32Array(buf, ix.offset, ix.count), 1))
  g.computeBoundingSphere()
  return g
}

async function fetchModel(entry) {
  const res = await fetch(`${BASE}${entry.name}.bin`)
  if (!res.ok) throw new Error(`${entry.name}: ${res.status}`)
  return geometryFrom(entry, await res.arrayBuffer())
}

let cache = null
/** Resolves to { cars: {name: {geometry, length, paint}} }, or null. */
export function loadModels() {
  if (!cache)
    cache = (async () => {
      const res = await fetch(`${BASE}manifest.json`)
      if (!res.ok) throw new Error(`manifest: ${res.status}`)
      const manifest = await res.json()
      const cars = {}
      await Promise.all(
        manifest.vehicles.map(async (e) => {
          cars[e.name] = { geometry: await fetchModel(e), length: e.length, paint: e.paint }
        }),
      )
      return { cars }
    })().catch((e) => {
      console.warn('Detailed vehicles unavailable, using built-in ones.', e)
      return null
    })
  return cache
}

/** Baked vertex colours; flagged body paint takes the instance colour. */
export function vehicleModelMaterial(envMap) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.3, envMap, envMapIntensity: 0.8 })
  m.onBeforeCompile = (sh) => {
    addInstanceFade(m, sh)
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aPaint;').replace(
      '#include <color_vertex>',
      `#include <color_vertex>
      #ifdef USE_INSTANCING_COLOR
        // paint gets the car's colour; trim keeps its own, darkened if the car is wrecked
        float wreck = min(1.0, (instanceColor.r + instanceColor.g + instanceColor.b) / 1.2);
        vColor.rgb = aPaint > 0.5 ? instanceColor.rgb : color.rgb * mix(0.35, 1.0, wreck);
      #endif`,
    )
  }
  return m
}
