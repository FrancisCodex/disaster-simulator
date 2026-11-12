// The event log, retold as a news feed: every event becomes a bulletin or a
// story with a headline, and some of them draw a post from someone in the
// city. Nothing here is random at render time: the choices hang off a hash
// of the event, so the same event always reads the same way.

const hash = (str) => {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619)
  return h >>> 0
}

const HANDLES = [
  '@tricycle_tito',
  '@nightshift_nars',
  '@sarisari_lena',
  '@kuya_migs',
  '@roofdeck_ana',
  '@jeep_route_12',
  '@lola_remy',
  '@eastside_dad',
  '@riverside_runner',
  '@tindahan_ni_bong',
  '@third_floor_jo',
  '@marketday_fe',
  '@bikemessenger_rk',
  '@teacher_celia',
  '@harbor_cook',
  '@late_bus_dan',
]

// what people say, by what the event is about; the first rule that matches wins
const POSTS = [
  [/tornado/i, ['That is a funnel. That is an actual funnel over the rooftops.', 'Everyone into the bathroom, mattress over our heads. Praying.', 'Sounded like a freight train going down the next street.']],
  [/lightning|thunderstorm/i, ['Lightning every few seconds. The dog has not come out from under the bed.', 'That strike was CLOSE. Whole room went white.', 'Unplugged everything. The sky will not stop flashing.']],
  [/blackout|power cut|lost power|without power|transmission/i, ['Power just went on our block. Phone at 31%.', 'Whole street went dark at once. Candles out.', 'No power, no signal on one network. Is anyone else getting through?']],
  [/eye is passing|eye of/i, ['It just… stopped. Blue sky. Neighbours are out looking at their roofs.', 'Do NOT go outside, this is the eye. My lola says the second half is worse.']],
  [/surge|sea is rising|sea has drawn|seawater/i, ['The sea is in the street. Not rain. The SEA.', 'Water came up the road faster than I could walk. We are on the second floor now.', 'Boats from the harbour are sitting in the car park.']],
  [/levee|flood wall|breach|overtop/i, ['The wall by the river just gave. Water is pouring through.', 'They said the levee would hold. It is not holding.']],
  [/swept away|floodwater|flooded|river|pump|barrier|flood/i, ['Water is coming up through the drains on our street. Moving the car now.', 'Never seen the river this high. Stay off the bridges.', 'Ground floor is gone. We are upstairs with the kids. Please send boats.', 'Knee-deep on the main road already. Do not drive this way.']],
  [/evacuat|shelter|suspended|rescue boats/i, ['Packed two bags and the documents. Heading to the shelter with the neighbours.', 'Barangay officials are going door to door. If they say go, GO.', 'Shelter is filling up fast. Bring water and a blanket if you are coming.', 'School sent everyone home. Roads are jammed already.']],
  [/roof|flattened|destroyed by gusts|shutters|windows are breaking|glass/i, ['Our neighbour’s roof just went past the window. Not joking.', 'Sheets of metal flying down the street like paper.', 'Windows on the tower across from us are popping one after another.']],
  [/tree|pole|street lights|live wires|road/i, ['Big acacia down across our road. Nobody is getting through.', 'Wires down and sparking on the corner. Stay away from them.']],
  [/wind|signal|gale|typhoon|cyclone|landfall|eyewall/i, ['The whole house is humming. Never heard wind like this.', 'Taped the windows, filled every bucket. Now we wait.', 'Rain is going sideways. Could not see the house across the street.', 'Stocked up on rice and candles this morning. Shelves were nearly empty.']],
  [/aftershock/i, ['Another one. I am not going back inside tonight.', 'Just when the kids had stopped crying. Felt that one in my teeth.', 'Sleeping in the plaza with half the street. Every aftershock, everyone screams.']],
  [/liquef|quicksand|sand boils|settle|leaning/i, ['The ground is bubbling. Grey water and sand coming up out of the pavement.', 'The building next door is tilting. You can see it against the sky.']],
  [/landslide|hillside/i, ['Half the hill behind us is gone. There were houses up there.']],
  [/bridge|crossing|span/i, ['Bridge is closed. Everyone on our side is cut off from the hospital.', 'Saw the deck drop. Cars stopped a few metres short.']],
  [/fire|burn|ember|gas/i, ['Smoke over the old quarter. You can see the glow from here.', 'Fire jumped to the next roof. No water pressure in the hydrants.', 'Smell of gas all down our street. Nobody light anything.']],
  [/collapse|brought down|debris|damaged|trapped/i, ['The block on the corner is just… gone. People are digging with their hands.', 'Dust everywhere. I can hear someone calling from under the rubble.', 'Cracks right across our stairwell. We got out. Not going back in.']],
  [/panic|frightened|fleeing|abandoned|pulled over/i, ['Everyone is running for the park. Left the car in the road.', 'Traffic has stopped dead. People are getting out and walking.']],
  [/earthquake|shock|shaking|M\d/i, ['EARTHQUAKE. Longest I have ever felt. Everything is off the shelves.', 'Under the table with the kids. It would not stop.', 'Whole office ran down eleven floors. Still shaking, me not the building.']],
  [/lifted|moving away|calming|passed|open:|lowered/i, ['Quiet for the first time in hours. Going out to check on the neighbours.', 'Sun is trying to come out. The street looks like a different place.']],
]

