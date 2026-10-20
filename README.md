# MetroRisk

**A 3D city disaster management simulator that runs in your browser.**

Generate a city, choose a natural disaster and how strong it is, then prepare: retrofit weak buildings, build flood walls, hospitals, fire stations and shelters, buy early-warning systems. Then unleash the disaster, watch it unfold hour by hour, and see how many lives your decisions saved.

The goal is to make it easier to see what actually works in disaster preparedness: why unreinforced masonry kills in earthquakes, why early warning matters more than walls in floods, and why some disasters (an M10 earthquake) can't be engineered away.

Everything runs client-side (React + Three.js). There is no server, no account and no tracking.

## Playing

1. **Set up:** pick a city type, a disaster, its intensity, the time of day and a map seed.
   - **Rural Town:** ~1–2k people, low-rise homes, old masonry main street, $40M budget.
   - **Metropolis:** ~15–20k people, mid-rise apartments and an office core, $350M.
   - **Megacity:** ~70k residents / 160k by day, dense towers, $1.2B.
2. **Prepare:** use the tool palette and city-wide upgrades. The *risk map* colours buildings by how vulnerable they are to the chosen scenario. Click any building to see its structure, occupants and estimated damage probability.
3. **Simulate:** time runs from 1 minute/s up to 1 hour/s. Typhoons arrive band by band, wind signals go up and the river rises; earthquakes bring aftershocks, fires, trapped victims and overwhelmed hospitals. Press **End disaster** whenever you like.
4. **Review:** you get a grade, causes of death, and lessons based on what actually happened in your run. Then **Retry with my preparations** to improve.

Controls: left-drag pans, right-drag rotates, scroll zooms. `Space` pauses, `Esc` returns to the inspect tool.

## Disasters and realism

The numbers are simplified from real engineering methods. They're meant to build intuition, not to be used for design.

### Earthquakes (M4.5 → M10.0)

| Level | Magnitude | Real-world reference |
|---|---|---|
| Light | 4.5 | thousands per year |
| Moderate | 5.5 | 2011 Lorca, Spain |
| Strong | 6.3 | 2011 Christchurch |
| Major | 6.9 | 1995 Kobe |
| Severe | 7.8 | 2023 Türkiye–Syria |
| Great | 8.5 | 1950 Assam–Tibet |
| Megathrust | 9.1 | 2011 Tōhoku |
| Largest recorded | 9.5 | 1960 Valdivia |
| Theoretical | 10.0 | never observed |

- **Ground motion:** an attenuation relation (Campbell-style) gives peak ground acceleration from magnitude and distance. Soft river alluvium amplifies shaking and can liquefy. Longer shaking from bigger quakes does more damage, and tall buildings resonate with long-period motion.
- **Damage:** lognormal fragility curves per structure type, loosely based on FEMA HAZUS: pre-code wood, unreinforced masonry, low/moderate/high-code concrete, steel, and base-isolated. Damage accumulates across aftershocks.
- **Aftershocks:** Reasenberg & Jones (1989) rate model (Omori decay + Gutenberg–Richter magnitudes).
- **After the shaking:** post-quake fires (fewer with gas shut-off valves, harder to fight when water mains break), trapped victims whose survival drops over time, search & rescue by fire stations, and hospital surge capacity. Hospitals can be knocked out themselves.
- At M9.5+ ground failure and isolator displacement limits mean no preparation prevents catastrophe.

### Typhoons and tropical cyclones (monsoon low → beyond records)

Pick an intensity tier, reenact one of 12 historical storms (Haiyan/Yolanda, Goni/Rolly, Rai/Odette, Ketsana/Ondoy, Mangkhut, Hagibis, Nargis, Katrina, Maria, Idai, Harvey, Yagi), or build your own from the numbers in a PAGASA or JTWC bulletin. A bulletin's storm position, plus the city's, gives the track. Before you start, a forecast panel shows the peak wind, gusts, wind signal, pressure and rain the city should expect.

- **Storm:** a straight track with the bulletin's heading and forward speed passes the city at a chosen distance and side. Wind follows the Holland (1980/2010) profile, with the radius of maximum wind from Willoughby et al. (2006), pressure from Knaff & Zehr (2007) when none is given, and inland decay after landfall from Kaplan & DeMaria (1995). The storm's motion makes the right side windier in the north (the left in the south), and surface winds spiral inward. If the eye passes over, the wind dies, then returns from the opposite direction. 10-min (PAGASA/JMA) and 1-min (JTWC) winds and 3-s gusts are converted using WMO factors.
- **Rain:** R-CLIPER (Tuleya et al. 2007) gives the average rain rate around the storm. The model adds a rain-free eye, an eyewall ring and rotating spiral rainbands, so the rain pulses as bands sweep over. The same field falls on the upstream catchment and drives the river's flood wave hours later. Slow storms and monsoon or mountain enhancement rain much more.
- **Warnings:** PAGASA's Modified Tropical Cyclone Wind Signals (No. 1–5) are raised over the city with their lead times. The early-warning upgrade evacuates low-lying districts at Signal No. 3.
- **Wind damage:** every building follows the HAZUS-Hurricane chain. Windows break first, and the wind then pushes the roof up from inside. Roof sheets and tiles peel off, then the whole roof lifts, then the walls go. Each step has a fragility on the 3-s gust at roof height, set by structure type and roof type: sheet or tile on timber, metal sheds, or concrete slabs that never blow off.
  - Gusts grow with height, are lower behind taller buildings and higher across the river and parks.
  - Long exposure wears connections loose, and when the back eyewall turns the wind round, a new face of the building takes the load.
  - Torn-off sheets fly downwind and break windows in their path.
  - Trees fall more easily once the soil is soaked. Fallen trees block roads and bring down power lines. Poles snap above ~170 km/h and the line feeding the city fails above ~210 km/h. Unpowered pumps stop.
  - Before the storm, the risk map and the inspect panel show each building's chance of losing its roof or being flattened at the forecast gusts.
