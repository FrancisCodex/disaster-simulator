# Typhoon preparation and recovery: real-world research for MetroRisk

Purpose: ground phase 5 of the typhoon work (preparation tools and the after-action report) in measures that cities have actually built or run. Each measure is mapped onto the existing simulation (`floodSim.js`, `floodImpact.js`, `windDamage.js`, `debrisFlight.js`, `stormHazards.js`, `typhoonSim.js`, `cityGen.js`, `game.js`, `config.js`), with a judgement on whether the game can simulate it honestly.

It follows the same pattern as `earthquake-prevention-research.md`. Numbers come from the sources at the end. Many are news or secondary reports and are marked **(verify)**. Use them to tune the game, not as engineering values.

The next update after this one is in-depth post-disaster operations (rescue, relief, restoration) for both typhoons and earthquakes. §5 separates what phase 5 should measure and report from what that update should simulate.

---

## 1. What the real world says matters most

1. **Getting people out of the water's way, early, is what saves lives.**
   * Bangladesh lost an estimated 300,000–500,000 people to the 1970 Bhola cyclone and ~138,000 in 1991. Sidr (2007) killed roughly 3,500–4,200 (the counts vary by source).
   * The difference was the Cyclone Preparedness Programme: warnings carried door to door by trained volunteers, and shelters built in their thousands (44 in 1970; about 5,500 today, per one source).
   * Albay province's "zero casualty" policy evacuates danger zones before PAGASA even raises a signal. Almost 600,000 people were evacuated for Melor in 2015.
   * Haiyan showed the failure mode: many Tacloban residents did not understand "storm surge". PAGASA now issues surge warnings in colour bands with plain impact text: blue < 1 m, yellow 1–2 m, orange 2–3 m, red > 3 m.
   → *The warning chain (forecast → warning → understood → acted on, in time) is the game's most important preparation, and it is still one checkbox (`floodWarning`).*
2. **Floods are a capacity problem at every link: drain → river → floodway → sea.**
   * In Ondoy (2009) the Marikina River peaked at an estimated 4,150–5,770 m³/s. The Manggahan Floodway was designed for 2,400 m³/s and carried ~3,000. The Pasig downstream reportedly takes only ~600 m³/s (verify).
   * On the coast, a high tide or surge closes the drain outfalls exactly when the rain is heaviest.
   → *The flood solver already conserves water through every link. Phase 5 should give the player a tool at each link, and show which link failed.*
3. **In wind, cheap connection details decide.**
   * IBHS's turntable demonstration of a FORTIFIED home showed about $20 of straps keeping the upper storey on.
   * Window protection is estimated to cut average hurricane losses by up to 33% on the North Carolina coast. In a Broward County study, a package of shutters, impact glass and film avoided losses of 4.8× its cost.
   * Philippine design winds (NSCP 2015) are commonly cited as 250 km/h in the typhoon corridor and 200 km/h for most of the country, including Metro Manila (verify against the official map).
   → *The fragility chain and the debris model from phases 2 and 4 can show exactly how each of these breaks the cascade: glass → internal pressure → roof → walls.*
4. **Lifelines and health turn a storm into a long disaster.**
   * After Irma, Florida Power & Light reported underground lines performing ~80% better than overhead ones. Burial costs roughly $1–1.5 M per mile, about 10× an overhead line, and buried lines are vulnerable to surge.
   * Utilities aim to restore ~70% of customers within 5–7 days. After Sandy, reaching 95% took 10–13 days.
   * After Ondoy, leptospirosis struck ~2,100 people and killed ~160, more than five times the previous year's national leptospirosis deaths, mostly in flooded Marikina and Pasig.
5. **Nature-based defences work, but at their own scale.**
   * Mangroves lower a surge by roughly 5–50 cm per km of forest; dense forest in South Florida during Wilma gave 40–50 cm/km. Most of the effect is in the first few hundred metres, and the surge can be 10–30% higher at the forest's seaward edge.
   * Coral reefs dissipate ~97% of incoming wave energy, the reef crest alone ~86%. Median reef restoration costs about $1,290 per metre, against ~$19,800 for an artificial breakwater.
   → *Mangroves mostly kill **waves**. A 100–200 m belt on a 1 km district trims a 4 m surge by only centimetres. The game should show that honestly: it is a good lesson.*
