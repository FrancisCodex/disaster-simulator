// The typhoon's after-action report (docs/typhoon-prep-research.md §4): what
// the preparations changed, pillar by pillar, against the same storm on the
// city as it was generated, and estimates of what recovery will face.
//
// Built from StormRun.summary() objects: `real`, the run the player watched,
// and the shadow runs from stormShadow.js, which arrive a little later:
// `none` (the city as generated, no upgrades, the default plan) and, when the
// player both planned and built, `plan` (the city as generated with only the
// plan and the warning upgrades). With both, the plan's share is none → plan
// and the works' share is plan → real; the works' share is then split by the
// hazard each death or loss came from. A shadow that is still running is
// `undefined` (shown as pending); one that isn't coming is `null`.
//
// The recovery lines are estimates from simple rules, each stated in the
// report; the operations update will simulate them.

import { CONSTRUCTION } from './config.js'
import { PLAN_ACTIONS } from './evacPlan.js'
import { fmtInt } from './math.js'

// what each spending key counts towards
export const TY_PILLAR = {
  floodWarning: 'people',
  surgeWarning: 'people',
  drills: 'people',
  shelter: 'people',
  cycshelter: 'people',
  levee: 'water',
  pump: 'water',
  bigpump: 'water',
  pond: 'water',
  elevate: 'water',
  park: 'water',
  drainage: 'water',
  tideGates: 'water',
  dredge: 'water',
  floodway: 'water',
  seawall: 'coast',
  rivergate: 'coast',
  mangrove: 'coast',
  relocation: 'coast',
  straps: 'wind',
  fixings: 'wind',
  shutters: 'wind',
  rod: 'wind',
  windCodeProgram: 'wind',
  criticalWindProgram: 'wind',
  treeCare: 'wind',
  poles: 'power',
  pumpGenerators: 'power',
}
// the upgrades the plan-only run keeps: they change how people are warned and move, not the city
export const PEOPLE_UPGRADES = ['floodWarning', 'surgeWarning', 'drills']

const PILLARS = [
  { key: 'people', label: 'Plan, warnings & shelters' },
  { key: 'water', label: 'Rain & river defences' },
  { key: 'coast', label: 'Coastal defences' },
  { key: 'wind', label: 'Wind-proofing' },
  { key: 'power', label: 'Power lines & generators' },
  { key: 'other', label: 'Other building work' },
]
// deaths by the hazard behind them (FloodImpact.deathsByCause)
const CAUSES = { water: ['drowning', 'collapse', 'evacuation'], coast: ['surge'], wind: ['wind', 'roof', 'tornado', 'fire'] }

// recovery rules of thumb (see the notes in the report)
const LEPTO = [0.001, 0.004] // leptospirosis cases per person who waded: Ondoy's ~2,100 cases for roughly a million exposed (verify)
const LEPTO_CFR = 0.076 // Ondoy: ~160 deaths in ~2,100 cases
const ROAD_CREW = 6 // blocked road sections (a fallen tree or pole) one chainsaw crew clears in a day
const DEBRIS_CREW = 100 // tonnes a loader-and-truck crew hauls in a day

const sumOf = (o, keys) => keys.reduce((a, k) => a + (o[k] || 0), 0)
const pct = (x) => `${Math.round(x * 100)}%`
const approx = (n) => (n < 0.5 ? '0' : `~${fmtInt(n)}`)
const hours = (h) => `${h.toFixed(h < 10 ? 1 : 0)} h`
const crewDays = (n) => `~${n} crew-day${n === 1 ? '' : 's'}`
const homelessOf = (S) => S.uninhabitable.destroyed + S.uninhabitable.roof + S.uninhabitable.flood

/** When simulation time t (s) fell, against the storm's closest approach. */
function whenOf(S, t) {
  const tau = S.startH + t / 3600
  if (tau < -0.5) return `${Math.round(-tau)} h before closest approach`
  if (tau > 0.5) return `${Math.round(tau)} h after closest approach`
  return 'at closest approach'
}

/** The first evacuation order the plan gave (s), or null. */
function firstOrder(S) {
  const t = S.steps.filter((s) => PLAN_ACTIONS[s.action].zone || s.action === 'forced').map((s) => s.t)
  return t.length ? Math.min(...t) : null
}

