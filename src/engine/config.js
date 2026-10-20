// ---------------------------------------------------------------------------
// MetroRisk — static configuration.
// Numbers here are simplified from published engineering references
// (FEMA HAZUS fragility curves, Reasenberg & Jones aftershock statistics,
// LISFLOOD-FP style flood hydraulics). They are tuned for a ~1 km² district,
// not for engineering design.
// ---------------------------------------------------------------------------

export const GRID = 100 // cells per side
export const CELL = 10 // metres per cell → 1 km × 1 km district
export const G = 9.81

export const CELL_GRASS = 0
export const CELL_ROAD = 1
export const CELL_RIVER = 2
export const CELL_BANK = 3
export const CELL_PARK = 4
export const CELL_POND = 5

export const RIVER_HALF_WIDTH = 3.2 // cells (≈64 m wide channel)
export const RIVER_DEPTH = 7.5 // metres below bank at the thalweg

// ---------------------------------------------------------------- Structures
// medians: PGA (g) at which 50% of buildings reach Slight / Moderate /
// Extensive / Complete damage (lognormal, β = 0.64). Loosely HAZUS-based.
export const FRAGILITY_BETA = 0.64
// fatigue: how fast repeated strong shaking uses up a frame's hysteretic
// capacity (brittle masonry and non-ductile concrete degrade fastest).
// fireLoss: integrity lost per hour of fire (unprotected steel softens,
// timber burns through, concrete spalls slowly).

export const CONSTRUCTION = {
  wood_old: {
    name: 'Wood frame (pre-code)',
    short: 'Old wood',
    medians: [0.18, 0.29, 0.51, 0.77],
    collapse: 0.03,
    fatigue: 1.1,
    fireLoss: 0.6,
    fire: 0.3,
    floodDV: 2.0,
    next: 'wood_mod',
    era: 'before 1960',
  },
  wood_mod: {
    name: 'Wood frame (modern code)',
    short: 'Wood',
    medians: [0.26, 0.55, 1.28, 2.01],
    collapse: 0.03,
    fatigue: 0.8,
    fireLoss: 0.5,
    fire: 0.25,
    floodDV: 2.5,
    next: null,
    era: 'after 1990',
  },
  urm: {
    name: 'Unreinforced masonry',
    short: 'URM',
    medians: [0.13, 0.17, 0.26, 0.37],
    collapse: 0.15,
    fatigue: 1.45,
    fireLoss: 0.08,
    fire: 0.06,
    floodDV: 3.5,
    next: 'rc_mod',
    era: 'before 1940',
  },
  rc_low: {
    name: 'Concrete frame (low code)',
    short: 'RC low',
    medians: [0.16, 0.22, 0.36, 0.55],
    collapse: 0.13,
    fatigue: 1.3,
    fireLoss: 0.12,
    fire: 0.05,
    floodDV: 6,
    next: 'rc_mod',
    era: '1950–1975',
  },
  rc_mod: {
    name: 'Concrete frame (moderate code)',
    short: 'RC mod',
    medians: [0.21, 0.35, 0.7, 1.1],
    collapse: 0.1,
    fatigue: 1,
    fireLoss: 0.1,
    fire: 0.04,
    floodDV: 7,
    next: 'rc_high',
    era: '1975–1995',
  },
  rc_high: {
    name: 'Concrete frame (high seismic code)',
    short: 'RC high',
    medians: [0.28, 0.52, 1.05, 1.65],
    collapse: 0.08,
    fatigue: 0.85,
    fireLoss: 0.09,
    fire: 0.04,
    floodDV: 8,
    next: null,
    era: 'after 1995',
  },
  steel: {
    name: 'Steel moment frame (high code)',
    short: 'Steel',
    medians: [0.3, 0.58, 1.15, 1.85],
    collapse: 0.05,
    fatigue: 0.75,
    fireLoss: 0.2,
    fire: 0.04,
    floodDV: 8,
    next: null,
    era: 'after 1995',
  },
  isolated: {
    name: 'Base-isolated',
    short: 'Isolated',
    medians: [0.7, 1.1, 1.9, 2.8],
    collapse: 0.03,
    fatigue: 0.55,
    fireLoss: 0.09,
    fire: 0.03,
    floodDV: 8,
    next: null,
    era: 'retrofit',
  },
}

export const DAMAGE_STATES = ['None', 'Slight', 'Moderate', 'Extensive', 'Complete']

// ------------------------------------------------------------------ Wind
// Wind resistance as the 3-s gust (m/s) at roof height that gives a 50%
// chance of failure (lognormal, β = WIND_BETA), for the HAZUS-Hurricane chain
// of components: windows and doors breached → roof cover peeled off → roof
// structure lifted off → walls / whole building fail. Tuned to the pattern
// of post-Haiyan (2013) surveys: light timber and hollow-block homes lost
// roofs at gusts of ~150–200 km/h and were flattened above ~250 km/h, while
// engineered concrete kept its frame and lost glass and cladding.
export const WIND_BETA = 0.2
export const WIND = {
  wood_old: { glass: 42, cover: 36, roof: 46, collapse: 62 },
  wood_mod: { glass: 48, cover: 48, roof: 60, collapse: 80 },
  urm: { glass: 45, cover: 39, roof: 50, collapse: 68 },
  rc_low: { glass: 48, cover: 42, roof: 55, collapse: 115 },
  rc_mod: { glass: 52, cover: 46, roof: 60, collapse: 140 },
  rc_high: { glass: 56, cover: 50, roof: 64, collapse: 160 },
  steel: { glass: 56, cover: 48, roof: 62, collapse: 155 },
  isolated: { glass: 56, cover: 50, roof: 64, collapse: 160 },
}
// masonry under a concrete roof slab is tied together: far harder to flatten than under a light roof
export const SLAB_COLLAPSE = 1.5
// Roof by building type: 'light' = sheet or tile on timber, 'metal' = metal
// sheet on steel purlins (sheds, stands), 'slab' = concrete roof slab (it
// never blows off; only rooftop plant and cladding go).
export const ROOF_KIND = { house: 'light', school: 'light', shelter: 'light', worship: 'light', museum: 'light', industrial: 'metal', stadium: 'metal' }
export const roofKind = (type) => ROOF_KIND[type] ?? 'slab'
// metal sheds: cladding fails early, the steel frame holds
export const METAL_ROOF = { cover: 42, roof: 55 }
// Trees: windthrow or stem breakage (broadleaf / conifer), 3-s gust at crown height
export const TREE_WIND = [42, 46]
// Distribution poles and lines along a 250 m feeder; the line into the city
export const POLE_WIND = 47
export const GRID_WIND = 58
// Steel street-lighting columns and traffic-signal poles (3-s gust at ~8 m)
export const STREET_POLE_WIND = [54, 50]