6. **Mitigation pays, and money speeds recovery.**
   * NIBS's *Mitigation Saves* (2019) puts adopting current codes at about $11 saved per $1, building above code at $4 per $1, and federal wind-mitigation grants at about $5 per $1 (riverine flood ratio: verify in the full report).
   * Parametric insurance pays within weeks with no loss assessment. The Philippines' 2017 World Bank-backed cover transferred $200 M of typhoon and earthquake risk and paid out ~$28 M over two years.

---

## 2. What the game already has

| Tool / upgrade | What it does now | Gap |
|---|---|---|
| Flood wall (`levee`) | 3 m wall raises the cell's ground; breaches when overtopped (`FloodImpact.updateLevees`) | One height; no gates; no sea-wall variant; walls stop drains from reaching the river too |
| Pump station | 10 m³/s from a 9×9 area into the river; stops if its site floods or it loses power | No backup generator; no choice of size |
| Retention pond | 3.5 m deep basin | Single-use; no multi-use flood park |
| Elevate | Raises a low-rise building 2 m | No dry/wet floodproofing; nothing for critical equipment |
| Park | Pervious ground, soaks up rain | Green infrastructure on streets and roofs is missing |
| Shelter | Capacity = area / 3.5 m² (Sphere standard) | Not wind- or surge-rated; no overcrowding or supplies |
| Typhoon early warning (upgrade) | Evacuates low-lying, riverside and coastal zones at Signal No. 3, and light-material homes | One trigger; no plan, compliance or plain-language surge warning |
| Storm-drain upgrade | +15 mm/h per level, max 2 | No flap gates against tide and surge |
| Dredging | River bed 1.5 m deeper | No widening, floodway, dam or catchment measures |
| Fire & Rescue | Boat rescue at 25 people/h per dry station | Staging, numbers and road access not modelled (next update) |

Wind, coast, power and nature have **no** tools yet, although phases 2–4 modelled the hazard they would act on.

---

## 3. Catalogue of measures

Each entry gives the **real basis**, the **game** hook, a feasibility rating and a priority. Feasibility: ✅ fits the current model directly; 🟡 needs a modest new mechanic; 🔶 needs a new subsystem or belongs in the operations update. Priority: ★ = do in phase 5.

### A. Rain and river flooding

**A1. Outfall flap gates (tide gates) on storm drains** ★ ✅
* Real basis: one-way gates on outfalls keep the sea or a high river from flowing back up the drains. They are standard on the Leyte surge wall's river outlets.
* Game: today `drainEff` drops to 0 as the sea rises 0.5 → 1.5 m above normal, and as the river nears its banks. With gates, drainage keeps working until those levels are reached, and street flooding no longer backs up through the drains. Add it as a level of the drain upgrade.

**A2. Flood walls with a choice of height, and gates** ★ 🟡
* Real basis: river walls, plus "super levees" in Japan: wide earth embankments that do not breach when overtopped.
* Game:
  * Wall heights of 2, 3 and 4 m, priced per metre of height.
  * A **flood gate** cell type that stays open (roads and drains pass) and closes at an alarm level.
  * A "wide levee" variant that cannot breach (`updateLevees` skips it) but costs 3–5× as much and uses two cells.

**A3. Pump stations: sizes and backup generators** ★ ✅
* Game: a generator option clears `p.unpowered`, using the existing `WindDamage.powered()` link. Pump sizes of 5, 10 and 20 m³/s.
* A lesson the engine can already show: a pump on low ground drowns, and a pump without a generator stops in the blackout.

**A4. River channel improvement: widening as well as dredging** ✅
* Real basis: the Pasig–Marikina Channel Improvement Project (JICA, phase 3 done in 2020).
* Game: widen by one cell on each bank, displacing bank buildings with relocation cost. The existing `STAGE_TABLE` forecast needs a widened-channel correction.

**A5. Floodway / diversion channel (city-wide upgrade)** ★ 🟡
* Real basis: the Manggahan Floodway diverts Marikina peaks into Laguna de Bay at 2,400 m³/s (design). Ondoy overloaded it at ~3,000.
* Game: in `FloodSim`, upstream inflow above a threshold Q₀ is diverted, up to a capacity C: `inflow −= clamp(inflow − Q₀, 0, C)`. Above C the river still floods, which is the Ondoy lesson.
* Show it on the outer landscape as a channel leaving the river upstream. `forecastRiverPeak` must apply the same diversion.

