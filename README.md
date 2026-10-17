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
3. **Simulate:** time runs from 1 minute/s up to 1 hour/s. Rain intensifies every hour and the river rises; earthquakes bring aftershocks, fires, trapped victims and overwhelmed hospitals. Press **End disaster** whenever you like.
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

### Heavy rain and flooding (3 → 120 mm/h peak)

- **Hydraulics:** a 2D shallow-water solver (the *local inertial* scheme from LISFLOOD-FP, Bates et al. 2010) on a 100×100 grid of 10 m cells, with Manning friction. Water really flows downhill, pools in depressions and pours over banks.
- **Hydrology:** rainfall, soil infiltration that decays as the ground saturates, storm drains that back up when the river is high, and an upstream catchment that sends a lagged flood wave down the river.
- **Defences:** flood walls (which can breach when overtopped), pump stations (which fail if their own site floods), retention ponds, river dredging, and elevated buildings.
- **People:** flood warnings trigger evacuation to shelters. Wading through moving water is dangerous. People in tall buildings move upstairs, low-rise homes are deadliest, fire crews perform boat rescues, and buildings fail under high depth × velocity.

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
    floodSim.js     2D flood hydraulics
    floodImpact.js  evacuation, drowning, building failure, damage
    quakeSim.js     ground motion, fragility, aftershocks, fires, rescue
    world.js        Three.js scene (instanced buildings, terrain, water)
    effects.js      particles, rigid-body debris, rain
    game.js         phases, tools, budget, clock, results
  ui/               React HUD (menu, preparation, simulation, results)
```

## Ideas for the future

- More disasters: tsunami, wildfire, tropical cyclone wind, landslide
- Running the flood solver in a Web Worker so 1 h/s is never CPU-limited
- Road network evacuation with traffic
- Save/load and share city layouts
- Localisation

Contributions are welcome. Please keep the science honest: cite a source when you change a model constant.

## License

MIT
