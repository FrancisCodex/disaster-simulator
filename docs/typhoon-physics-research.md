# Tropical typhoon / cyclone: physics research for MetroRisk

Purpose: replace the "Heavy Rain & Flooding" disaster with a full **tropical cyclone**: wind, rain, thunderstorms, tornadoes and storm surge. It should offer the same three modes as the earthquake: intensity tiers, historical reenactments, and a custom storm built from a real weather bulletin. This document collects the published models we can use and maps each one onto the existing engine (`floodSim.js`, `floodImpact.js`, `fireSim.js`, `effects.js`, `world.js`, `game.js`, `config.js`).

Numbers come from the sources listed at the end. Where a coefficient should be checked against the original paper before we tune to it, the text says **(verify)**. Like the quake model, this is tuned to be believable for a ~1 km² district, not for engineering design.

---

## 0. The core design problem: a 500 km storm over a 1 km city

A typhoon is 300–1,000 km across. Our district is 1 km. So the district is not something the storm *is in*; it is a **point the storm passes over**. The quake sim already solves the same problem: the rupture is modelled analytically (`quakePhysics.js`), and only its effect at the site is simulated in detail.

So the model has two scales:

| Scale | What is simulated | How |
|---|---|---|
| **Storm scale** (100s of km, hours) | Track, intensity, wind field, rain field, pressure, surge | Analytic parametric models (Holland, R-CLIPER, Kaplan–DeMaria). We evaluate them at the district's position every few simulated seconds. Cost: microseconds. |
| **District scale** (10 m cells, seconds) | Gusts, street channelling, debris, roofs, trees, lightning strikes, tornado path, flood water | The existing 100×100 grid, FloodSim, Rapier debris, fireSim. All of it is driven by the storm-scale time series. |

The player watches the storm approach, sees the outer rainbands arrive, then the eyewall. If the track passes close enough, the calm of the eye follows, and then the wind slams back **from the opposite direction**. That reversal is real: it is what destroys structures already loosened by the first half. It is also the most immersive moment we can give the player, and it falls straight out of the physics with no scripting.

---

## 1. Storm track and intensity

### 1.1 Track
Represent the track as a list of best-track points `{t, lat, lon, vmax, pmin, rmw, r34}`, interpolated in time. Historical storms take their points from **IBTrACS**, the WMO's merged best-track archive. It records 3-hourly or 6-hourly position, wind, pressure and, where available, the radius of maximum wind (USA_RMW) and the radius of gale-force (34 kt) winds (R34).

For tier and custom storms, generate a straight or gently curving track from the inputs below, rather than raw coordinates:

* **Heading** and **forward speed** (km/h). Typical values are 10–30 km/h. Slow storms (<10 km/h) are the rain killers: Ondoy, Harvey and Morakot.
* **Closest approach** (km) and **side** (left or right of the track). This is the typhoon equivalent of the quake's `dist` and `strike`.
* **Landfall** time relative to closest approach, or whether the district is over open water or coastal.

Positions convert to the district's local frame in storm-relative polar coordinates `(r, θ)`, where θ is measured from the direction of motion. Every field below is evaluated at that point.

### 1.2 Wind–pressure relationship
Bulletins give a maximum wind and a central pressure, and the two are not independent. When only one is given, derive the other with **Knaff & Zehr (2007)** as revised by **Courtney & Knaff (2009)**. It uses latitude, size (R34) and translation speed, and reduces the Dvorak error from 7.7 to 5.3 hPa. Then use the pair to check whether a user's custom storm is physically consistent, and warn when it is not.

Environmental pressure `p_env` ≈ 1008–1010 hPa in the West Pacific. Pressure deficit `Δp = p_env − p_c`.

### 1.3 Averaging periods (do not skip this)
PAGASA and JMA report **10-minute** sustained winds. JTWC and NHC report **1-minute** winds. Damage models (HAZUS) use **3-second peak gusts**. If we mix them up, every storm is off by 10–40 %. WMO guidance (Harper et al. 2010):

* 10-min → 1-min: **÷ 0.93** at sea, roughly ÷ 0.88 over land.
* 1-min → 3-s gust: **× 1.23** at sea, **× ~1.35–1.5** over rough land or urban terrain.

Store everything internally as **1-minute wind at 10 m in open terrain**. The UI shows whichever convention the bulletin's agency used (PAGASA by default, since the target players are in the Philippines).

### 1.4 Intensity change after landfall
Use **Kaplan & DeMaria (1995)**, the empirical inland decay model behind NHC's inland wind tool:

```
V(t) = Vb + (R·V0 − Vb) · exp(−α t)
  V0 = intensity at landfall, t = hours since landfall
  R  = 0.9   (the immediate drop from the coastline roughness change)
  Vb = 26.7 kt background,  α = 0.095 h⁻¹   (verify; later versions vary α by latitude)
```