// Casualty fractions of occupants present, by damage state reached.
// [dead, trapped (alive), critical injured, minor injured]
export const QUAKE_CASUALTY = [
  [0, 0, 0, 0],
  [0, 0, 0, 0.0005],
  [0.00002, 0, 0.0005, 0.005],
  [0.0002, 0.002, 0.003, 0.02],
  [0.002, 0.03, 0.02, 0.08], // complete, standing
]
export const QUAKE_CASUALTY_COLLAPSE = [0.1, 0.4, 0.1, 0.25]

// --------------------------------------------------------------- Buildings
export const BUILDING_TYPES = {
  house: {
    name: 'House',
    m2PerPerson: 40,
    day: 0.35,
    night: 0.95,
    residentShare: 1,
    floorH: 3.0,
    costM2: 1500,
    windows: 1,
    colors: ['#d8cfc0', '#c9b79c', '#e6e1d6', '#b8a68c', '#cfd6d9', '#d9c4a8', '#a9b3a0'],
    roofColors: ['#8a4a35', '#5e5149', '#6d3b2f', '#4c5560', '#7a6250'],
  },
  apartment: {
    name: 'Apartment block',
    m2PerPerson: 35,
    day: 0.35,
    night: 0.95,
    residentShare: 1,
    floorH: 3.0,
    costM2: 1800,
    windows: 1,
    colors: ['#c8b7a0', '#b9a58b', '#d6d0c4', '#a89c8e', '#c4ccd0', '#bfae96'],
  },
  office: {
    name: 'Office / Commercial',
    m2PerPerson: 18,
    day: 0.85,
    night: 0.03,
    residentShare: 0,
    floorH: 3.6,
    costM2: 2500,
    windows: 2,
    colors: ['#9fb0bd', '#8d9aa5', '#b4bcc2', '#7f8e99', '#a6a29a'],
  },
  tower: {
    name: 'High-rise tower',
    m2PerPerson: 25,
    day: 0.8,
    night: 0.45,
    residentShare: 0.5,
    floorH: 3.5,
    costM2: 3200,
    windows: 3,
    colors: ['#6f8597', '#8095a6', '#5c6f80', '#93a3ae', '#7a8b8f', '#a5adb3'],
  },
  industrial: {
    name: 'Industrial / Warehouse',
    m2PerPerson: 80,
    day: 0.7,
    night: 0.15,
    residentShare: 0,
    floorH: 6,
    costM2: 900,
    windows: 0,
    colors: ['#8c8a80', '#9c9585', '#7d7f80', '#a39b88'],
  },
  hospital: {
    name: 'Hospital',
    m2PerPerson: 30,
    day: 1,
    night: 0.8,
    residentShare: 0,
    floorH: 3.8,
    costM2: 4000,
    windows: 2,
    colors: ['#eef0f0'],
    facility: true,
  },
  fire: {
    name: 'Fire & rescue station',
    m2PerPerson: 40,
    day: 1,
    night: 1,
    residentShare: 0,
    floorH: 4.2,
    costM2: 3000,
    windows: 1,
    colors: ['#b8433a'],
    facility: true,
  },
  school: {
    name: 'School',
    m2PerPerson: 8,
    day: 0.9,
    night: 0,
    residentShare: 0,
    floorH: 3.6,
    costM2: 2200,
    windows: 1,
    colors: ['#d8b56d', '#c9a463'],
    facility: true,
  },
  shelter: {
    name: 'Evacuation shelter',
    m2PerPerson: 1e9, // empty until evacuees arrive
    day: 0,
    night: 0,
    residentShare: 0,
    floorH: 4,
    costM2: 1800,
    windows: 1,
    colors: ['#6fa57a'],
    facility: true,
  },
  // Civic and cultural buildings: low and wide, heavy, mostly masonry or
  // concrete. One or two of each per town, placed on their own sites.
  civic: {
    name: 'City hall',
    m2PerPerson: 25,
    day: 0.8,
    night: 0.02,
    residentShare: 0,
    floorH: 4.6,
    costM2: 3800,
    windows: 4,
    colors: ['#ddd5c4', '#d2c8b3', '#e4dfd3', '#cdbfa6'],
    roofColors: ['#5f7f78', '#4f5a5e', '#7a5a46'],
    landmark: true,
  },
  museum: {
    name: 'Museum',
    m2PerPerson: 30,
    day: 0.55,
    night: 0.01,
    residentShare: 0,
    floorH: 5.5,
    costM2: 5200,
    windows: 4,
    colors: ['#e3ddd0', '#d6cdb9', '#ece8e0', '#c9c2b4'],
    roofColors: ['#5f7f78', '#6b6a66'],
    landmark: true,
  },
  library: {
    name: 'Public library',
    m2PerPerson: 20,
    day: 0.5,
    night: 0.01,
    residentShare: 0,
    floorH: 4.6,
    costM2: 3600,
    windows: 4,
    colors: ['#b88a6a', '#c9a27f', '#d8cdb8', '#a8765a'],
    roofColors: ['#4f5a5e', '#6d3b2f'],
    landmark: true,
  },
  worship: {
    name: 'Place of worship',
    m2PerPerson: 6,
    day: 0.12,
    night: 0.02,
    residentShare: 0,
    floorH: 7,
    costM2: 3000,
    windows: 4,
    colors: ['#d9cfbd', '#c7b9a0', '#e6e0d4', '#b9a58a'],
    roofColors: ['#5e5149', '#6d3b2f', '#4c5560', '#5f7f78'],
    landmark: true,
  },
  stadium: {
    name: 'Arena',
    m2PerPerson: 4,
    day: 0.06,
    night: 0.01,
    residentShare: 0,
    floorH: 6,
    costM2: 2800,
    windows: 5,
    colors: ['#c9ccd0', '#b8bdc2', '#d6d2c8'],
    landmark: true,
  },
  landmark: {
    name: 'Landmark',
    m2PerPerson: 60,
    day: 0.5,
    night: 0.02,
    residentShare: 0,
    floorH: 4,
    costM2: 6000,
    windows: 5,
    colors: ['#d8d2c4', '#c9c4b8', '#b9b3a6'],
    landmark: true,
  },
}