**A6. Catchment measures: retention dam and upstream reforestation** 🟡
* Game: a dam stores the first V m³ of catchment runoff. Reforestation lowers `runoffC` growth by ~10–15% (verify).
* Both act through the existing lagged-runoff hydrograph, so they are cheap to add. Real effects for a 400–500 mm typhoon are modest: saturated soils run off regardless. That is worth showing.

**A7. Underground discharge tunnel** 🟡
* Real basis: Tokyo's G-Cans tunnel takes floodwater from small rivers and discharges up to ~200 m³/s into the Edo River.
* Game: the player places 1–3 intake shafts; together they remove up to C m³/s from those cells into the river or sea. Mechanically it is a pump network with a shared capacity. It is very expensive and a good late-game option for a megacity.

**A8. Multi-use flood basins** ✅
* Real basis: "water squares" (Rotterdam) and sports fields that flood on purpose.
* Game: a park or field lowered 1–1.5 m. It stays usable as open space and gives some earthquake benefit, but stores less than a pond. Reuse the pond excavation logic.

**A9. Green infrastructure: permeable paving, rain gardens, green roofs** ✅
* Real basis:
  * Permeable pavement cuts **annual** runoff 83–99%.
  * Green roofs retain 45–75% of **annual** rain.
  * Combined schemes cut peak flow 17–62% in modelled districts.
  * All of these are for ordinary storms.
* Game:
  * Permeable streets: road cells get pervious infiltration (`cls` 0) plus ~30–50 mm of storage.
  * Green roofs: each building retains its first ~20–30 mm of rain before runoff.
* **Teaching point:** they barely dent a 300–500 mm typhoon, but they cut nuisance flooding from monsoon rain and tropical depressions a lot. The after-action report should say so.

**A10. River gauges with staged alarms (refines the early-warning upgrade)** ★ ✅
* Real basis: Marikina's gauge at Sto. Niño. 15 m is the first alarm (warning), 16 m the second (prepare), 17 m voluntary evacuation, 18 m the third alarm (forced evacuation). The figures come from news reports (verify).
* Game: `FloodSim.stage` already exists. The plan (D1) ties actions to stages, and the HUD shows the alarm level.

**A11. Floodproofing critical facilities** ✅
* Hospitals and evacuation centres: generators and switchgear moved upstairs, and flood barriers at doors. This is a per-building option on facilities.
* It keeps `s.offline` false until water exceeds a higher threshold (1.5 m instead of 0.5 m).

### B. Coast and storm surge

**B1. Sea wall with river gates** ★ 🟡
* Real basis: the Leyte Tide Embankment ("Great Wall of Leyte") after Haiyan. About 4 m high and ~38 km long; P7.95 B at first, ~P12 B now (verify); 59–62% complete by 2023–24. It has flap gates and river gates.
* Game:
  * A wall tool on beach cells (crest 3–5 m above mean sea level), reusing the levee mechanics.
  * A **river gate** across the river mouth that closes when the sea is high. It stops the surge running up the river and traps the river behind it, so pumps or a basin are needed. That is the real dilemma.
  * Overtopping erosion and breaching use the existing `updateLevees`.
  * Waves on the surge (`vw` in `FloodImpact`) can overtop a wall lower than surge + ~½ Hs.
* Criticism to surface in the report: it displaces fishing communities.

**B2. Mangrove belt** ★ ✅
* Real basis: 5–50 cm surge reduction per km (dense forest ~40–50 cm/km), mostly near the front, with a 10–30% rise at the seaward edge. Narrow belts (50 m – 2 km) in Bangladesh gave 4–16.5 cm (modelled).
* Game:
  * Plant on intertidal and shallow sea cells, in front of the beach.
  * Physics: high Manning roughness (n ≈ 0.1–0.15) on those cells slows the surge's inflow in the solver itself. The bulk model's wave setup and the beachfront wave attack (`vw`) are cut in proportion to belt width (e.g. ×(1 − min(0.8, width/300 m))).
  * The forecast panel should show the honest number: a 150 m belt trims a 4.5 m surge by ~5 cm but halves the waves.
  * It takes years to grow. In a single-storm game, offer "mature belt (existing)" versus "newly planted (no effect yet)", and keep growth for a campaign mode.

