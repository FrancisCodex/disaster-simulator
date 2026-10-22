// The city's typhoon plan: what is done, and when. Each step pairs an action
// with a trigger, as local disaster offices plan around the PAGASA wind
// signals, storm surge warnings and river alarm levels (Albay's
// "zero casualty" approach evacuates on the forecast, before the signals).
// Triggers that come earlier give people more time to move; forced
// evacuation gets nearly everyone out but needs police and transport.
//
// The plan is evaluated every few simulated minutes against the state of the
// storm; a step fires once, the first time its trigger is met.

// What a step does. zone: who it moves (see FloodImpact.inZone).
export const PLAN_ACTIONS = {
  closeSchools: { name: 'Close schools & offices', desc: 'Classes and work suspended: daytime crowds go home before the weather turns.' },
  shutters: { name: 'Close storm shutters', desc: 'Owners close and bolt the shutters on buildings that have them. Shutters do nothing left open.' },
  evacCoast: { name: 'Evacuate the coast', desc: 'Everyone in homes the forecast surge could reach (below the forecast sea level + 1 m) goes to a shelter.', zone: 'coast', coastal: true },
  evacRiver: { name: 'Evacuate low-lying & riverside areas', desc: 'Homes on low ground near the river leave for shelters.', zone: 'river' },
  evacLight: { name: 'Evacuate light-material homes', desc: 'Families in old timber and unreinforced homes, the ones the wind flattens first, move to sturdier shelter.', zone: 'light' },
  forced: { name: 'Forced evacuation', desc: 'Police and barangay officials move everyone still in the ordered zones. Nearly everyone goes, but it takes trucks and people.', forced: true },
  boats: { name: 'Pre-position rescue boats', desc: 'Boats move from the fire stations to the shelters, where floodwater can\'t trap them.' },
}

// When it is done. kind: what is watched; level: the threshold.
export const PLAN_TRIGGERS = {
  never: { name: 'Not in the plan', kind: 'never' },
  h48: { name: '48 h before closest approach', kind: 'hours', level: -48 },
  h24: { name: '24 h before closest approach', kind: 'hours', level: -24 },
  h12: { name: '12 h before closest approach', kind: 'hours', level: -12 },
  signal1: { name: 'Signal No. 1', kind: 'signal', level: 1 },
  signal2: { name: 'Signal No. 2', kind: 'signal', level: 2 },
  signal3: { name: 'Signal No. 3', kind: 'signal', level: 3 },
  signal4: { name: 'Signal No. 4', kind: 'signal', level: 4 },
  surgeYellow: { name: 'Surge warning: 1–2 m', kind: 'surge', level: 1, coastal: true },
  surgeOrange: { name: 'Surge warning: 2–3 m', kind: 'surge', level: 2, coastal: true },
  surgeRed: { name: 'Surge warning: over 3 m', kind: 'surge', level: 3, coastal: true },
  alarm1: { name: 'River alarm 1 (warning)', kind: 'alarm', level: 1, gauges: true },
  alarm2: { name: 'River alarm 2 (prepare)', kind: 'alarm', level: 2, gauges: true },
  alarm3: { name: 'River alarm 3 (critical)', kind: 'alarm', level: 3, gauges: true },
  flooding: { name: 'When the streets flood', kind: 'flooding' },
}

/** What a city does with no plan: nothing until the water is in the streets. */
export const DEFAULT_PLAN = {
  closeSchools: 'signal3',
  shutters: 'signal3',
  evacCoast: 'flooding',
  evacRiver: 'flooding',
  evacLight: 'never',
  forced: 'never',
  boats: 'never',
}

/** A sound plan for a coastal typhoon city, offered as a starting point. */
export const SUGGESTED_PLAN = {
  closeSchools: 'signal2',
  shutters: 'signal2',
  evacCoast: 'surgeOrange',
  evacRiver: 'signal3',
  evacLight: 'signal3',
  forced: 'signal4',
  boats: 'signal3',
}

/**
 * PAGASA's storm surge warning band in force at τ (0 none, 1 yellow 1–2 m,
 * 2 orange 2–3 m, 3 red > 3 m): issued up to 48 h ahead of the forecast peak.
 */
export function surgeBand(fcSea, tau) {
  if (!fcSea || tau < fcSea.surgeMaxTau - 48) return 0
  const m = fcSea.surgeMax
  return m > 3 ? 3 : m > 2 ? 2 : m >= 1 ? 1 : 0
}

/** River alarm level (0–3) for a river stage (m vs the banks). */
export const alarmLevel = (stage, alarms) => alarms.filter((a) => stage >= a).length

/**
 * Is a trigger met? st: { tau, signal, surge (band), alarm, flooding, gauges (the city has river gauges) }.
 * Without gauges, nobody is reading the river: alarm triggers never fire.
 */
export function triggerMet(key, st) {
  const T = PLAN_TRIGGERS[key]
  if (!T) return false
  switch (T.kind) {
    case 'hours':
      return st.tau >= T.level
    case 'signal':
      return st.signal >= T.level
    case 'surge':
      return st.surge >= T.level
    case 'alarm':
      return st.gauges && st.alarm >= T.level
    case 'flooding':
      return st.flooding
    default:
      return false
  }
}