// Sub-types shown in the inspector (b.variant).
export const VARIANT_NAMES = {
  primary: 'Primary school',
  high: 'High school',
  university: 'University',
  dorm: 'Student residence',
  needle: 'Observation tower',
  clock: 'Clock tower',
  arch: 'Monumental arch',
  church: 'Church',
  cathedral: 'Cathedral',
  temple: 'Temple',
  mosque: 'Mosque',
}

// Heritage buildings of every city are mostly old masonry; newer cities add concrete.
const MIX_HERITAGE_OLD = {
  civic: { urm: 0.6, rc_low: 0.4 },
  museum: { urm: 0.5, rc_low: 0.3, rc_mod: 0.2 },
  library: { urm: 0.55, rc_low: 0.45 },
  worship: { urm: 0.8, wood_old: 0.2 },
  stadium: { rc_low: 0.5, steel: 0.5 },
  landmark: { urm: 0.6, rc_mod: 0.4 },
}
const MIX_HERITAGE_NEW = {
  civic: { urm: 0.35, rc_mod: 0.45, isolated: 0.2 },
  museum: { urm: 0.25, rc_mod: 0.4, rc_high: 0.2, steel: 0.15 },
  library: { urm: 0.3, rc_mod: 0.5, rc_high: 0.2 },
  worship: { urm: 0.7, rc_low: 0.3 },
  stadium: { rc_mod: 0.4, steel: 0.6 },
  landmark: { urm: 0.3, steel: 0.4, rc_high: 0.3 },
}

// ---------------------------------------------------------------- Cities
// Construction mix per building type: {class: weight}
const MIX_RURAL = {
  house: { wood_old: 0.45, urm: 0.3, wood_mod: 0.25 },
  apartment: { urm: 0.45, rc_low: 0.55 },
  office: { urm: 0.3, rc_low: 0.5, rc_mod: 0.2 },
  tower: { rc_mod: 1 },
  industrial: { rc_low: 0.6, steel: 0.4 },
  hospital: { rc_low: 0.4, rc_mod: 0.6 },
  fire: { rc_low: 0.5, urm: 0.5 },
  school: { urm: 0.5, rc_low: 0.5 },
  ...MIX_HERITAGE_OLD,
}
const MIX_METRO = {
  house: { wood_old: 0.25, wood_mod: 0.45, urm: 0.3 },
  apartment: { urm: 0.15, rc_low: 0.45, rc_mod: 0.4 },
  office: { rc_low: 0.25, rc_mod: 0.5, rc_high: 0.25 },
  tower: { rc_mod: 0.4, rc_high: 0.4, steel: 0.2 },
  industrial: { rc_low: 0.5, steel: 0.5 },
  hospital: { rc_mod: 0.7, rc_high: 0.3 },
  fire: { rc_low: 0.4, rc_mod: 0.6 },
  school: { urm: 0.3, rc_low: 0.4, rc_mod: 0.3 },
  ...MIX_HERITAGE_OLD,
}
const MIX_MEGA = {
  house: { wood_old: 0.3, wood_mod: 0.5, urm: 0.2 },
  apartment: { urm: 0.15, rc_low: 0.4, rc_mod: 0.45 },
  office: { rc_low: 0.15, rc_mod: 0.5, rc_high: 0.35 },
  tower: { rc_mod: 0.3, rc_high: 0.45, steel: 0.25 },
  industrial: { rc_low: 0.4, steel: 0.6 },
  hospital: { rc_mod: 0.6, rc_high: 0.4 },
  fire: { rc_mod: 0.7, rc_high: 0.3 },
  school: { rc_low: 0.4, rc_mod: 0.6 },
  ...MIX_HERITAGE_NEW,
}