**B3. Reef or offshore breakwater (coast-wide upgrade)** ✅
* Real basis: reefs remove ~97% of wave energy (Ferrario et al. 2014). Restoration costs ~1/15 of a breakwater per metre.
* Game: scales the wave terms (wave setup, `vw`) for the whole coast. It does nothing to the wind setup or pressure surge, which is again the honest lesson.

**B4. Dunes and raised coastal road** ✅
* A raised embankment one or two cells inland: a cheaper, lower (1.5–2 m) and softer version of B1. It works against small surges and high tides.

**B5. No-build zone, relocation and land use** ★ 🟡
* Real basis: after Haiyan, a 40 m no-build zone from the high-water mark for homes; businesses were allowed.
  * Tacloban's mayor argued that elevation, not distance, is the right measure.
  * Tacloban North resettlement was ~40 km from the centre, and fewer than 65% of the houses awarded were occupied as of 2020, because they were far from livelihoods.
* Game: a zoning brush. It demolishes and rehouses homes below a chosen ground elevation (better) or within a distance (cheaper and cruder). It reuses `relocated` and the house-building tools, with a **livelihood cost**: an economic loss line in the report.

**B6. Cyclone shelters / vertical evacuation** ★ ✅
* Real basis:
  * Bangladesh's multipurpose cyclone shelters stand on stilts or have elevated floors; they are schools in normal times.
  * The Philippines' Ligtas Pinoy Centers Act (RA 12076, 2024) requires a dedicated evacuation centre in every city and municipality. Sponsorship materials cite designs for ≥ 300 km/h winds (verify the final text).
* Game: a shelter variant that is wind-rated (no roof loss), raised (floor 3–4 m up) and placed by the player. Its catchment matters: people walk to the nearest one, so placement is the puzzle.

### C. Wind

**C1. Roof-to-wall straps / hurricane ties (per building and program)** ★ ✅
* Game: raises the `roof` median (×1.25–1.35) and `collapse` (×1.1) in `windMedians`.
* Cheap, priced per footprint. As a program it works like the earthquake soft-storey ordinance (city pays a share).

**C2. Roof sheet fixing (screws at every purlin, closer spacing, edge strips)** ★ ✅
* Game: raises the `cover` median (×1.2–1.3). Through `debrisFlight`, it also raises the fixing factor I, so fewer sheets take off at a given gust.

**C3. Storm shutters / impact-rated glazing** ★ ✅
* Game:
  * Raises `glass` (×1.15) and multiplies `GLASS_E50` for that building (×20, impact-rated against the large-missile class).
  * This breaks the glass → internal pressure → roof cascade, and the debris model shows its value without any extra scripting.
  * A "shutters closed" flag could depend on warning lead time (D1): shutters only help if someone closes them.

**C4. Wind code adoption and enforcement (city policy)** ★ 🟡
* Real basis: the NSCP 2015 wind zones; NIBS estimates codes save ~$11 per $1.
* Game: a policy that upgrades the construction mix of new and replaced buildings, and a register program for existing ones (like the quake programs). Effect is through `WIND` medians, gradual in a campaign and immediate in one-shot play via a "programme complete" assumption.

**C5. Tree management (pruning, species, clearance from lines)** ★ ✅
* Game: raises `TREE_WIND` medians in an area (pruned: ×1.15) and removes trees within 3 m of lines, so fewer feeder faults come from trees. Fewer roads are blocked, which feeds the next update's rescue access.

**C6. Power: concrete or steel poles, underground lines** ★ ✅
* Real basis: Meralco's programme replacing wooden poles with concrete and steel. FPL's underground lines performed ~80% better in Irma, at about 10× the cost of overhead.
* Game:
  * A per-feeder (250 m) upgrade: raise `POLE_WIND`, or bury the lines (no tree, pole or wind faults).
  * Buried lines are vulnerable to surge and flooding: a feeder fails if its transformer cell floods more than 0.5 m.
  * The transmission line feeding the city (`GRID_WIND`) is outside the city's control. Make it a regional event the player can only hedge against with generators.

**C7. Backup generators (pumps, shelters, hospitals)** ★ ✅ (see A3)

**C8. Lightning rods (phase 4 tie-in)** ✅
* Game: strikes on a protected building or tower do no harm (`lightningStrike`). The rolling sphere already sends strikes to the tallest roofs, so rods on towers protect their neighbours too.