Over water, keep the bulletin's intensity, or interpolate between track points.

---

## 2. The wind field

### 2.1 Symmetric gradient wind: Holland (1980)
This is the standard parametric profile in nearly every catastrophe model and surge model (CLIMADA, HAZUS, ADCIRC forcing):

```
p(r) = p_c + Δp · exp(−(Rmax/r)^B)

V_g(r) = sqrt( (B·Δp/ρ) · (Rmax/r)^B · exp(−(Rmax/r)^B) + (r·f/2)² ) − r·f/2

  ρ = 1.15 kg/m³,  f = 2Ω·sin(lat)   (Coriolis)
  Vmax ≈ sqrt(B·Δp / (ρ·e))          → gives B from a bulletin's Vmax and Δp
```

* **B** (the shape parameter) is usually between 1.0 and 2.5. Large B gives a compact, peaked storm (Haiyan, Goni). Small B gives a broad, flatter storm. When B cannot be derived from Vmax and Δp, use **Holland (2008)**:
  `B = −4.4e-5·Δp² + 0.01·Δp + 0.03·∂p/∂t − 0.014·|lat| + 0.15·v_t^x + 1.0`, with `x = 0.6·(1 − Δp/215)` **(verify)**.
* **Holland et al. (2010)** is a revised version that can be fitted to an observed outer radius such as R34, and it is less sensitive to data errors. In a published surge study, Holland 2010 fitted to R34 had the lowest error. Use it when the bulletin gives a gale radius, which PAGASA and JTWC bulletins usually do.
* **Rmax** (radius of maximum wind): if not supplied, use **Willoughby et al. (2006)**: `Rmax ≈ 46.4·exp(−0.0155·Vmax + 0.0169·|lat|)` km (Vmax in m/s) **(verify)**. Super typhoons come out at about 10–25 km. Note that these regressions are mostly Atlantic-derived.

### 2.2 From gradient level to the street
1. **Surface reduction:** 10 m wind ≈ 0.8 × gradient wind over the sea, and about 0.7 × over land.
2. **Inflow angle:** surface winds spiral **inward**, about 20° across the isobars at sea and 30–40° over land. That matters for which façades take the wind.
3. **Asymmetry from storm motion:** add roughly 0.5–0.6 × the translation velocity, rotated with the wind. In the Northern Hemisphere, the right-front side is stronger and the left side is weaker. Mirror this in the Southern Hemisphere (Idai, Tracy).
4. **Gusts:** the 3-s peak equals the 1-min wind × the gust factor (§1.3). Model the gusts themselves as a field of **coherent gust fronts** sweeping downwind across the grid: low-frequency noise advected at the mean wind speed. Then every roof and tree doesn't peak in the same frame, and the player can watch a gust ripple through the city.
5. **Urban effects at cell level:** a cheap roughness and sheltering map from the existing building heights. Cells in the lee of tall buildings get about 0.6–0.8 × the wind. Streets aligned with the wind and gaps between towers get 1.1–1.3 × (channelling and the Venturi effect). Rooftops of towers see the full gradient-level wind, because exposure rises with height (power-law profile, α ≈ 0.11 at sea and 0.3 urban).

### 2.3 What the player experiences over time
At a fixed site, evaluating `V(r(t), θ(t))` produces a time series. Steady rise, gusty outer bands, eyewall peak, then (if `r` drops below Rmax) the **eye**: wind falls toward zero, the sky partly clears and pressure bottoms out. Then the back eyewall arrives with the wind reversed. Wind direction comes from the tangential vector plus inflow, so it **veers** for sites on the right of the track and **backs** for sites on the left, exactly as observed. None of this needs scripting.

---

## 3. Rain

### 3.1 Axisymmetric rain rate: R-CLIPER (Tuleya et al. 2007, NOAA)

```
R(r) = T0 + (Tm − T0)·(r/rm)        for r ≤ rm
R(r) = Tm · exp(−(r − rm)/re)       for r > rm
```

T0, Tm, rm and re regress on the maximum wind. Example values from CLIMADA's implementation, for weak, medium and strong storms (**verify** against Tuleya 2007 before tuning):

| class | T0 (mm/h) | Tm (mm/h) | rm (km) | re (km) |
|---|---|---|---|---|
| weak (< 34 kt) | 3.1 | 3.4 | 66 | 128 |
| medium (34–63 kt) | 6.1 | 6.9 | 56 | 116 |
| strong (≥ 64 kt) | 11.0 | 12.5 | 41 | 98 |

These are **azimuthal means**, far smoother than what a street experiences. On top of them we add:

### 3.2 Structure the player can see
* **Eyewall:** a ring at about Rmax where rates reach 50–100+ mm/h for 10–30 minutes.
* **Spiral rainbands:** logarithmic spirals rotating with the storm. Inside a band the rate is 3–5× the mean; between bands it is 0.2–0.5×. As the bands sweep over, the rain pulses heavy, light, heavy. This replaces the current `sin()` pulse in `FloodSim.rainRate()` with something physical.
* **Shear asymmetry:** rain concentrates downshear-left. Add a wavenumber-1 term with an "environmental shear" direction.
* **Orographic and stall boost:** a "terrain uplift" multiplier for mountainous presets (Hagibis at Hakone, Morakot in Taiwan). Slow forward speed simply integrates longer.
* **Sanity check, the Kraft rule:** storm-total rain in inches ≈ 100 / forward speed in knots. A 10 kt storm gives about 250 mm, and a 4 kt stall gives about 635 mm. Our totals for the presets should fall in that range unless terrain or stalling is involved.

### 3.3 Hooking into the flood engine
`FloodSim` is already a solid LISFLOOD-FP local-inertial solver, and it stays. The changes:

* `rainRate(t)` → returns the typhoon rain at the district at time t, from the TyphoonSim time series.
* **Upstream inflow:** `rainLag` currently low-pass filters the district's own rain. Instead, drive it with the **catchment-averaged** rain from the same parametric field, sampled about 10–20 km upstream. The river then peaks **hours after** the storm passes, which is what happens. That is what drowned Marikina in Ondoy.
* **Downstream boundary** = sea level + tide + storm surge (§5). Currently it is a free outflow. With a raised boundary, surge pushes back up the river, and drainage stops working because the outfalls are submerged. `drainEff` already models drains backing up.
* **Wind on water:** add a wind stress term `τ = ρa·Cd·U²` to the momentum update, with Cd ≈ 1.2–2.5 × 10⁻³ (Large & Pond, capped at high winds). It piles water up against downwind walls and the river bank. The effect is small in streets but visible on ponds and the river.

Keep the old "Heavy rain" tiers as the **weakest typhoon tiers** (low-pressure area, tropical depression, monsoon surge or *habagat*). Nothing the current flood mode can do is lost.

---

## 4. Thunderstorms, lightning and tornadoes

### 4.1 Lightning
* Inner cores of mature typhoons are **electrically quiet**: high wind, little lightning. Flash rate rises in the **outer rainbands** and spikes during **rapid intensification** or eyewall replacement. A lightning burst in the eyewall is a known precursor of intensification.
* **Model:** flash rate per km² is proportional to the band's convective intensity (the rainband term in §3.2), times a low inner-core factor. Within the district, choose strike points with the **rolling-sphere method**: a sphere of radius about 45 m (the NFPA 780 / IEC 62305 value) rolled over the building height map. It hits tall towers, lone trees and masts first, which is physically correct and makes **lightning rods** a meaningful prep tool.
* **Effects:** ignition through the existing `fireSim` (rain suppresses spread, so few fires grow, which is also realistic); power-pole and transformer failure leading to outages; a flash light plus thunder delayed by distance / 343 m/s.

### 4.2 Tornadoes (TC-tornadoes)
Published climatology:

* About **90 %** of TC tornadoes form in the **front-right quadrant**, in the sector from 340° to 120° relative to motion (Schultz & Cecil 2009). Mirror this in the Southern Hemisphere.
* Most form **200–400 km from the centre** in outer-rainband cells. Weiss (1987) tied 74 % of post-landfall tornadoes to outer-band convection.
* They peak around and just after **landfall**, because land friction slows the surface wind and increases low-level shear.
* About **25 %** of US-landfalling hurricanes produce at least one tornado (Novlan & Gray 1974), mostly the strong storms. Most TC tornadoes are **EF0–EF2**: short-lived, narrow and hard to warn for.