export const CITY_TYPES = {
  rural: {
    key: 'rural',
    name: 'Rural Town',
    blurb: 'A small river town. Low population, scattered low-rise homes, old masonry main street.',
    roadSpacing: 12,
    radius: 26,
    fill: 0.55,
    outerFill: 0.12,
    lotSizes: [2, 2, 3],
    budget: 40,
    hospitals: 1,
    fireStations: 1,
    // special sites, placed on their own block before ordinary lots: kind, distance band (fraction of radius), chance
    sites: [
      { kind: 'civic', r: [0, 0.4] },
      { kind: 'worship', r: [0, 0.6] },
      { kind: 'primary', r: [0.1, 0.8] },
      { kind: 'library', r: [0, 0.6], chance: 0.6 },
      { kind: 'clock', r: [0, 0.5], chance: 0.4 },
      { kind: 'park', r: [0.2, 0.9], chance: 0.5 },
    ],
    treeDensity: 0.22,
    parkChance: 0.02,
    drainage: 10, // mm/h storm-drain capacity
    zones: {
      core: { house: 0.35, apartment: 0.3, office: 0.3, industrial: 0.05 },
      mid: { house: 0.85, apartment: 0.08, office: 0.02, industrial: 0.05 },
      outer: { house: 0.95, industrial: 0.05 },
    },
    floors: { house: [1, 2], apartment: [2, 4], office: [2, 3], tower: [6, 9], industrial: [1, 1], hospital: [2, 3], fire: [1, 2], school: [1, 2] },
    mix: MIX_RURAL,
  },
  metropolis: {
    key: 'metropolis',
    name: 'Metropolis',
    blurb: 'A dense regional city. Mid-rise apartments, an office core, a handful of towers.',
    roadSpacing: 8,
    radius: 44,
    fill: 0.85,
    outerFill: 0.4,
    lotSizes: [2, 3, 3],
    budget: 350,
    hospitals: 2,
    fireStations: 3,
    sites: [
      { kind: 'civic', r: [0, 0.35] },
      { kind: 'museum', r: [0, 0.5] },
      { kind: 'library', r: [0.1, 0.6] },
      { kind: 'worship', r: [0.1, 0.7] },
      { kind: 'worship', r: [0.3, 0.9], chance: 0.5 },
      { kind: 'landmark', r: [0, 0.45] },
      { kind: 'park', r: [0.15, 0.6] },
      { kind: 'park', r: [0.4, 0.9], chance: 0.6 },
      { kind: 'university', r: [0.45, 1] },
      { kind: 'high', r: [0.3, 0.9] },
      { kind: 'primary', r: [0.2, 0.8] },
      { kind: 'primary', r: [0.5, 1] },
    ],
    treeDensity: 0.08,
    parkChance: 0.04,
    drainage: 25,
    zones: {
      core: { office: 0.45, tower: 0.25, apartment: 0.3 },
      mid: { apartment: 0.55, office: 0.2, house: 0.15, industrial: 0.1 },
      outer: { house: 0.65, apartment: 0.2, industrial: 0.15 },
    },
    floors: { house: [1, 3], apartment: [4, 10], office: [4, 14], tower: [16, 32], industrial: [1, 2], hospital: [5, 8], fire: [2, 2], school: [2, 3] },
    mix: MIX_METRO,
  },
  megacity: {
    key: 'megacity',
    name: 'Megacity',
    blurb: 'An extremely dense urban core. Skyscrapers, packed apartment towers, very little open space.',
    roadSpacing: 7,
    radius: 70,
    fill: 0.97,
    outerFill: 0.9,
    lotSizes: [3, 3, 2],
    budget: 1200,
    hospitals: 4,
    fireStations: 6,
    sites: [
      { kind: 'civic', r: [0, 0.3] },
      { kind: 'museum', r: [0, 0.45] },
      { kind: 'museum', r: [0.2, 0.7] },
      { kind: 'library', r: [0.1, 0.6] },
      { kind: 'needle', r: [0.05, 0.4] },
      { kind: 'arch', r: [0, 0.5] },
      { kind: 'worship', r: [0.1, 0.7] },
      { kind: 'worship', r: [0.3, 0.9] },
      { kind: 'park', r: [0.1, 0.5] },
      { kind: 'park', r: [0.4, 0.9] },
      { kind: 'stadium', r: [0.55, 1.1] },
      { kind: 'university', r: [0.4, 0.95] },
      { kind: 'high', r: [0.3, 0.9] },
      { kind: 'high', r: [0.5, 1] },
      { kind: 'primary', r: [0.2, 0.8] },
      { kind: 'primary', r: [0.4, 0.9] },
      { kind: 'primary', r: [0.6, 1.1] },
    ],
    treeDensity: 0.03,
    parkChance: 0.03,
    drainage: 35,
    zones: {
      core: { tower: 0.6, office: 0.3, apartment: 0.1 },
      mid: { tower: 0.3, apartment: 0.45, office: 0.25 },
      outer: { apartment: 0.6, house: 0.15, tower: 0.1, industrial: 0.15 },
    },
    floors: { house: [2, 3], apartment: [8, 22], office: [10, 30], tower: [25, 60], industrial: [1, 3], hospital: [6, 12], fire: [2, 3], school: [3, 5] },
    mix: MIX_MEGA,
  },
}

// ---------------------------------------------------------------- Disasters
// Generic intensity tiers. mech: fault type (see quakePhysics MECHANISMS);
// strike: angle (°) between the fault and the line from the epicentre to the
// city (0 = the fault runs straight at the city, 90 = it passes alongside);
// rupture: which way the break spreads from the epicentre.
export const QUAKE_LEVELS = [
  { M: 4.5, name: 'Light', dist: 20, depth: 10, mech: 'strike', strike: 90, rupture: 'bilateral', desc: 'Felt by most people indoors. Damage is rare.', example: 'Thousands occur every year worldwide.' },
  { M: 5.5, name: 'Moderate', dist: 14, depth: 10, mech: 'strike', strike: 90, rupture: 'bilateral', desc: 'Cracks in plaster, falling objects. Weak masonry may be damaged.', example: '2011 Lorca, Spain (M5.1).' },
  { M: 6.3, name: 'Strong', dist: 9, depth: 8, mech: 'reverse', strike: 60, rupture: 'bilateral', desc: 'Considerable damage to poorly built structures; old masonry fails.', example: '2011 Christchurch, NZ (M6.2).' },
  { M: 6.9, name: 'Major', dist: 14, depth: 16, mech: 'strike', strike: 30, rupture: 'bilateral', desc: 'Serious damage over a wide area. Older concrete frames may collapse.', example: '1995 Kobe, Japan (M6.9).' },
  { M: 7.8, name: 'Severe', dist: 22, depth: 15, mech: 'strike', strike: 30, rupture: 'bilateral', desc: 'Widespread destruction. Only well-engineered buildings stay safe.', example: '2023 Türkiye–Syria (M7.8).' },
  { M: 8.5, name: 'Great', dist: 45, depth: 25, mech: 'reverse', strike: 60, rupture: 'bilateral', desc: 'Long, violent shaking. Severe damage even far from the epicentre.', example: '1950 Assam–Tibet (M8.6).' },
  { M: 9.1, name: 'Megathrust', dist: 70, depth: 25, mech: 'interface', strike: 90, rupture: 'bilateral', desc: 'Minutes of shaking. Tall buildings resonate, soft soils liquefy.', example: '2011 Tōhoku, Japan (M9.1).' },
  { M: 9.5, name: 'Largest ever recorded', dist: 60, depth: 30, mech: 'interface', strike: 90, rupture: 'bilateral', desc: 'The strongest earthquake in recorded history. Catastrophic.', example: '1960 Valdivia, Chile (M9.5).' },
  { M: 10.0, name: 'Theoretical', dist: 40, depth: 25, mech: 'interface', strike: 90, rupture: 'bilateral', desc: 'No recorded precedent; would need a ~5,000 km fault rupture. No current engineering can withstand it.', example: 'Never observed.' },
]