**C9. Billboards and loose signage** 🔶
* Taking down billboards and tarpaulins before typhoons is common practice in Metro Manila (verify details). It needs signage objects, which don't exist yet. Defer.

### D. People: warning, evacuation, shelter

**D1. A signal-based evacuation plan (replaces the single checkbox)** ★ 🟡
* Real basis: Albay "zero casualty"; PAGASA wind signals 1–5; surge colour bands; Marikina river alarms.
* Game: a small plan editor. Each action has a trigger:
  * **Triggers:** wind Signal No. N, surge warning colour, river alarm level, or hours before closest approach.
  * **Actions:** close schools and offices (daytime people go home); pre-emptive evacuation of zones (coastal below X m, riverside, light-material homes); forced evacuation; close shutters; pre-position boats; open shelters.
  * Later triggers mean less lead time. People take hours to move, and compliance falls for voluntary orders, so timing matters.
* This is the main mechanic of phase 5. It uses existing parts: `typhoonSim.signal`, `fc.sea`, `flood.stage`, `FloodImpact` evacuation rates.

**D2. Plain-language surge warning** ★ ✅
* Game: a cheap upgrade raising the **compliance** of coastal evacuation (e.g. 50% → 85%). Without it, coastal residents leave only once they see the sea rising: the Haiyan lesson, which the phase 3 code already reproduces.

**D3. Evacuation centre quality** ★ 🟡
* Real basis:
  * Sphere sets a minimum of 3.5 m² per person (the game already uses this for capacity). Albay 2009 saw under 1 m² per person.
  * In the Philippines, 35,648 classrooms in 11,522 schools have been used as evacuation centres; DepEd caps school use at 15 days.
* Game: shelters can overfill to ~1 m² per person. Overcrowding raises disease risk and lowers compliance with later orders.
  * A shelter inside the flood or surge zone, or with a light roof, fails during the storm, and its occupants must move: the phase 2/3 damage chain already applies to shelters.
  * Supplies (water and food days) are an operations-update item.

**D4. Community drills and volunteers** ✅
* Real basis: Bangladesh's CPP volunteer corps and drills.
* Game: an upgrade that raises evacuation speed and compliance city-wide. Cheap, and very effective in the model, as in reality.

**D5. Pre-positioned rescue boats and teams** 🟡 (operations update for the full version)
* Phase 5: a pre-positioning option. Boats are staged at a dry site chosen by the player instead of at fire stations, so a flooded station does not lose its boats.
* Operations update: crews, routes and rescue time.

**D6. Health measures: leptospirosis prophylaxis and clean water** 🔶
* Ondoy's outbreak followed wading through floodwater. The model already knows who waded (evacuation through water and street agents in floodwater).
* Phase 5 can **report** expected cases. Treatment and prophylaxis belong to the operations update.

### E. Money and policy

**E1. Parametric insurance (city policy)** ✅
* Real basis: Philippine City Disaster Insurance Pool (ADB design; parametric on 3-s gusts for typhoons); the 2017 national cover.
* Game: pay a premium in preparation; the after-action report pays out on the storm's measured peak gust at the city (`typhoon.peak.gust`). The payout doesn't match losses, which is the real trade-off. It funds the rebuild budget in a campaign.

**E2. Disaster reserve / quick response fund** ✅
* Unspent budget earmarked for response. Interest is for a campaign; in one-shot play it speeds recovery (power, roads) in the next update.

**E3. Hazard maps and zoning** ✅ (largely exists)
* The risk map (flood depth, wind, sea level) is the game's version of Project NOAH-style hazard maps. Phase 5 adds the B5 zoning brush, which uses those maps.

---

## 4. After-action report

The earthquake report already compares the real run with a shadow run of the same event on the unprepared city (`prepEffect`). The typhoon report should do the same.

### 4.1 With and without preparation
* Run the same storm on `baselineCity`: FloodSim, FloodImpact, WindDamage and StormHazards, with the same seeds.
* The typhoon engine is ~3–4× heavier than the quake's shadow. Run the shadow in a **Web Worker**: all of these modules are pure apart from the optional `life` hook in `WindDamage`, which needs a stub.
* The headless harnesses used during phases 3–4 already do exactly this and take ~30–60 s for a full storm. A worker started with the simulation will finish before the player does.