/** Warning time before a hazard arrived: from the first evacuation order to its mark. */
function leadOf(S, mark) {
  const at = S.marks[mark]
  if (at == null) return { text: 'never came', h: Infinity }
  const o = firstOrder(S)
  if (o == null) return { text: 'no order', h: -Infinity }
  const h = (at - o) / 3600
  return h < 0 ? { text: `order ${hours(-h)} late`, h } : { text: hours(h), h }
}

/**
 * Days for the power to come back to 70% and 95% of the city: a couple of
 * days to assess the damage (more if the transmission line feeding the city
 * is down), then the outage shrinks exponentially as crews work. Tuned so that
 * a whole-city outage reaches 70% in ~6 days and 95% in ~11–12, as after
 * Irma and Sandy; concrete poles and buried lines come back faster.
 */
export function restoreDays(S) {
  const out = 1 - S.power.now
  const d0 = S.power.gridUp ? 1 : 2.3
  const tau = 3.1 * [1, 0.8, 0.5][S.poles || 0]
  const at = (left) => (out <= left ? 0 : d0 + tau * Math.log(out / left))
  return { d70: at(0.3), d95: at(0.05), out }
}

/** Deaths by where people were: at home or work, in a shelter, or on the move. */
function whereOf(S, outdoor) {
  const move = (S.causes.evacuation || 0) + outdoor
  return { home: Math.max(0, S.dead - S.deadShelter - (S.causes.evacuation || 0)), shelter: S.deadShelter, move }
}

/**
 * ctx: { real, none, plan (summaries; undefined while pending, null if not run), outdoorDead,
 * spentBy, spent, planChanged, coast, shoreRise }
 */