// Historical reenactments. Magnitude (Mw), focal depth and mechanism follow
// the published source studies / USGS summaries; `dist` is the approximate
// epicentral distance to the city named in `city`, and strike/rupture place
// that city where it was relative to the rupture. `observed` is the recorded
// peak ground acceleration there, for comparing against the model.
export const HISTORICAL_QUAKES = [
  { id: 'sf1906', year: 1906, name: 'San Francisco', place: 'California, USA', city: 'San Francisco', M: 7.9, depth: 8, dist: 12, mech: 'strike', strike: 80, rupture: 'bilateral', deaths: '~3,000', desc: 'The San Andreas fault tore for ~470 km just offshore. Fires burned for three days and destroyed most of the city.' },
  { id: 'kanto1923', year: 1923, name: 'Great Kantō', place: 'Japan', city: 'Yokohama', M: 7.9, depth: 23, dist: 40, mech: 'interface', strike: 80, rupture: 'bilateral', deaths: '~105,000', desc: 'A megathrust under Sagami Bay. Most deaths came from firestorms through wooden neighbourhoods at lunchtime.' },
  { id: 'valdivia1960', year: 1960, name: 'Valdivia', place: 'Chile', city: 'Valdivia', M: 9.5, depth: 25, dist: 200, mech: 'interface', strike: 5, rupture: 'toward', deaths: '1,000–6,000', desc: 'The largest earthquake ever recorded. ~1,000 km of the Chilean margin broke; the city sank and was flooded by the tsunami.' },
  { id: 'alaska1964', year: 1964, name: 'Great Alaska', place: 'USA', city: 'Anchorage', M: 9.2, depth: 25, dist: 120, mech: 'interface', strike: 75, rupture: 'away', deaths: '131', desc: 'Four and a half minutes of shaking. Whole neighbourhoods of Anchorage slid away on liquefied clay.' },
  { id: 'tangshan1976', year: 1976, name: 'Tangshan', place: 'China', city: 'Tangshan', M: 7.6, depth: 12, dist: 4, mech: 'strike', strike: 30, rupture: 'bilateral', deaths: '~240,000', desc: 'A fault directly beneath an industrial city of a million people at 3:42 am. Almost every brick building collapsed.' },
  { id: 'mexico1985', year: 1985, name: 'Michoacán', place: 'Mexico', city: 'Mexico City', M: 8.0, depth: 27, dist: 350, mech: 'interface', strike: 90, rupture: 'bilateral', deaths: '~10,000', observed: { pga: [0.03, 0.04], where: 'UNAM rock site; 0.17 g on the old lake bed (SCT)' }, desc: 'Far from the epicentre, yet the soft lake-bed clay under Mexico City resonated and brought down 8–18 storey buildings.' },
  { id: 'lomaprieta1989', year: 1989, name: 'Loma Prieta', place: 'California, USA', city: 'San Francisco', M: 6.9, depth: 18, dist: 95, mech: 'reverse', strike: 10, rupture: 'bilateral', deaths: '63', observed: { pga: [0.06, 0.2], where: 'San Francisco rock and fill sites' }, desc: 'Most damage was ~100 km from the epicentre, on the soft fill of the Marina district and at the Cypress viaduct.' },
  { id: 'northridge1994', year: 1994, name: 'Northridge', place: 'California, USA', city: 'San Fernando Valley', M: 6.7, depth: 18, dist: 5, mech: 'reverse', dip: 40, strike: 80, rupture: 'bilateral', deaths: '57', observed: { pga: [0.4, 0.9], where: 'across the San Fernando Valley' }, desc: 'A blind thrust under the valley produced some of the strongest shaking ever recorded in a US city.' },
  { id: 'kobe1995', year: 1995, name: 'Great Hanshin (Kobe)', place: 'Japan', city: 'Kobe', M: 6.9, depth: 16, dist: 20, mech: 'strike', strike: 5, rupture: 'toward', deaths: '6,434', observed: { pga: [0.82, 0.82], where: 'JMA Kobe station' }, desc: 'The rupture ran from Awaji Island straight under Kobe. Old timber houses with heavy tile roofs and pre-1981 concrete collapsed.' },
  { id: 'izmit1999', year: 1999, name: 'İzmit', place: 'Türkiye', city: 'Gölcük', M: 7.6, depth: 17, dist: 10, mech: 'strike', strike: 10, rupture: 'bilateral', deaths: '~17,000', desc: 'The North Anatolian fault broke for 150 km through the industrial heartland at 3 am; many poorly built apartment blocks pancaked.' },
  { id: 'chichi1999', year: 1999, name: 'Chi-Chi', place: 'Taiwan', city: 'Taichung County', M: 7.6, depth: 8, dist: 25, mech: 'reverse', dip: 30, strike: 70, rupture: 'bilateral', deaths: '2,415', desc: 'A thrust with up to 8 m of slip lifted the ground into a scarp across towns, dams and bridges.' },
  { id: 'gujarat2001', year: 2001, name: 'Gujarat (Bhuj)', place: 'India', city: 'Bhuj', M: 7.7, depth: 16, dist: 20, mech: 'reverse', strike: 60, rupture: 'bilateral', deaths: '~20,000', desc: 'An intraplate thrust far from any plate boundary flattened the old stone town of Bhuj on Republic Day.' },
  { id: 'sumatra2004', year: 2004, name: 'Sumatra–Andaman', place: 'Indonesia', city: 'Banda Aceh', M: 9.1, depth: 30, dist: 250, mech: 'interface', strike: 10, rupture: 'toward', deaths: '~228,000 (mostly tsunami)', desc: 'A 1,300 km rupture northward for ~8 minutes. Banda Aceh was shaken hard and then destroyed by the tsunami.' },
  { id: 'kashmir2005', year: 2005, name: 'Kashmir', place: 'Pakistan', city: 'Muzaffarabad', M: 7.6, depth: 26, dist: 19, mech: 'reverse', strike: 60, rupture: 'bilateral', deaths: '~86,000', desc: 'A thrust in steep mountains: collapsed schools and homes, and thousands of landslides.' },
  { id: 'wenchuan2008', year: 2008, name: 'Wenchuan', place: 'China', city: 'Beichuan', M: 7.9, depth: 19, dist: 140, mech: 'reverse', strike: 5, rupture: 'toward', deaths: '~87,000', desc: 'The rupture ran 240 km north-east along the Longmen Shan. Beichuan was buried by landslides and had to be abandoned.' },
  { id: 'laquila2009', year: 2009, name: 'L’Aquila', place: 'Italy', city: 'L’Aquila', M: 6.3, depth: 9, dist: 4, mech: 'normal', strike: 60, rupture: 'bilateral', deaths: '309', observed: { pga: [0.4, 0.65], where: 'L’Aquila stations (AQV ~0.65 g)' }, desc: 'A normal fault right under a medieval city, after months of foreshocks.' },
  { id: 'haiti2010', year: 2010, name: 'Haiti', place: 'Haiti', city: 'Port-au-Prince', M: 7.0, depth: 13, dist: 25, mech: 'strike', strike: 20, rupture: 'bilateral', deaths: '100,000–316,000', desc: 'A shallow quake next to a capital of unreinforced concrete-block buildings. One of the deadliest disasters of the century.' },
  { id: 'maule2010', year: 2010, name: 'Maule', place: 'Chile', city: 'Concepción', M: 8.8, depth: 23, dist: 100, mech: 'interface', strike: 10, rupture: 'bilateral', deaths: '525', desc: 'Modern Chilean code buildings mostly stood through three minutes of shaking — a success story for engineering.' },
  { id: 'christchurch2011', year: 2011, name: 'Christchurch', place: 'New Zealand', city: 'Christchurch CBD', M: 6.2, depth: 5, dist: 6, mech: 'reverse', dip: 65, strike: 60, rupture: 'bilateral', deaths: '185', observed: { pga: [0.37, 0.52], where: 'CBD strong-motion stations' }, desc: 'An aftershock of the 2010 Darfield quake, right under the city. Severe liquefaction and two office-block collapses.' },
  { id: 'tohoku2011', year: 2011, name: 'Tōhoku', place: 'Japan', city: 'Sendai', M: 9.1, depth: 29, dist: 130, mech: 'interface', strike: 85, rupture: 'bilateral', deaths: '~19,700 (mostly tsunami)', desc: 'Japan’s largest recorded quake. Buildings largely survived the shaking; the tsunami did not spare the coast.' },
  { id: 'gorkha2015', year: 2015, name: 'Gorkha', place: 'Nepal', city: 'Kathmandu', M: 7.8, depth: 8, dist: 77, mech: 'interface', dip: 10, strike: 10, rupture: 'toward', deaths: '~9,000', observed: { pga: [0.16, 0.16], where: 'KATNP, Kathmandu' }, desc: 'The rupture ran east under Kathmandu. Shaking was long-period and lower than feared, but old masonry and temples fell.' },
  { id: 'kumamoto2016', year: 2016, name: 'Kumamoto', place: 'Japan', city: 'Mashiki', M: 7.0, depth: 10, dist: 6, mech: 'strike', strike: 20, rupture: 'bilateral', deaths: '~270', desc: 'Struck 28 hours after an M6.2 foreshock: buildings already weakened by the first quake collapsed in the second.' },
  { id: 'puebla2017', year: 2017, name: 'Puebla', place: 'Mexico', city: 'Mexico City', M: 7.1, depth: 51, dist: 120, mech: 'intraslab', strike: 60, rupture: 'bilateral', deaths: '370', desc: 'A deep break inside the subducting plate — on the anniversary of 1985, hours after a city-wide drill.' },
  { id: 'palu2018', year: 2018, name: 'Palu', place: 'Indonesia', city: 'Palu', M: 7.5, depth: 20, dist: 80, mech: 'strike', strike: 5, rupture: 'toward', deaths: '~4,300', desc: 'A supershear rupture down the Palu-Koro fault. Whole districts flowed away on liquefied ground.' },
  { id: 'turkiye2023', year: 2023, name: 'Kahramanmaraş', place: 'Türkiye–Syria', city: 'Antakya', M: 7.8, depth: 10, dist: 140, mech: 'strike', strike: 5, rupture: 'toward', deaths: '~59,000', desc: 'A ~350 km rupture at 4:17 am, followed nine hours later by an M7.5. Tens of thousands of buildings pancaked.' },
  { id: 'morocco2023', year: 2023, name: 'Al Haouz', place: 'Morocco', city: 'Marrakesh', M: 6.8, depth: 26, dist: 70, mech: 'reverse', strike: 70, rupture: 'bilateral', deaths: '~2,960', desc: 'A rare deep crustal quake in the High Atlas; mud-brick mountain villages were flattened.' },
  { id: 'myanmar2025', year: 2025, name: 'Mandalay', place: 'Myanmar', city: 'Mandalay', M: 7.7, depth: 10, dist: 17, mech: 'strike', strike: 10, rupture: 'bilateral', deaths: '~3,800', desc: 'The Sagaing fault ruptured for ~450 km at supershear speed, passing right by Mandalay.' },
]