### 4.2 What to report, by pillar
| Pillar | Measures | Report lines |
|---|---|---|
| Warning and evacuation | Plan triggers, lead time, compliance | Hours of warning before gale, surge and peak river; share of each zone evacuated before the hazard arrived; deaths by where people were (home, street, shelter) |
| Water | Drains, walls, pumps, floodway, basins | Peak river and sea against walls; which link failed first (drain backing up, overtopping, breach, pump drowned or unpowered); hectares and buildings flooded with and without |
| Wind | Straps, sheets, shutters, codes, trees | Roofs, windows and collapses avoided; missiles released (`stats.missiles`) and windows they broke (`missileGlass`) |
| Coast | Sea wall, mangroves, reef, zoning | Surge at the shore and behind the defences; wave attack avoided; homes relocated and livelihood cost |
| Lifelines | Poles, burial, generators | Share of the city without power over time; pumps lost to blackout |
| Money | Spend, insurance | Loss avoided per $ spent per measure (benefit–cost), compared with NIBS's typical ratios; insurance payout against loss |

### 4.3 Recovery indicators phase 5 can estimate (and the operations update will simulate)
* **Displaced and sheltered over days:** homes uninhabitable (roof lost, flooded > 0.5 m, collapsed) × residents, against shelter capacity at 3.5 m² per person.
* **Power restoration:** from feeders and poles down. Benchmarks: ~70% restored in 5–7 days, 95% in 10–13 days after a major storm. Buried feeders come back faster unless flooded.
* **Road access:** blocked cells (trees, poles, wreckage) against the clearance rate; which facilities are cut off.
* **Debris:** tonnes of roof sheets and wreckage, and days to clear.
* **Health:** expected leptospirosis cases from person-hours wading. Scale to Ondoy (~2,100 cases, ~160 deaths across a metro of millions); show it as a range.
* **Economic loss and recovery time**, by building class (HAZUS-style loss ratios already exist).

---

## 5. Scope: phase 5 now, operations update next

**Phase 5a: preparation tools (★ items).**
* **Water:** outfall gates (A1), wall heights and gates (A2), pump generators and sizes (A3), floodway (A5), river alarm levels (A10).
* **Coast:** sea wall and river gate (B1), mangrove belt (B2), zoning brush (B5), cyclone shelters (B6).
* **Wind:** straps (C1), sheet fixing (C2), shutters (C3), wind code policy (C4), tree management (C5), poles or burial (C6).
* **People:** the evacuation plan editor (D1), plain-language surge warning (D2), shelter quality and overcrowding (D3), drills and volunteers (D4).
* Most are ✅ against hooks that already exist. The new mechanics are the plan editor, gates and the zoning brush.