const OFFICIAL = /PAGASA|wind signal|signals have been lifted/i
const CITY_HALL = /TORNADO WARNING|evacuation|suspended|river alarm|barangay|rescue boats|storm shutters/i

/** Split an event into a headline and the rest. */
function headline(text) {
  // the end of the first sentence, not the dot in "No. 3" or an initial
  let cut = text.search(/(?<!\bNo)(?<!\b[A-Z])[.!?…](\s|$)/)
  let head = cut < 0 ? text : text.slice(0, cut)
  let body = cut < 0 ? '' : text.slice(cut + 1).trim()
  // a long first sentence: break at its colon or dash instead
  if (head.length > 88) {
    const m = head.match(/^(.{18,88}?)(: | — | \()/)
    if (m) {
      body = (m[2] === ' (' ? '(' : '') + text.slice(m[1].length + m[2].length).trim()
      head = m[1]
    }
  }
  const cap = (x) => x.replace(/^(\(?)(\w)/, (_, p, c) => p + c.toUpperCase())
  return { head: cap(head), body: cap(body) }
}

/**
 * log: the engine's events ({ t, text, level, n }), oldest first.
 * Returns feed items, oldest first: stories and bulletins ({ kind: 'story' |
 * 'bulletin', source, head, body }) and posts ({ kind: 'post', handle, text }).
 */
export function buildFeed(log, cityName) {
  const out = []
  const press = `The ${cityName.split(' ')[0]} Dispatch`
  for (const e of log) {
    const h = hash(e.text + e.n)
    const { head, body } = headline(e.text)
    const official = OFFICIAL.test(e.text)
    const hall = !official && CITY_HALL.test(e.text)
    out.push({
      id: `s${e.n}`,
      kind: official || hall ? 'bulletin' : 'story',
      t: e.t,
      level: e.level,
      source: official ? 'PAGASA Bulletin' : hall ? 'City Emergency Office' : /^Slowing the clock/.test(e.text) ? 'MetroRisk' : press,
      head,
      body,
    })
    // people post about bad news more than about routine updates
    const chance = e.level === 'bad' ? 60 : e.level === 'warn' ? 45 : 15
    if (h % 100 >= chance) continue
    const rule = POSTS.find(([re]) => re.test(e.text))
    if (!rule) continue
    out.push({ id: `p${e.n}`, kind: 'post', t: e.t, level: e.level, handle: HANDLES[(h >>> 8) % HANDLES.length], text: rule[1][(h >>> 16) % rule[1].length] })
  }
  return out
}

/** Clock time of a moment in the simulation: "09:37", or "Day 2 · 09:37" after the first day. */
export function clockAt(startHour, t, withDay = true) {
  const hour = startHour + t / 3600
  const day = Math.floor(hour / 24) + 1
  const hm = `${String(Math.floor(hour % 24)).padStart(2, '0')}:${String(Math.floor((hour * 60) % 60)).padStart(2, '0')}`
  return withDay && day > 1 ? `Day ${day} · ${hm}` : hm
}

/** "1 h 38 min" since the start. */
export function elapsedText(t) {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`
}