// Typhoons (see typhoonPhysics.js). wind: maximum sustained wind (km/h) as the
// bulletin gives it, avg: its averaging period (10 min for PAGASA / JMA / HKO,
// 1 min for JTWC / NHC). heading: direction of motion (° from north), speed:
// km/h, dist: closest approach to the district (km), side: which side of the
// track the district is on (the right is the windy side in the north),
// landfall: hours before (−) or after (+) closest approach, null = stays at sea.
// rainBoost: extra rain from the monsoon or mountains.
export const TYPHOON_LEVELS = [
  { name: 'Monsoon low', wind: 40, avg: 10, heading: 300, speed: 8, dist: 20, side: 'right', landfall: -6, lat: 15, rainBoost: 3.5, desc: 'A weak, slow low-pressure area pulling in the southwest monsoon. Little wind, but rain for a day and a half.', example: 'Habagat rains, as in Metro Manila in August 2012.' },
  { name: 'Tropical depression', wind: 55, avg: 10, heading: 290, speed: 18, dist: 40, side: 'right', landfall: -4, lat: 14, rainBoost: 1.3, desc: 'Gusty rain bands. Drains near capacity, streets flood in low spots.', example: 'A typical PAGASA "TD" crossing Luzon.' },
  { name: 'Tropical storm', wind: 85, avg: 10, heading: 290, speed: 20, dist: 35, side: 'right', landfall: -4, lat: 14, rainBoost: 1.3, desc: 'Gale-force winds and hours of heavy rain. The river rises toward its banks.', example: 'Signal No. 2 storms, several a year.' },
  { name: 'Severe tropical storm', wind: 110, avg: 10, heading: 290, speed: 20, dist: 30, side: 'right', landfall: -3, lat: 14, rainBoost: 1.2, desc: 'Storm-force winds. Light roofs and trees start to fail; heavy rain bands every hour.', example: 'Signal No. 3.' },
  { name: 'Typhoon', wind: 150, avg: 10, heading: 290, speed: 20, dist: 25, side: 'right', landfall: -2, lat: 14, desc: 'Typhoon-force winds in the eyewall, torrential rain, the river overtops.', example: 'Signal No. 4, a few times a year in the Philippines.' },
  { name: 'Super typhoon', wind: 230, avg: 10, heading: 285, speed: 22, dist: 15, side: 'right', landfall: -1, lat: 12, desc: 'An intense, compact core. If the eye passes over, the wind dies, then returns from the other side.', example: 'Signal No. 5.' },
  { name: 'Beyond records', wind: 320, avg: 10, heading: 280, speed: 12, dist: 8, side: 'right', landfall: -0.5, lat: 12, rainBoost: 1.3, desc: 'Stronger and slower than any typhoon on record at landfall.', example: 'Beyond Goni (2020) and Haiyan (2013).' },
]