**Model:**
* Hazard rate λ(t) = base × quadrant weight × radial weight (peak 200–400 km) × landfall factor × intensity factor. Run a Poisson draw each minute.
* When a tornado spawns, run a **Rankine vortex** across the grid (core radius 20–60 m, EF0–EF2, path 1–5 km at the band's motion), added on top of the TC wind. Damage uses the same wind fragility (§6), so its narrow track of destruction emerges by itself.
* Show it rarely and dramatically, together with a "tornado warning" log line.

### 4.3 As implemented (phase 4)
* **Lightning** (`stormHazards.js`): the flash rate (all flashes, per km² per hour) follows the convective rain of the rainbands, damped inside ~1.5 Rmax, plus an eyewall burst while the peak wind is rising. A quarter of flashes reach the ground. A strike in the district attaches where the electrogeometric model puts it: the highest `top + √(R² − d²)` over roofs, trees and street-light poles, with R = 45 m. Strikes can set a building alight (timber ~30%, masonry ~12%, concrete ~4%), set a tree burning (much less likely in heavy rain) or split it, and blow transformers. The quake's `FireSim` burns the fires, with rain putting them out fast. Expected per storm: 0.2–1.6 ground strikes in the 1 km² city, and hundreds to ~2,000 flashes within 10 km.
* **TC tornadoes:** genesis density = quadrant (−20° to 120° from the motion, mirrored in the south) × distance (peak ~280 km, a smaller one near the core) × landfall (×3 just after landfall, ×0.3 at sea) × intensity, scaled to ~10 tornadoes over a strong landfalling storm's region. Honest odds of one crossing the district are ~0.005% per storm, so the menu has a **what-if** (EF1 or EF2) that sends one through the city. It comes while a rainband is overhead before landfall, and only when its winds stand out above the typhoon's. Nearby tornadoes are reported in the log. The vortex is Rankine (core radius 20 / 35 / 50 m for EF0–2) carried with the low-level flow at 12–18 m/s, its gusts loading buildings and trees through the same fragility chain. The clock drops to 1 min/s so the player can watch.

### 6.3.1 Windborne debris as implemented (phase 4)
`debrisFlight.js` uses Wills et al. for take-off speed (a loose sheet lifts at ~9 m/s, a tile at ~28 m/s), and integrates a 2-D tumbling-plate trajectory (C_D 1.17, autorotation C_L 0.3). In typhoon winds a sheet flies 100–300 m at nearly the wind's speed (several kJ on impact); tiles fall within 30–140 m. When a roof fails, its pieces fly downwind. A building in their path is hit by the pieces still airborne below its roofline, and a hit breaks glass with a lognormal fragility on impact energy (E50 = 35 J). The renderer's flying sheets use the same aerodynamics, in the local wind including a tornado's vortex and updraught. Rapier stays reserved for structural wreckage: the analytic flight model gives the damage chain thousands of missiles per storm at negligible cost.

---

## 5. Storm surge (coastal cities)

Surge is the biggest killer: Nargis (~138,000 dead), Haiyan (most of ~6,300) and Katrina. It needs a **coastal city option**. One approach: a sea edge on the downstream side of the grid, with the river mouth there.

Cheap bulk model (not SLOSH, but its main terms):

```
η_surge = η_pressure + η_wind + η_wave
  η_pressure ≈ 0.01 m per hPa of Δp  (inverse barometer: 90 hPa → ~0.9 m)
  η_wind     ≈ Cd·ρa·U²·L / (ρw·g·h)  (wind setup over a shelf of length L, depth h)
  η_wave     ≈ 0.1–0.2 × significant wave height (wave setup at the shoreline)
```

* `U` is the onshore wind component. Surge peaks to the **right of landfall** in the Northern Hemisphere, near Rmax.
* Shelf width, depth and **bay funnelling** set the outcome. San Pedro Bay funnelled Haiyan's surge into Tacloban to roughly 4–5 m (NASA: 3–5 m; PAGASA: ~15 ft). A coastline preset should carry a `shelf` factor (open coast / wide shallow shelf / funnel bay).
* Add **tide** as a sinusoid (M2, 12.42 h) with user-set amplitude and phase. Surge at high tide versus low tide is a major real-world swing factor and a good teaching point.
* **Implementation:** the downstream boundary of FloodSim becomes a time-varying water level. Where that level exceeds ground or sea-wall height, inflow enters through the existing local-inertial momentum equations. Water then propagates realistically through streets and up the river.
* Calibration targets: Haiyan in Tacloban ~4–6 m, Nargis ≥ 4 m (12 ft at Bogale), Katrina ~8.5 m (Mississippi coast), Mangkhut in Victoria Harbour, where HKO forecast ≥ 3.5 m total sea level.

### 5.1 As implemented (phase 3)
* **Coastal city** (`cityGen.js`, `opts.coast`): the sea fills the south edge of the grid (open-water cells typed `CELL_RIVER`, flagged in `city.sea`), behind a sandy beach and a low coastal plain about 2–4 m above mean sea level for the first ~300 m. The river's banks fall toward the sea and its mouth silts into a bar. A bay shelf curves the shoreline inland. Being coastal is a property of the **city**, chosen in the menu's City step with its shelf type, for any disaster (an earthquake city can be coastal too, ready for tsunamis later). The typhoon's **Storm surge** panel then sets the direction the sea lies in, the tide amplitude and the tide at closest approach. Picking a historical surge storm (Haiyan, Nargis, Katrina, Idai, Mangkhut) puts the city on that storm's kind of coast.
* **Frame:** the storm is rotated so that the sea's real direction maps onto the grid's south (`buildStorm`, `s.rot`); `toGeo` / `geoCompass` turn directions back for the compass in the log.
* **Surge** (`typhoonPhysics.js`): the bulk model above, evaluated every 5 minutes (`surgeTimeline`). The onshore stress is averaged at 15 / 50 / 85 % of the shelf width, Cd follows Large & Pond (1981) capped at 2.5×10⁻³, Hs ≈ 0.2·U at the shelf edge, and the wind setup relaxes over the shelf's seiche time L/√(g·h). Shelves: open coast (L 12 km, h 30 m), wide shallow shelf (80 km, 11 m), funnel bay (30 km, 18 m, ×2.1). Tide: M2 cosine.
* **Calibration** (peak surge, before tide): Haiyan 4.7 m, Katrina 4.8 m, Idai 4.6 m, Mangkhut 2.6 m (observed 2.35 m), Nargis 3.2 m (below the ≥ 4 m target; a dedicated delta shelf could close the gap).
* **FloodSim:** open-sea cells (the grid edge, and everything more than 30 m off the beach) are held at mean sea level + tide + surge; only a near-shore band is solved, so the sea costs about the same per simulated hour as an inland river. The surge runs up the streets and the river through the existing momentum equations. Storm drains stop as the sea covers their outfalls.
* **Impact:** people drowned by seawater count as **storm-surge deaths**. Breaking waves on the surge add ½√(g·d) to the flow velocity within ~80 m of the beach, which is what smashes beachfront homes. Survivors in a wind-flattened home have no upper floor to climb to. The early-warning plan evacuates everything below the forecast sea level + 1 m; without it, only the beachfront leaves, and only once the sea is visibly rising.
* **Before the storm:** the risk map's flood layer adds the sea at its forecast peak (a connected bathtub from the sea, with a slider), and the forecast panel gives the peak sea level and its parts. **During:** a sea-level gauge in the HUD; a surge warning, drawdown, coming-ashore and peak lines in the log; a lesson on the tide in the results.

---

## 6. Wind damage to buildings, trees and infrastructure

### 6.1 Building fragility: a HAZUS-style component chain
HAZUS-Hurricane keys every damage function to the **3-s peak gust in open terrain**, corrected for local roughness, with four damage states (minor, moderate, severe, destroyed). It derives them from component failures. That chain is ideal for a game, because each link is visible and each has a prep tool:

```
wind pressure on each face:   p = ½·ρ·V_gust(z)²·(GCp − GCpi)
  roof corners and edges GCp ≈ −2 to −3 (strong suction)
  internal pressure GCpi ≈ ±0.18 sealed → ±0.55 once a window or door is breached
```

1. **Windborne debris breaches a window or door** (from §6.3).
2. **Internal pressurisation:** GCpi jumps, and roof uplift roughly doubles.
3. **Roof cover lost:** shingles, tiles, or the GI sheets common in the Philippines peel from the edges. Rain then enters, causing interior damage even without structural failure.
4. **Roof deck or sheathing lost:** purlins or sheathing pull off the rafters.
5. **Roof-to-wall connection fails:** the whole roof lifts off. Hurricane straps are the fix.
6. **Wall failure / collapse:** mainly light timber, *bahay kubo* and nipa, unreinforced hollow-block, and informal housing.

Each archetype in `CONSTRUCTION` gets wind resistances (gust speed for 50 % failure, lognormal β ≈ 0.2–0.3) for each component, so wood, old masonry and informal housing behave very differently. Philippine evidence from Haiyan: light-roof timber and informal homes failed at gusts of about 150–200 km/h, while engineered RC frames mostly kept their structure but lost glazing and roof cladding.

**Fatigue / reversal:** like `fatigue` in the quake model, each component accumulates damage from **duration above a threshold**. A connection that survived the front eyewall may fail when the back eyewall loads it from the other side.

### 6.2 Trees and power
* **Windthrow and stem breakage:** a 50 % failure gust of about 90–130 km/h, depending on species and soil. Waterlogged soil from §3 lowers the anchorage threshold: rain makes trees topple at lower winds. Fallen trees **block roads** in `roadNet` and cut power. The fire sim already tracks trees.
* **Power poles and lines:** fail through tree strikes and direct wind. City-wide outages switch off pumps unless they have backup generators. This is a strong new link to the flood mechanics.

### 6.3 Windborne debris: the showpiece
This uses Rapier, which the project already ships for wreckage, and gives the "metal sheets flying down the street" scene everyone remembers from Haiyan footage.

* **Flight initiation** (Wills, Lee & Wyatt 2002): a loose plate lifts off when the wind exceeds `U_f = sqrt(2·ρ_m·t·g·I / (ρa·C_F))`, where ρ_m is material density, t is thickness and I is a fixing-strength factor. Roof sheets that fail in step 3 of §6.1 become debris instead of disappearing.
* **Trajectory:** as a rigid body in Rapier, apply aerodynamic drag and lift `F = ½·ρa·C·A·|U_rel|·U_rel` at the centre of pressure, using the local wind vector. The dimensionless **Tachikawa number** `K = ρa·U²·A / (2·m·g)` governs whether a sheet flies like a plate or tumbles. Compact debris (gravel, tiles) and rod debris (2×4 lumber) use simpler drag-only flight.
* **Impact:** the kinetic energy at hit breaches windows (feeding back into step 1, a positive feedback that is physically real), injures people outside, and damages cars. Cap the active bodies at about 150–300 and recycle the oldest ones.

### 6.4 People
`floodImpact.js` already models drowning and evacuation. Add these causes of death, in rough real-world proportions:
* **Surge drowning**, the dominant cause in coastal cities.
* **Debris strikes** and **collapsing homes**, the main wind killers.
* **Tree falls** and **electrocution** from downed lines.

Sheltering behaviour follows the **warning signal** (§7): evacuation starts as the signal escalates, and lead time matters.

---

## 7. Warnings: the PAGASA Tropical Cyclone Wind Signal

The game's "early warning" upgrade becomes the real system. PAGASA's **Modified TCWS** (effective 23 March 2022) runs from Signal 1 to Signal 5. Each signal is tied to a wind threshold and a lead time:

| Signal | Wind (10-min, km/h) | Category | Lead time |
|---|---|---|---|
| 1 | 39–61 | Strong winds (TD) | 36 h |
| 2 | 62–88 | Gale-force (TS) | 24 h |
| 3 | 89–117 | Storm-force (STS) | 18 h |
| 4 | 118–184 | Typhoon-force (TY) | 12 h |
| 5 | ≥ 185 | Super Typhoon | 12 h |

Lead times and the Signal 1 range follow PAGASA's descriptions **(verify the exact table in the 2022 press release)**. The 2022 revision also moved the Super Typhoon threshold down to 185 km/h, to match JTWC.

In game: the HUD shows the district's current signal, raised by the forecast (the parametric field evaluated ahead in time). Each signal can trigger the player's pre-set response (close schools, pre-emptive evacuation of coastal and riverside zones, pump pre-staging). That turns "preparation" into a realistic **timeline** decision, which was the user's main goal.

---

## 8. Scenario modes (mirrors `QuakeScenario.jsx`)

### 8.1 Intensity tiers
Low-pressure area / monsoon (*habagat*) → Tropical Depression → Tropical Storm → Severe Tropical Storm → Typhoon → Super Typhoon → "Beyond records". Each tier carries a default Vmax, Δp, Rmax, forward speed and closest approach, and the old rain-only flood tiers map onto the first two.

### 8.2 Historical reenactments
Track data from IBTrACS, embedded as a handful of points per storm around closest approach. The `city` field is the place the district stands in for, the same convention as `HISTORICAL_QUAKES`. The figures below are the commonly cited values. **Pull the exact best-track values from IBTrACS when implementing.** Note which agency and averaging period each one uses (JMA/PAGASA 10-min vs JTWC 1-min).

| id | Storm | District stands in for | Key numbers | What it teaches |
|---|---|---|---|---|
| `haiyan2013` | Haiyan / *Yolanda* | Tacloban, Leyte | JTWC ~315 km/h 1-min at landfall (gusts ~380), JMA 895 hPa; surge ~4–6 m funnelled by San Pedro Bay; ~6,300 dead | Surge is the killer; "storm surge" was not understood by residents |
| `goni2020` | Goni / *Rolly* | Virac, Catanduanes | ~315 km/h 1-min at landfall (strongest landfall on record by 1-min wind); JMA 905 hPa, JTWC est. 884 | Extreme compact core; lahars on Mayon (rain on volcanic slopes) |
| `rai2021` | Rai / *Odette* | Siargao / Surigao City | PAGASA ~195 km/h at Siargao landfall, ~915 hPa; late-season rapid intensification; ~400 dead | Rapid intensification shortens warning time |
| `ketsana2009` | Ketsana / *Ondoy* | Marikina, Metro Manila | Only a tropical storm, but 455 mm in 24 h at Science Garden | Weak wind, catastrophic river flood; matches the existing flood engine |
| `mangkhut2018` | Mangkhut / *Ompong* | Hong Kong (or Cagayan) | HKO forecast ≥3.5 m water level at Victoria Harbour; very large wind field | A well-prepared city: heavy damage, very few deaths |
| `hagibis2019` | Hagibis | Kawasaki / Tama River, Tokyo | ~922 mm in 24 h at Hakone (Japanese record) **(verify)** | Huge rain shield and levee breaches far from the wind core |
| `nargis2008` | Nargis | Bogale, Irrawaddy delta | Surge ≥4 m (~12 ft at Bogale), ran ~40 km inland; ≥138,000 dead | Low delta, no warning, no shelters |
| `katrina2005` | Katrina | New Orleans | Cat 3 at landfall, ~8.5 m surge on the Mississippi coast; levee failures | Flood-wall failure; existing `levee` tool |
| `maria2017` | Maria | San Juan / Puerto Rico | Cat 4 landfall, island-wide grid collapse | Power and infrastructure cascade |
| `idai2019` | Idai | Beira, Mozambique | Southern Hemisphere (mirrored asymmetry); surge plus river floods | Hemisphere flip; combined surge and fluvial flooding |
| `harvey2017` | Harvey | Houston | Stalled for days, ~1,500 mm max | Forward speed → rain total (Kraft rule) |
| `yagi2024` | Yagi | Hải Phòng, Vietnam | Super typhoon that crossed Hainan then the Tonkin Gulf; urban tree and roof losses | Trees as a hazard; inland decay |

The default should be Haiyan, as Kobe is for quakes.

### 8.3 Custom storm / "Test an upcoming typhoon"
Inputs match **what a PAGASA or JTWC bulletin actually prints**, so a player can type in tonight's bulletin and see the result for their city:

* **Position** (lat/lon), **movement** (direction + km/h)
* **Maximum sustained wind**, with a 10-min (PAGASA/JMA) or 1-min (JTWC) toggle (§1.3), plus **gustiness**
* **Central pressure** (optional; derived via Knaff–Zehr if blank)
* **Radius of gale-force winds** (optional; constrains Holland 2010; otherwise Rmax from Willoughby)
* **Forecast intensity at +12/24/48 h**, to model intensification or weakening before landfall
* **District placement:** closest-approach distance and side, or "exact track over the city"
* **Local options:** coastal or inland, shelf type, **tide at closest approach**, soil already saturated (previous rain), terrain uplift

Two derived panels, like the quake's MMI readout:
* **Wind:** expected peak 1-min wind and 3-s gust at the district, the predicted signal level, and which building types reach which damage state.
* **Water:** expected rain total, peak surge plus tide, and river peak time.

Both panels come from the same parametric model, so the player sees the forecast before running the full sim, then can compare it with the outcome in the results screen.

---

## 9. Immersion and rendering (on top of the physics)

* `Rain.update` gets a **wind vector**: streaks slant with the local wind, and horizontal sheets appear at high speed. Particle density follows the rainband rate.
* **Sky and clouds:** a dark rotating cloud deck with band structure; the eye opens as **clear sky** with the stadium wall visible when the district is inside it.
* **Lightning flashes** (directional light pulse plus bolt mesh), **thunder** with the correct distance delay.
* **Tree sway** amplitude ∝ V², palms bending, then topple; flags and signage; spray and mist off the river.
* **Tornado:** a condensation funnel and a debris cloud.
* **Audio**, if it gets added: wind howl pitch and volume tied to gust speed (the single biggest immersion win per line of code).

---

## 10. Suggested code layout

```
src/engine/typhoonPhysics.js   pure functions: unit conversions, Holland 1980/2008/2010,
                               Willoughby Rmax, Knaff–Zehr, Kaplan–DeMaria decay, R-CLIPER +
                               rainbands, surge bulk model, tornado hazard rate, signal level.
                               No three.js; unit-testable like quakePhysics.js.
src/engine/typhoonSim.js       orchestrator: advances the storm along its track; per tick, writes
                               wind (speed, dir, gust field), rain, catchment rain, sea level and
                               lightning/tornado events; owns component damage state.
src/engine/windDamage.js       component fragility chain (§6.1), trees, poles.
src/engine/debrisFlight.js     windborne debris: take-off, plate trajectories, impact energy (§6.3).
src/engine/stormHazards.js     lightning (rolling sphere) and TC tornadoes (Rankine vortex), §4.
src/engine/stormFx.js          bolts, flashes, the tornado funnel.
src/engine/floodSim.js         + rain source hook, wind stress, time-varying downstream sea level.
src/engine/config.js           TYPHOON_LEVELS, HISTORICAL_TYPHOONS (best-track points),
                               per-construction wind resistances, TCWS table.
src/ui/TyphoonScenario.jsx     Tier / Historical / Custom (bulletin) picker + forecast panels.
```

Suggested phases, each one shippable:
1. ✅ **Storm core + rain into FloodSim:** tracks, Holland wind (HUD readout only), R-CLIPER with rainbands, catchment inflow, the three-mode picker, TCWS signals. *Replaces the flood mode with nothing lost.*
2. ✅ **Wind damage:** component fragility, trees, power, reversal fatigue, roof loss visuals, slanted rain. Torn-off roof sheets already fly downwind with a simple drag model; phase 4 adds full plate aerodynamics and impact damage.
3. ✅ **Storm surge:** coastal city variant, tide, downstream boundary, Haiyan and Nargis presets. See §5.1 for what was built.
4. ✅ **Debris, lightning and tornadoes:** debris flight, rolling-sphere strikes, TC-tornado vortex. See §4.3 and §6.3.1 for what was built.
5. **Prep tools and after-action report:** shutters, roof straps, tree trimming, buried lines, generators at pumps, sea wall, mangrove belt, signal-triggered evacuation plans. Researched in detail, with each measure mapped onto the engine, in `typhoon-prep-research.md`.

---

## Sources

* Holland, G. J. (1980). An analytic model of the wind and pressure profiles in hurricanes. *Mon. Wea. Rev.* · Holland (2008) *MWR*, B parameter · Holland, Belanger & Fritz (2010). [A revised model for radial profiles of hurricane winds](https://ckanprod.data-commons.k8s.ucar.edu/dataset/1ccd4365-c398-4b7b-8240-f37ffac9c9cc), *MWR*
* Willoughby & Rahn (2004). [Parametric representation of the primary hurricane vortex](https://faculty.fiu.edu/~willough/PUBS/HEW&RAHN_04.pdf) · Willoughby, Darling & Rahn (2006), *MWR*
* [AIR: Wind profiles in parametric hurricane models](https://www.air-worldwide.com/SiteAssets/Publications/AIR-Currents/attachments/AIRCurrents--Wind-Profiles-in-Parametric-Hurricane-Models) · [NHESS 2019: wind-model comparison for surge](https://nhess.copernicus.org/articles/19/2359/2019/nhess-19-2359-2019.html) · [Knaff: diagnosing TC structure via pressure gradients](https://ramsdis.cira.colostate.edu/rammb/resources/docs/Knaff_HollandB_v03.docx)
* Knaff & Zehr (2007). [Reexamination of TC wind–pressure relationships](https://ramsdis.cira.colostate.edu/rammb/resources/docs/Knaff_preswind.v4.pdf) · [Pressure–wind relationship overview](https://en.wikipedia.org/wiki/Pressure-wind_relationship_calculations_for_tropical_cyclones)
* Kaplan & DeMaria (1995). [Empirical model for the decay of TC winds after landfall](https://www.aoml.noaa.gov/general/project/hrdjk2.html) · [NHC inland wind model](https://nhc.noaa.gov/aboutmeow.shtml?text)
* Tuleya et al. (2007); Marks et al. [R-CLIPER final report](https://www.nhc.noaa.gov/jht/final_rep/R-CLIPER_final.pdf) · [CLIMADA TC rain (R-CLIPER / TCR)](https://climada-petals.readthedocs.io/en/latest/tutorial/climada_hazard_TCRain.html)
* Harper, Kepert & Ginger (2010). WMO guidelines for converting between wind averaging periods in TCs
* FEMA Hazus Hurricane Technical Manual · [Hazus wind damage functions (physrisk)](https://physrisk.readthedocs.io/en/latest/user_guide/vulnerability/vulnerability_functions/wind_hazus/onboard.html) · [Wind-induced losses framework (MDPI)](https://mdpi.com/2674-032X/2/1/6)
* Wills, Lee & Wyatt (2002). A model of wind-borne debris damage, *J. Wind Eng.* · Tachikawa (1983), trajectories of flat plates
* TC tornadoes: [NWS Tallahassee training](https://www.weather.gov/media/tae/FL_Tropical_Training_2021/Day5_Tornadoes_FL_TropicalTraining.pdf) · [NWS GSP conference paper](https://www.weather.gov/media/gsp/localdat/ConfPapers/hurricane.pdf) · Schultz & Cecil (2009); McCaul (1991); Novlan & Gray (1974); Weiss (1987)
* PAGASA: [Modified TCWS (2022)](https://pagasa.dost.gov.ph/press-release/108?page=1) · [ABS-CBN on the 2022 revision](https://abs-cbn.com/news/03/23/22/pagasa-redefines-super-typhoon-tweaks-wind-signals) · [TCWS overview](https://wikipedia.com/wiki/TCWS)
* Haiyan: [NASA Earth Observatory](https://earthobservatory.nasa.gov/images/82348) · [Insurance Journal (JTWC winds)](https://www.insurancejournal.com/news/international/2013/11/11/310796.htm) · [Hiroshima Univ. surge note](https://ir.lib.hiroshima-u.ac.jp/36792/files/5630) · [PreventionWeb](https://www.preventionweb.net/quick/24026)
* Goni: [Wikipedia](https://en.wikipedia.org/wiki/Typhoon_Goni) · [NASA Earth Observatory](https://www.earthobservatory.nasa.gov/images/147476/devastating-storm-hits-the-philippines) · Rai: [Verisk/AIR](https://alert.air-worldwide.com/tropical-cyclone/2021/typhoon-rai/) · [BenarNews](https://engdev.benarnews.org/english/news/philippine/storm-follow-12172021134459.html)
* Mangkhut: [HKO 2018 TC report figures](https://www.hko.gov.hk/en/publica/tc/tc2018/figure3518b.html) · Nargis: [Wikipedia](https://en.wikipedia.org/wiki/Cyclone_Nargis) · [Digital Typhoon (NII)](https://agora.ex.nii.ac.jp/digital-typhoon/world/bob/NARGIS/index.html.en)
* Track data for presets: NOAA NCEI **IBTrACS** (International Best Track Archive for Climate Stewardship)