- Storm surge, lightning and tornadoes come in later phases: see [docs/typhoon-physics-research.md](docs/typhoon-physics-research.md).

#### Flooding

- **Hydraulics:** a 2D shallow-water solver (the *local inertial* scheme from LISFLOOD-FP, Bates et al. 2010) on a 100×100 grid of 10 m cells, with Manning friction. Water really flows downhill, pools in depressions and pours over banks.
- **Hydrology:** rainfall, soil infiltration that decays as the ground saturates, storm drains that back up when the river is high, and an upstream catchment that sends a lagged flood wave down the river.
- **Defences:** flood walls (which can breach when overtopped), pump stations (which fail if their own site floods), retention ponds, river dredging, and elevated buildings.
- **People:** flood warnings trigger evacuation to shelters. Wading through moving water is dangerous. People in tall buildings move upstairs, low-rise homes are deadliest, fire crews perform boat rescues, and buildings fail under high depth × velocity.

### Structural physics

- Buildings sway as damped oscillators with a period of about 0.1 s per storey and bend in their first mode, so skyscrapers whip slowly in the long-period waves of great earthquakes.
- Collapses take three forms:
  - **Progressive:** ductile modern frames sway, then come down vertically. Storeys crush at the base while the top stays intact as it descends.
  - **Partial:** upper floors shear off and fall as one block that shatters on impact.
  - **Topple:** only for a weak base, meaning liquefied soil or a brittle older frame. The building rotates intact like a falling column until its face strikes the ground or a neighbour, then breaks apart and passes its energy to whatever it hit.
- Debris is simulated as rigid bodies. Pieces land on roofs as well as the ground, and their impact energy damages the buildings they hit, which can bring down neighbours. Shaking also sheds glass and cladding from tall facades onto the street.

### City life

- Roads are real geometry with high-resolution markings, zebra crossings, stop lines, raised kerbs and sidewalks. Bridges span bank to bank on piers, and roads that reach the river without a bridge end at a "ROAD CLOSED" barricade.
- Sedans, hatchbacks, SUVs, vans, buses and box trucks drive in lanes with car-following, and stop at red and amber signals and for anyone in the road. Pedestrians walk the sidewalks and cross only at crosswalks on a green. Street activity follows the time of day.
- **Earthquake:** drivers stop, people run from buildings to open ground, and debris crushes cars (some catch fire) and strikes pedestrians. Rubble blocks streets.
- **Typhoon floods:** cars stall, then float away with the current; people shelter in sturdy buildings or head for high ground, and anyone caught in deep, fast water is swept away.
- Outdoor casualties count toward the results.

## Running locally

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Then open the printed URL (usually http://localhost:5173).

## Hosting it

`npm run build` produces a fully static site in `dist/` (with relative paths), so it works on any static host: GitHub Pages, Netlify, Cloudflare Pages, Vercel or itch.io. You can also open it from a USB stick through any static file server.

## Project layout

```
src/
  engine/
    config.js       all tunable data: structures, fragility, levels, costs
    cityGen.js      procedural terrain, river, roads, lots and buildings
    typhoonPhysics.js storm track, wind, pressure, rain and wind signals
    typhoonSim.js   the typhoon passing over the city, hour by hour
    windDamage.js   roofs, windows, collapses, trees and power in the wind
    floodSim.js     2D flood hydraulics
    floodImpact.js  evacuation, drowning, building failure, damage
    quakeSim.js     ground motion, fragility, aftershocks, fires, rescue
    world.js        Three.js scene (instanced buildings, terrain, water)
    effects.js      particles, rigid-body debris, rain
    game.js         phases, tools, budget, clock, results
  ui/               React HUD (menu, preparation, simulation, results)
```

## Ideas for the future

- Typhoon phases 3–5: storm surge, lightning and tornadoes, wind preparations
- More disasters: tsunami, wildfire, landslide
- Running the flood solver in a Web Worker so 1 h/s is never CPU-limited
- Road network evacuation with traffic
- Save/load and share city layouts
- Localisation

Contributions are welcome. Please keep the science honest: cite a source when you change a model constant.

## License

MIT for the code.

Vehicle and character models in `public/models/quaternius/` are by [Quaternius](https://quaternius.com) (Cars, Public Transport, Animated Men and Animated Women packs) and are released under CC0. Licence files are in `public/models/quaternius/licenses/`; the Public Transport pack has no licence file, but its page states CC0. They are converted from FBX with `node scripts/convert-quaternius.mjs <folder with the FBX files>`. The **Models** button switches between them and the built-in procedural models.