export function typhoonReport(ctx) {
  const { real: R, none: A, outdoorDead: out = 0 } = ctx
  // every run gets this run's deaths in the street (the shadow runs have no people outdoors)
  const deadOf = (S) => S.dead + out
  const pending = A === undefined
  const row = (label, get, fmt, { lower = true, hide } = {}) => {
    const now = get(R)
    const r = { label, now: fmt(now) }
    if (pending) r.before = '…'
    else if (A) {
      const was = get(A)
      r.before = fmt(was)
      // better or worse only when both are numbers, and they show differently
      if (Number.isFinite(now) && Number.isFinite(was) && r.now !== r.before) r.better = lower ? now < was : now > was
    }
    if (hide?.(now, A ? get(A) : now)) return null
    return r
  }
  const sections = []

  // ---------------------------------------------------------- warning and evacuation
  {
    const rows = [
      row('Warning before gale-force winds', (S) => leadOf(S, 'gale').h, leadText, { lower: false, hide: never }),
      ctx.coast && row('Warning before the sea came ashore', (S) => leadOf(S, 'seaAshore').h, leadText, { lower: false, hide: never }),
      row('Warning before water got into homes', (S) => leadOf(S, 'homesFlooded').h, leadText, { lower: false, hide: never }),
    ]
    // who had left each zone by the time the hazard reached the first home in it
    const ZONES = [
      ['coast', 'Coastal zone out before seawater got in'],
      ['river', 'Low-lying & riverside homes out before floodwater got in'],
      ['light', 'Light-material homes out before the first roof went'],
    ]
    for (const [z, label] of ZONES) {
      if (!R.zonePeople[z] || (z === 'coast' && !ctx.coast)) continue
      rows.push(row(label, (S) => (S.marks[z] == null ? null : (S.zoneShare[z] ?? 0)), (v) => (v == null ? 'never reached' : pct(v)), { lower: false, hide: (a, b) => a == null && b == null }))
    }
    const W = (S) => whereOf(S, out)
    rows.push(row('Died at home or at work', (S) => W(S).home, approx))
    rows.push(row('Died in shelters', (S) => W(S).shelter, approx, { hide: (a, b) => a < 0.5 && b < 0.5 }))
    rows.push(row('Died on the move (wading, outdoors)', (S) => W(S).move, approx))
    rows.push(row('Person-hours in overcrowded shelters', (S) => S.crowdHours, (v) => fmtInt(v), { hide: (a, b) => a < 1 && b < 1 }))
    const steps = R.steps.map((s) => `${PLAN_ACTIONS[s.action].name}: ${whenOf(R, s.t)}`)
    const lessons = []
    const late = ZONES.filter(([z]) => R.zonePeople[z] && R.marks[z] != null && (R.zoneShare[z] ?? 0) < 0.5)
    if (late.length)
      lessons.push(
        `Most people in ${late.map(([z]) => ({ coast: 'the coastal zone', river: 'the low-lying areas', light: 'light-material homes' })[z]).join(' and ')} were still at home when the hazard reached them. People take hours to move: orders at Signal No. 3, or on the surge warning, give them those hours (Albay's pre-emptive evacuations).`,
      )
    else if (R.steps.length) lessons.push('The plan got people moving before the hazards arrived: that, more than anything built, is what keeps deaths down (Bangladesh, 1970 → 2007).')
    if (R.crowdHours > 100) lessons.push('Shelters were packed beyond 3.5 m² a person (the Sphere standard). Crowding spreads disease and makes people slower to come next time: more, or larger, shelters.')
    sections.push({ key: 'people', title: 'Warning & evacuation', rows: rows.filter(Boolean), list: steps.length ? { title: 'What the plan did, and when', items: steps } : null, lessons })
  }

  // -------------------------------------------------------------------- water
  {
    const W = (S) => S.water
    const rows = [
      row('Peak river vs its banks', (S) => W(S).stageMax, (v) => (v > 0 ? `${v.toFixed(1)} m over` : `${(-v).toFixed(1)} m below`)),
      row('Land under more than 0.3 m of water', (S) => W(S).haFlooded, (v) => `${v.toFixed(1)} ha`),
      row('Buildings flooded', (S) => S.flooded, fmtInt),
      row('Pump stations drowned', (S) => W(S).pumpsDrowned, fmtInt, { hide: () => !R.water.pumps }),
      row('Pump stations stopped by the blackout', (S) => W(S).pumpsDark, fmtInt, { hide: () => !R.water.pumps }),
      row('Water diverted by the floodway', (S) => W(S).diverted / 1e6, (v) => `${v.toFixed(1)} M m³`, { lower: false, hide: (a) => a <= 0 }),
    ]
    const LINKS = { drains: 'The storm drains backed up (river or sea over their outfalls)', overtop: 'The river overtopped its banks', breach: 'A flood wall was breached', pumpDrowned: 'A pump station flooded and failed', pumpDark: 'A pump station lost power', gateShut: 'The river gate shut against the surge', flooding: 'The streets flooded' }
    const items = Object.entries(LINKS)
      .filter(([k]) => R.marks[k] != null)
      .sort((a, b) => R.marks[a[0]] - R.marks[b[0]])
      .map(([k, text]) => `${text}: ${whenOf(R, R.marks[k])}`)
    const lessons = []
    const first = ['drains', 'overtop', 'breach', 'pumpDrowned', 'pumpDark'].filter((k) => R.marks[k] != null).sort((a, b) => R.marks[a] - R.marks[b])[0]
    if (first)
      lessons.push(
        {
          drains: 'The first link to fail was the drains: with the river or the sea over their outfalls they backed up while it was still pouring. Flap gates on the outfalls keep them working.',
          overtop: 'The first link to fail was the river channel itself. Walls along the banks, dredging and a floodway upstream each buy capacity; above the design flow it floods regardless (Ondoy).',
          breach: 'The first link to fail was a flood wall. Walls that are overtopped erode and breach: build them higher than the forecast peak, or wide enough not to fail.',
          pumpDrowned: 'The first link to fail was a pump station that flooded. Pumps belong on high ground or behind their own wall.',
          pumpDark: 'The first link to fail was the power to the pumps. A backup generator keeps a pump running through the blackout.',
        }[first],
      )
    sections.push({ key: 'water', title: 'Rain & river', rows: rows.filter(Boolean), list: items.length ? { title: 'How the water got in', items } : null, lessons })
  }

  // -------------------------------------------------------------------- coast
  if (ctx.coast) {
    const rows = [
      row('Peak sea above normal', (S) => S.water.seaMax ?? 0, (v) => `${v.toFixed(1)} m`, { hide: () => false }),
      row('Buildings reached by seawater', (S) => S.water.seaBuildings, fmtInt),
      row('Storm-surge deaths', (S) => S.causes.surge || 0, approx),
      row('Residents resettled out of the danger zone', (S) => S.resettled, fmtInt, { lower: false, hide: (a) => !a }),
    ]
    const lessons = []
    const sea = R.water.seaMax ?? 0
    lessons.push(sea > ctx.shoreRise ? `The sea rose ${sea.toFixed(1)} m, above the ${ctx.shoreRise.toFixed(1)} m beachfront: only walls, raised ground or being somewhere else keep seawater out at that height.` : `The sea stayed below the ${ctx.shoreRise.toFixed(1)} m beachfront this time.`)
    if (R.resettled) lessons.push(`${fmtInt(R.resettled)} people were resettled out of the danger zone. That saves lives, but after Haiyan fewer than two-thirds of the far-away resettlement homes were lived in: people need to be near their work (and fishing families near the sea).`)
    sections.push({ key: 'coast', title: 'Coast & storm surge', rows: rows.filter(Boolean), lessons })
  }

  // --------------------------------------------------------------------- wind
  {
    const w = (S) => S.wind
    const rows = [
      row('Roofs torn off', (S) => w(S).roof, fmtInt),
      row('Roof sheets or tiles lost', (S) => w(S).cover, fmtInt),
      row('Buildings with windows broken', (S) => w(S).glass, fmtInt),
      row('Buildings flattened', (S) => w(S).collapsed, fmtInt),
      row('Roof sheets sent flying', (S) => w(S).missiles, fmtInt),
      row('…windows those sheets broke', (S) => w(S).missileGlass, fmtInt),
      row('Trees down', (S) => w(S).trees, fmtInt),
    ]
    const lessons = []
    if (R.wind.missileGlass >= 3) lessons.push('Flying sheets from upwind roofs broke windows downwind, and a broken window lets the wind push roofs off from inside: fixing sheets to every purlin and shuttering windows breaks the chain at both ends.')
    if (A && A.wind.roof > R.wind.roof * 1.5 && A.wind.roof >= 5) lessons.push(`Straps, fixings and shutters kept ${fmtInt(A.wind.roof - R.wind.roof)} roofs on: about $20 of straps a house is what kept the upper storey on in IBHS's tests.`)
    sections.push({ key: 'wind', title: 'Wind', rows, lessons })
  }

  // -------------------------------------------------------------------- power
  {
    const rows = [
      row('City with power at the worst point', (S) => S.power.min, pct, { lower: false }),
      row('City with power at the end', (S) => S.power.now, pct, { lower: false }),
      row('Days to restore 70% of the city', (S) => restoreDays(S).d70, (d) => (d < 0.5 ? 'none needed' : `~${Math.round(d)}`)),
      row('Days to restore 95%', (S) => restoreDays(S).d95, (d) => (d < 0.5 ? 'none needed' : `~${Math.round(d)}`)),
    ]
    const lessons = []
    if (!R.power.gridUp) lessons.push('The transmission line that feeds the city went down: no local measure prevents that, only generators at the places that must keep running (pumps, hospitals, shelters).')
    sections.push({ key: 'power', title: 'Power', rows, lessons, note: 'Restoration: about two days to assess the damage (one if the transmission line held), then crews bring back a share of what is left each day, so that a whole-city outage reaches 70% in ~6 days and 95% in ~11–12 (Irma, Sandy). Concrete poles and buried lines come back faster.' })
  }

  // ------------------------------------------------------------------ recovery
  {
    const homeless = homelessOf
    const lepto = (S) => [S.waded * LEPTO[0], S.waded * LEPTO[1]]
    const rows = [
      row('People whose homes are unlivable', homeless, fmtInt),
      row('…homes destroyed (months to rebuild)', (S) => S.uninhabitable.destroyed, fmtInt),
      row('…roof gone (weeks, once materials arrive)', (S) => S.uninhabitable.roof, fmtInt),
      row('…flooded over 0.5 m (1–3 weeks of clean-up)', (S) => S.uninhabitable.flood, fmtInt),
      row('Shelter space at 3.5 m² a person', (S) => S.shelterCap, fmtInt, { lower: false }),
      row('Road sections blocked by fallen trees', (S) => S.wind.roads, (v) => `${fmtInt(v)} (${crewDays(Math.ceil(v / ROAD_CREW))})`),
      row('Debris to clear', (S) => S.debris, (v) => `${fmtInt(v)} t (${crewDays(Math.ceil(v / DEBRIS_CREW))})`),
      row('People who waded through floodwater', (S) => S.waded, fmtInt),
      row('Expected leptospirosis cases', (S) => lepto(S)[1], (v) => (v < 0.5 ? 'none expected' : `${fmtInt(v / 4)}–${fmtInt(v)}`)),
    ]
    const lessons = []
    const h = homeless(R)
    if (h > R.shelterCap && h > 0) lessons.push(`${fmtInt(h - R.shelterCap)} more people need a roof than the shelters hold at the Sphere standard. Schools fill the gap in the Philippines, but DepEd limits that to 15 days: rebuilding has to start fast.`)
    const L = lepto(R)
    if (L[1] >= 1) lessons.push(`Wading through floodwater spreads leptospirosis: expect ${fmtInt(L[0])}–${fmtInt(L[1])} cases in the weeks after, and ${L[1] * LEPTO_CFR < 1 ? 'possibly a death' : `up to ~${fmtInt(L[1] * LEPTO_CFR)} deaths`} without treatment. Doxycycline for everyone who waded prevents most of them (after Ondoy, cases rose five-fold).`)
    const byClass = Object.entries(R.lossByClass).sort((a, b) => b[1] - a[1])
    const total = byClass.reduce((s, [, v]) => s + v, 0)
    if (total > 0) lessons.push(`Damage by building type: ${byClass.slice(0, 3).map(([c, v]) => `${CONSTRUCTION[c]?.name.toLowerCase() ?? c} ${pct(v / total)}`).join(', ')}.`)
    sections.push({
      key: 'recovery',
      title: 'Recovery outlook (estimates)',
      rows,
      lessons,
      note: `Rules of thumb, for scale: a chainsaw crew clears ~${ROAD_CREW} blocked road sections a day and a loader-and-truck crew hauls ~${DEBRIS_CREW} t of debris; leptospirosis at ${LEPTO[0] * 100}–${LEPTO[1] * 100}% of people who waded, scaled from Ondoy (2009). The next update simulates the crews, shelters and treatment.`,
    })
  }

  return { pending, prepared: !!ctx.planChanged || ctx.spent > 0, roofs: R.wind.roof, homeless: homelessOf(R), compare: compareOf(ctx, deadOf), sections }
}