✅ **Built (phase 5a).** Differences from the plan above, learned in testing:
* **Road flood gates** were left out: the solver doesn't model traffic through walls, so they would add nothing. Wall heights (2/3/4 m) are in.
* **The zoning brush** became a one-click "danger-zone relocation": homes the forecast puts under more than 1 m of water are cleared and their families must be rehoused (`city.resettled`).
* **The river gate is a storm-surge barrier, not a tide gate.** Closing on every rising tide penned a river in flood (~1,000 m³/s) behind it until it burst the walls from inside. It now stays open for ordinary tides and shuts once a surge lifts the sea 1.2 m above normal. While shut it pumps 400 m³/s over itself, and it stays shut until the surge has passed (a river's own flow piles metres up against a gate that has just shut).
* **Sea walls have flap culverts:** without them, rain and river water trapped behind the wall built up until the wall failed from the land side.
* **A defence works only as a system.** Haiyan on a coastal metropolis, headless runs, flooded buildings: plan only 120. Sea wall and estuary walls, 117. Plus gate and upstream floodway, 20. A sea wall alone is worse than nothing: the surge comes up the river, over its banks, and the wall then traps it.
* **Seawater is now traced** (`FloodSim.salt`, spread along the flow only during a surge), replacing phase 3's "sea above the floor" guess, which counted rain-flooded buildings behind a wall as surge.
* **The suggested plan** with warning upgrades took Haiyan deaths from 84 to 18 (surge deaths 38 → 0). The wind roof code, shutters, tree care and concrete poles, in an ordinary typhoon: roofs lost 97 → 23, windows broken by debris 177 → 85, power still on 13% → 38%.

**Phase 5b: after-action report.** The shadow run in a worker (§4.1), the pillar table (§4.2) and the recovery estimates (§4.3), all as numbers and short lessons.

**Second tier, if time allows.** Catchment dam and reforestation (A6), underground tunnel (A7), flood basins (A8), green infrastructure (A9), reef (B3), dunes (B4), insurance (E1).

**Deferred to the operations update (typhoon and earthquake).**
* Rescue crews and boats as agents with routes and road access.
* Shelter supplies and logistics.
* Power and road restoration crews.
* Disease treatment, debris clearing, and Build Back Better rebuilding choices.

Phase 5's report lines in §4.3 are the baseline that update will turn into gameplay.

---

## Sources

* **Cyclone preparedness and warnings:**
  * [TBS News: 50 years of cyclone preparedness](https://www.tbsnews.net/thoughts/50-years-cyclone-preparedness-success-saving-lives-not-livelihood-368398)
  * [The New Humanitarian: how Bangladesh is beating the odds](https://www.thenewhumanitarian.org/investigation/2021/12/2/how-Bangladesh-is-beating-the-odds-on-climate-disaster-deaths)
  * [Dhaka Tribune: managing cyclones in Bangladesh](https://www.dhakatribune.com/science-technology-environment/climate-change/248383/managing-cyclones-in-bangladesh-a-success-story)
  * [PreventionWeb: Albay zero casualty](https://www.preventionweb.net/quick/18760)
  * [PTV News: Albay evacuations for Ulysses](https://ptvnews.ph/?p=169102)
  * [Inquirer: PAGASA improves storm surge warnings](https://newsinfo.inquirer.net/1131330/pagasa-improves-warning-system-on-storm-surges)
  * [PAGASA storm surge warning (TC Emong, 2025)](https://pubfiles.pagasa.dost.gov.ph/pagasaweb/files/tamss/weather/stormsurge/02_Warning_TC_EMONG_2025072412.pdf)
* **Flood control:**
  * [Manggahan Floodway](https://en.wikipedia.org/wiki/Manggahan_Floodway)
  * [JICA study](https://openjicareport.jica.go.jp/pdf/12041463.pdf)
  * [Gulf News: why Manila floods](https://gulfnews.com/amp/story/world%2Fasia%2Fphilippines%2Ftoilet-without-a-flush-why-manila-is-always-flooded-clue-solution-is-known-since-the-1970s-1.500209545)
  * [Embassy of Japan: Pasig–Marikina channel improvement](https://www.ph.emb-japan.go.jp/itpr_en/11_000001_00635.html)
  * [Ebara: Showa pump station (G-Cans)](https://ebara.com/global-en/case/showa-ex/)
  * [MLIT brochure](https://www.ktr.mlit.go.jp/ktr_content/content/000812778.pdf)
* **River alarms:**
  * [Inquirer: Marikina evacuates at critical level](https://newsinfo.inquirer.net/1032671/marikina-lgu-tells-locals-to-evacuate-as-river-water-reaches-critical-level/amp)
  * [GMA: first alarm over Marikina River](https://gmanetwork.com/news/topstories/metro/797723/first-alarm-up-over-marikina-river/story)
  * [Philstar 2025](https://www.philstar.com/nation/2025/07/21/2459640/red-alert-raised-pasig-wawa-dam-hits-critical-level/amp/)
* **Green infrastructure:**
  * [Mile High Flood District tech memo](https://mhfd.specialdistrict.org/files/ef6525064/TechMemo_ImperviousnessforStormwaterControlMeasures_20240229.pdf)
  * [Oregon State W-Restore: urban BMPs](https://wrestore.oregonstate.edu/pages/urban_bmp.html)
  * [Texas A&M: green infrastructure](https://tcwp.tamu.edu/wp-content/uploads/sites/7/2017/01/GI_FouadJaber_CitizenPlanner2017.pdf)
* **Wind:**
  * [IBHS research centre opening](https://ibhs.org/10-year-anniversary/ibhs-research-center-grand-opening/)
  * [Home Innovation: roof-to-wall retrofit](https://www.homeinnovation.com/-/media/Files/Reports/Retrofit-Improvements-Roof-to-Wall-Connection.pdf)
  * [FEMA: Broward County loss avoidance](https://fema.gov/case-study/loss-avoidance-study-broward-county-fl-hurricane-wind-mitigation-projects)
  * [PropertyCasualty360: better codes cut loss](https://www.propertycasualty360.com/amp/2002/08/12/better-building-codes-cut-property-loss/)
  * [AEDO: NSCP wind load guide](https://aedoconstruction.com/blog/nscp-wind-load-guide-philippines/)
  * [SkyCiv wind speed map](https://skyciv.com/docs/load-generator/wind/wind-speed-map/)
* **Power:**
  * [WGCU: are underground lines the solution](https://www.wgcu.org/2018-07-16/are-underground-power-lines-really-the-solution-to-power-outages-in-south-florida)
  * [Florida DEP undergrounding report](https://publicfiles.dep.state.fl.us/Siting/Outgoing/Undergrounding/UndergroundReport.pdf)
  * [UF PURC hardening research](https://bear.warrington.ufl.edu/centers/purc/docs/papers/energy/hurricane-hardening-papers/PURC_Collaborative_Research_Report_02_14_08.pdf)
  * [Philstar: Meralco braces for rains](https://philstar.com/business/2016/06/05/1590034/meralco-braces-rains)
  * [Entergy: Isaac restoration benchmark](https://www.entergy.com/doe-official-assesses-hurricane-isaac-damage)
  * [KTAR/AP restoration times](https://ktar.com/?p=110944)
* **Coast:**
  * [Conservation Gateway: storm surge reduction by mangroves](https://www.conservationgateway.org/collections/ocean/storm-surge-reduction-mangroves/)
  * [World Bank blog: mangroves and cyclones](https://blogs.worldbank.org/en/developmenttalk/when-cyclones-strike-using-mangroves-protect-coastal-areas)
  * [PreventionWeb: mangroves in Bangladesh](https://www.preventionweb.net/go/64752)
  * [Ferrario et al. 2014 (eScholarship)](https://escholarship.org/content/qt291697f0/qt291697f0.pdf)
  * [Reef Resilience summary](https://reefresilience.org/article-summaries/the-effectiveness-of-coral-reefs-for-coastal-hazard-risk-reduction-and-adaptation/)
  * [PNA: Leyte seawall progress](https://alpha.pna.gov.ph/articles/1212825)
  * [Tribune: Leyte wall halfway](https://tribune.net.ph/2023/10/31/leytes-surge-protection-wall-halfway-complete)
  * [DPWH: Leyte embankment](https://dpwh.gov.ph/dpwh/news/14096)
* **Relocation and zoning:**
  * [Brookings: resettlement after Haiyan](https://www.brookings.edu/articles/resettlement-in-the-wake-of-typhoon-haiyan-in-the-philippines-a-strategy-to-mitigate-risk-or-a-risky-strategy/)
  * [JSCE: Tacloban case](https://committees.jsce.or.jp/acecc02/system/files/Philippines%3B%20Ladylyn.pdf)
* **Evacuation centres:**
  * [Sphere in Practice](https://spherestandards.org/wp-content/uploads/Sphere-in-Practice.pdf)
  * [Inquirer: substandard bunkhouses](https://opinion.inquirer.net/69149/substandard)
  * [Ligtas Pinoy Centers Act](https://jinggoyestrada.ph/2024/12/06/jinggoy-permanent-evacuation-centers-for-every-city-municipality-now-a-law/)
  * [DepEd on schools as evacuation centres](https://deped.gov.ph/?p=133518)
* **Health:**
  * [Global Voices: leptospirosis outbreak](https://globalvoices.org/2009/11/01/leptospirosis-outbreak-in-the-philippines/)
  * [Acta Medica Philippina](https://actamedicaphilippina.upm.edu.ph/index.php/acta/article/download/796/700)
* **Mitigation economics and insurance:**
  * [NIBS Mitigation Saves 2019](https://www.nibs.org/files/pdfs/mitigationsaves2019_complete.pdf)
  * [NIBS: hurricane code adoption](https://www.NIBS.org/files/pdfs/ms_v3_adopts_hurricane.pdf)
  * [NIBS: wind grants](https://www.NIBS.org/files/pdfs/ms_v3_grants_wind.pdf)
  * [ADB: Philippine City Disaster Insurance Pool](https://www.adb.org/publications/philippine-city-disaster-insurance-pool)
  * [Development Asia: parametric insurance](https://development.asia/insight/using-parametric-insurance-address-rapid-post-disaster-financing)