// Historical reenactments. Intensity and pressure are the agency values near
// closest approach (`avg` says whose: 10-min PAGASA/JMA/IMD or 1-min JTWC/NHC).
// The track is simplified to a straight line at the storm's approximate
// heading and speed, passing `city` at about `dist` km on the given `side`.
// These are approximations for the game, not best-track data.
export const HISTORICAL_TYPHOONS = [
  { id: 'haiyan2013', year: 2013, name: 'Haiyan', local: 'Yolanda', place: 'Philippines', city: 'Tacloban', wind: 315, avg: 1, pc: 895, heading: 285, speed: 40, dist: 15, side: 'right', landfall: -0.3, lat: 11.2, deaths: '~6,300', desc: 'One of the strongest storms ever to make landfall, moving fast across the Leyte Gulf. Most deaths came from a 4–6 m storm surge funnelled into Tacloban (surge is simulated in a later phase).' },
  { id: 'goni2020', year: 2020, name: 'Goni', local: 'Rolly', place: 'Philippines', city: 'Virac, Catanduanes', wind: 315, avg: 1, pc: 905, heading: 255, speed: 20, dist: 10, side: 'left', landfall: -0.2, lat: 13.6, rainBoost: 1.2, deaths: '~30', desc: 'The strongest landfall on record by 1-minute wind. A tiny, violent core; mass pre-emptive evacuation kept deaths low.' },
  { id: 'rai2021', year: 2021, name: 'Rai', local: 'Odette', place: 'Philippines', city: 'Surigao City', wind: 195, avg: 10, pc: 915, heading: 280, speed: 25, dist: 25, side: 'left', landfall: -1, lat: 9.8, deaths: '~410', desc: 'A rare December super typhoon that intensified rapidly just before hitting Siargao, leaving little time to prepare.' },
  { id: 'ketsana2009', year: 2009, name: 'Ketsana', local: 'Ondoy', place: 'Philippines', city: 'Marikina, Metro Manila', wind: 85, avg: 10, heading: 275, speed: 15, dist: 30, side: 'left', landfall: -3, lat: 14.6, rainBoost: 3.8, deaths: '~460', observed: '455 mm in 24 h at Science Garden, Quezon City', desc: 'Only a tropical storm, but it dragged in the monsoon: a month of rain in a day. The Marikina River rose ~6 m and flooded most of the city.' },
  { id: 'mangkhut2018', year: 2018, name: 'Mangkhut', local: 'Ompong', place: 'Hong Kong', city: 'Hong Kong', wind: 175, avg: 10, pc: 955, heading: 290, speed: 30, dist: 100, side: 'right', landfall: 5, r34: 350, lat: 22.3, deaths: '0 in Hong Kong (134 overall)', desc: 'A huge storm passing 100 km south of Hong Kong. Heavy damage, but strict codes and warnings meant no deaths in the city.' },
  { id: 'hagibis2019', year: 2019, name: 'Hagibis', place: 'Japan', city: 'Kawasaki (Tama River)', wind: 165, avg: 10, pc: 955, heading: 20, speed: 35, dist: 30, side: 'right', landfall: -2, r34: 400, lat: 35.5, rainBoost: 1.8, deaths: '~100', desc: 'A large storm with an enormous rain shield; record rain in the mountains (~922 mm in 24 h at Hakone) broke river levees across eastern Japan.' },
  { id: 'nargis2008', year: 2008, name: 'Nargis', place: 'Myanmar', city: 'Bogale, Irrawaddy delta', wind: 215, avg: 1, pc: 962, heading: 70, speed: 15, dist: 15, side: 'right', landfall: -1, lat: 16.3, rainBoost: 1.2, deaths: '≥138,000', desc: 'Struck a low, densely farmed delta with no shelters and almost no warning. Nearly all deaths came from the 4 m storm surge (simulated in a later phase).' },
  { id: 'katrina2005', year: 2005, name: 'Katrina', place: 'USA', city: 'New Orleans', wind: 205, avg: 1, pc: 920, heading: 5, speed: 20, dist: 40, side: 'left', landfall: -2, lat: 30.0, deaths: '~1,400', desc: 'The eye passed east of New Orleans. Wind damage was moderate; the storm surge broke the city’s flood walls.' },
  { id: 'maria2017', year: 2017, name: 'Maria', place: 'Puerto Rico', city: 'San Juan', wind: 250, avg: 1, pc: 917, heading: 300, speed: 15, dist: 25, side: 'right', landfall: -3, lat: 18.4, rainBoost: 1.4, deaths: '~2,975 (excess deaths)', desc: 'A Category 4 crossing the whole island diagonally. The grid collapsed and most deaths came in the months without power.' },
  { id: 'idai2019', year: 2019, name: 'Idai', place: 'Mozambique', city: 'Beira', wind: 195, avg: 1, pc: 950, heading: 270, speed: 10, dist: 10, side: 'right', landfall: -0.5, lat: -19.8, rainBoost: 1.5, deaths: '~1,300', desc: 'A southern-hemisphere cyclone (winds turn clockwise, the left side is the strong one). Surge, then river floods from rain over the interior.' },
  { id: 'harvey2017', year: 2017, name: 'Harvey', place: 'USA', city: 'Houston', wind: 215, avg: 1, pc: 938, heading: 0, speed: 4, dist: 130, side: 'right', landfall: -24, lat: 29.8, rainBoost: 3, deaths: '~107', observed: 'Up to ~1,500 mm over four days', desc: 'Weakened over land, then stalled for days. Houston saw modest winds and the heaviest rainfall ever recorded in the USA.' },
  { id: 'yagi2024', year: 2024, name: 'Yagi', local: 'Enteng', place: 'Vietnam', city: 'Hải Phòng', wind: 185, avg: 1, pc: 955, heading: 280, speed: 15, dist: 15, side: 'left', landfall: -0.5, lat: 20.9, rainBoost: 1.4, deaths: '~300 in Vietnam', desc: 'Crossed Hainan and the Gulf of Tonkin as a super typhoon. Millions of urban trees fell; floods and landslides followed inland.' },
]