const never = (a, b) => a === Infinity && b === Infinity

function leadText(h) {
  if (h === Infinity) return 'it never came'
  if (h === -Infinity) return 'no order given'
  return h < 0 ? `order ${hours(-h)} late` : hours(h)
}

/** With and without the preparations, and how the difference splits between the pillars. */
function compareOf(ctx, deadOf) {
  const { real: R, none: A, plan: B, spentBy = {}, spent = 0, planChanged } = ctx
  if (A === undefined) return { pending: true }
  if (!A) return null
  const without = { dead: deadOf(A), flooded: A.flooded, destroyed: A.destroyed, roofs: A.wind.roof, homeless: homelessOf(A), loss: A.loss }
  const saved = { lives: deadOf(A) - deadOf(R), loss: A.loss - R.loss }
  const works = Object.keys(spentBy).some((k) => !PEOPLE_UPGRADES.includes(k))
  const spend = {}
  for (const [k, v] of Object.entries(spentBy)) spend[TY_PILLAR[k] ?? 'other'] = (spend[TY_PILLAR[k] ?? 'other'] || 0) + v
  const rows = []
  for (const P of PILLARS) {
    const r = { key: P.key, label: P.label, spent: spend[P.key] || 0, lives: null, loss: null }
    if (P.key === 'people') {
      if (!planChanged && !r.spent) continue
      // the plan's share: none → plan (or all of it, if nothing was built)
      const X = B ?? (works ? null : R)
      if (X) {
        r.lives = deadOf(A) - deadOf(X)
        r.loss = A.loss - X.loss
      }
    } else if (CAUSES[P.key]) {
      if (!r.spent) continue
      // the works' share, by hazard: plan → real (or none → real, if the plan was left alone)
      const X = B ?? (planChanged ? null : A)
      if (X) {
        r.lives = sumOf(X.causes, CAUSES[P.key]) - sumOf(R.causes, CAUSES[P.key])
        r.loss = X.lossSplit[P.key] - R.lossSplit[P.key]
      }
    } else {
      if (!r.spent) continue
      if (P.key === 'power') r.note = `power at worst ${pct(R.power.min)} (unprepared ${pct(A.power.min)})`
    }
    if (r.loss != null && r.spent > 0) r.bcr = Math.max(0, r.loss) / r.spent
    rows.push(r)
  }
  return { without, saved, rows, spent, bcr: spent > 0 ? Math.max(0, saved.loss) / spent : 0, split: !!B || !works || !planChanged }
}
