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

export const RIVER_HALF_WIDTH = 2.4 // cells
export const RIVER_DEPTH = 4.5 // metres below bank

// ---------------------------------------------------------------- Structures
// medians: PGA (g) at which 50% of buildings reach Slight / Moderate /
// Extensive / Complete damage (lognormal, β = 0.64). Loosely HAZUS-based.
export const FRAGILITY_BETA = 0.64

export const CONSTRUCTION = {
  wood_old: {
    name: 'Wood frame (pre-code)',
    short: 'Old wood',
    medians: [0.18, 0.29, 0.51, 0.77],
    collapse: 0.03,
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
    fire: 0.03,
    floodDV: 8,
    next: null,
    era: 'retrofit',
  },
}

export const DAMAGE_STATES = ['None', 'Slight', 'Moderate', 'Extensive', 'Complete']

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
    schools: 1,
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
    schools: 3,
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
    schools: 5,
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
export const QUAKE_LEVELS = [
  { M: 4.5, name: 'Light', dist: 20, depth: 10, desc: 'Felt by most people indoors. Damage is rare.', example: 'Thousands occur every year worldwide.' },
  { M: 5.5, name: 'Moderate', dist: 14, depth: 10, desc: 'Cracks in plaster, falling objects. Weak masonry may be damaged.', example: '2011 Lorca, Spain (M5.1).' },
  { M: 6.3, name: 'Strong', dist: 9, depth: 8, desc: 'Considerable damage to poorly built structures; old masonry fails.', example: '2011 Christchurch, NZ (M6.2).' },
  { M: 6.9, name: 'Major', dist: 14, depth: 16, desc: 'Serious damage over a wide area. Older concrete frames may collapse.', example: '1995 Kobe, Japan (M6.9).' },
  { M: 7.8, name: 'Severe', dist: 22, depth: 15, desc: 'Widespread destruction. Only well-engineered buildings stay safe.', example: '2023 Türkiye–Syria (M7.8).' },
  { M: 8.5, name: 'Great', dist: 45, depth: 25, desc: 'Long, violent shaking. Severe damage even far from the epicentre.', example: '1950 Assam–Tibet (M8.6).' },
  { M: 9.1, name: 'Megathrust', dist: 70, depth: 25, desc: 'Minutes of shaking. Tall buildings resonate, soft soils liquefy.', example: '2011 Tōhoku, Japan (M9.1).' },
  { M: 9.5, name: 'Largest ever recorded', dist: 60, depth: 30, desc: 'The strongest earthquake in recorded history. Catastrophic.', example: '1960 Valdivia, Chile (M9.5).' },
  { M: 10.0, name: 'Theoretical', dist: 40, depth: 25, desc: 'No recorded precedent; would need a ~5,000 km fault rupture. No current engineering can withstand it.', example: 'Never observed.' },
]

// peak: rainfall rate at the height of the storm (mm/h). The storm ramps up
// over the first hours, then keeps pulsing near that intensity until you end it.
export const FLOOD_LEVELS = [
  { peak: 3, name: 'Light rain', desc: 'Puddles. Storm drains cope easily.', example: 'An ordinary rainy day.' },
  { peak: 8, name: 'Moderate rain', desc: 'Gutters run full. Low spots pond briefly.', example: 'Typical autumn storm.' },
  { peak: 18, name: 'Heavy rain', desc: 'Drains near capacity; street flooding in depressions.', example: 'Monsoon downpour.' },
  { peak: 30, name: 'Very heavy rain', desc: 'Drains overwhelmed, river rising fast toward its banks.', example: 'Tropical storm landfall.' },
  { peak: 50, name: 'Torrential rain', desc: 'River overtops its banks. Low-lying districts flood metres deep.', example: '2009 Typhoon Ketsana (Ondoy), Manila — 455 mm in 24 h.' },
  { peak: 80, name: 'Extreme rainfall', desc: 'Flash flooding everywhere. Basements and subways fill within an hour.', example: '2021 Henan, China — 201.9 mm in a single hour.' },
  { peak: 120, name: 'Catastrophic deluge', desc: 'Beyond almost any recorded sustained rate. Whole valley floor inundated.', example: 'Beyond historical records.' },
]

// ---------------------------------------------------------------- Prep tools
export const COSTS = {
  demolishM2: 60, // $/m² floor area
  retrofitM2: 350,
  isolateM2: 1100,
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
    name: 'Flood early-warning system',
    desc: 'River gauges + sirens. Low-lying districts are evacuated as soon as the forecast turns dangerous.',
    cost: () => 1.5,
    disaster: 'flood',
  },
  drainage: {
    name: 'Storm-drain upgrade',
    desc: '+15 mm/h drainage capacity city-wide. Drains stop working when the river is above its banks.',
    cost: (city, lvl) => Math.round(city.urbanCells * 0.004 * (1 + lvl * 0.5) * 10) / 10,
    max: 2,
    disaster: 'flood',
  },
  dredge: {
    name: 'River dredging & widening',
    desc: 'Deepens the river channel by 1.5 m, raising how much flow it can carry before overtopping.',
    cost: (city) => (city.type === 'rural' ? 12 : 20),
    disaster: 'flood',
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
}

export const SPEEDS = [
  { label: '1 min/s', mult: 60 },
  { label: '5 min/s', mult: 300 },
  { label: '15 min/s', mult: 900 },
  { label: '1 h/s', mult: 3600 },
]