// ---------------------------------------------------------------- Prep tools
export const COSTS = {
  demolishM2: 60, // $/m² floor area
  retrofitM2: 350,
  isolateM2: 1100,
  softStoreyM2: 300, // $/m² footprint: steel frames / shear walls in the ground floor only
  anchorM2: 60, // $/m² facade: ties, parapet bracing, glazing film
  elevateM2: 1400, // $/m² footprint
  leveeCell: 0.3, // $M per 10 m of 3 m flood wall
  pump: 6,
  pond: 1.5,
  park: 0.25,
}

export const LEVEE_HEIGHT = 3
export const PUMP_RATE = 10 // m³/s
export const POND_DEPTH = 3.5

export const UPGRADES = {
  floodWarning: {
    name: 'Typhoon early warning & pre-emptive evacuation',
    desc: 'River gauges, sirens and a plan tied to the PAGASA wind signals: low-lying districts are evacuated as soon as Signal No. 3 is raised or the river nears its banks.',
    cost: () => 1.5,
    disaster: 'typhoon',
  },
  drainage: {
    name: 'Storm-drain upgrade',
    desc: '+15 mm/h drainage capacity city-wide. Drains stop working when the river is above its banks.',
    cost: (city, lvl) => Math.round(city.urbanCells * 0.004 * (1 + lvl * 0.5) * 10) / 10,
    max: 2,
    disaster: 'typhoon',
  },
  dredge: {
    name: 'River dredging & widening',
    desc: 'Deepens the river channel by 1.5 m, raising how much flow it can carry before overtopping.',
    cost: (city) => (city.type === 'rural' ? 12 : 20),
    disaster: 'typhoon',
  },
  quakeWarning: {
    name: 'Earthquake early warning',
    desc: 'Seconds of warning before strong shaking arrives. People drop, cover and hold on: fewer deaths and critical injuries.',
    cost: () => 3,
    disaster: 'quake',
  },
  gasShutoff: {
    name: 'Seismic gas shut-off valves',
    desc: 'Automatic valves cut gas lines when shaking is detected. About 60% fewer post-quake fires.',
    cost: (city) => Math.round(city.buildings.length * 0.004 * 10) / 10,
    disaster: 'quake',
  },
  // Programs apply a building measure to every building that qualifies. The
  // cost is the sum of the individual jobs times the city's share (owners
  // and bulk contracts cover the rest); the game works it out.
  softStoreyProgram: {
    name: 'Soft-storey retrofit ordinance',
    desc: 'Every older building with an open shopfront ground floor gets it braced, as Los Angeles (2015) and San Francisco (2013) required. Owners share the cost: the city pays 60%.',
    program: { tool: 'softstorey', share: 0.6 },
    disaster: 'quake',
  },
  facadeProgram: {
    name: 'Parapet & facade securing order',
    desc: 'Masonry parapets and tall facades city-wide are tied back, as New Zealand ordered after Christchurch 2011 with a 50% subsidy.',
    program: { tool: 'anchor', share: 0.5 },
    disaster: 'quake',
  },
  urmProgram: {
    name: 'Unreinforced masonry retrofit program',
    desc: "Strengthens every unreinforced masonry building to a reinforced frame, as California's 1986 URM law required. The city pays 70%.",
    program: { tool: 'retrofit', share: 0.7, construction: 'urm' },
    disaster: 'quake',
  },
  criticalProgram: {
    name: 'Hospitals, schools & fire stations',
    desc: 'Brings every hospital, school, fire station and shelter up to high seismic code, so they stay open after the quake (California SB 1953, Istanbul ISMEP). Full cost.',
    program: { tool: 'retrofit', share: 1, types: ['hospital', 'school', 'fire', 'shelter'], full: true },
    disaster: 'quake',
  },
}

export const SPEEDS = [
  { label: '1 min/s', mult: 60 },
  { label: '5 min/s', mult: 300 },
  { label: '15 min/s', mult: 900 },
  { label: '1 h/s', mult: 3600 },
]
