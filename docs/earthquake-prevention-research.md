# Earthquake prevention: real-world research for MetroRisk

Purpose: ground the next phase of quake-prevention tools in programs that cities have actually run, and map each one onto the existing sim (`quakeSim.js`, `world.js`, `groundFailure.js`, `config.js`, `game.js`).

Figures are taken from the sources listed at the end. Where a number comes from a secondary or vendor source, it says so. Use those numbers to tune the game, not to quote as fact.

---

## 1. What the real world says matters most

Four lessons keep coming back across Kobe, Christchurch, Mexico City, Turkey and California. Each one is a design pillar.

1. **Building age and code era is the biggest single predictor of death.** Japan's 1981 code raised the required lateral design force from 20% to 100% of building weight. In Kobe (1995), pre-1981 buildings were roughly 3–4× more likely to collapse. Japanese secondary sources report that about 97% of collapsed wooden houses were built to the older code. Turkey (2023) shows the opposite case: construction amnesties let non-compliant buildings stay in use, and one estimate puts up to 75,000 damaged buildings below standard.
   → *The game already models this through `CONSTRUCTION` eras. The new piece is **policy**: mandatory programs, inspection and enforcement, not only clicking retrofits one building at a time.*
2. **A few specific weaknesses cause most collapses**, and the fixes are targeted and cheap: soft or open ground storeys, unreinforced masonry (URM) parapets and facades, non-ductile concrete, and pounding between adjacent buildings.
3. **Site effects pick the victims.** Mexico City's lakebed clay had a period of about 2 s. Mid-rise buildings, mostly 5–15 storeys, resonated and collapsed 350 km from the epicentre. Liquefaction in Kobe's Port Island and in Urayasu (2011, about 27,000 houses damaged nationally) followed the reclaimed fill almost exactly.
   → *`resonance()`, `groundPeriod()` and `GroundFailure` already simulate this. The player needs to **see** it and have tools that act on it.*
4. **Secondary disasters (fire, lifelines) and falling debris kill people who were outside.** In Christchurch, falling masonry at 605 Colombo Street killed people in a bus and pedestrians on the street. After Kobe, Tokyo built firebreak belts through its dense wooden districts and installed gas meters that shut off automatically.

Cost-effectiveness: the US National Institute of Building Sciences "Mitigation Saves" study estimates that **seismic retrofit of buildings saves $13 per $1**. Adopting modern earthquake codes saves $12 per $1, and building above code saves $4 per $1. These ratios are good targets for the after-action report.

---

## 2. Catalogue of measures

Each entry lists:
* **Real basis**: who did it and what happened.
* **Effect**: the realistic size of the effect.
* **Game**: how to model it, and the code hook.
* **Cost**: a suggested price consistent with `COSTS` (retrofit $350/m², isolate $1,100/m²).

### A. Structural retrofits (per building tools)

#### A1. Soft-storey retrofit ★ high priority
* **Real basis:** Los Angeles (2015) and San Francisco (2013) passed mandatory retrofit ordinances for wood-frame apartments with weak or open ground floors, such as tuck-under parking and shopfronts. Owners added steel moment frames or shear walls on the ground floor only. LA has retrofitted about 8,100 buildings, protecting about 117,000 homes. A University of Colorado study estimates $1.3 B spent against about $41 B in losses avoided.
* **Effect:** It removes the soft-storey collapse mechanism. Retrofitted buildings behave close to their parent code class. Cost is about $40–160k per building, or $5–15k per unit.
* **Game:**
  * Add a `softStorey` flag to a building, set from archetypes with open fronts.
  * The retrofit sets `b.softStoreyFixed = true`. That disables the topple trigger at `world.openFront()` (`world.js:1633`) and raises `medians[2..3]` by about 25–35%.
  * It is cheap because only the ground floor is priced: `footprint × ~$250/m²`, not the whole floor area.
  * The inspect panel should show a "Soft storey: open shopfront" warning.

#### A2. Facade, parapet and non-structural anchoring ★ high priority
* **Real basis:** Christchurch 2011, where falling URM facades killed people on the street. In 2017, after Kaikōura, New Zealand ordered URM parapets and facades on busy streets in Wellington and two other towns secured within 12 months. Government and councils paid 50%, capped at NZ$15k per facade and NZ$10k per parapet. California's 1986 URM law took a similar approach.
* **Effect:** It does little for whether the building collapses. It greatly reduces casualties outside the building: pedestrians, cars and people in the street.
* **Game:**
  * Add `b.facadeAnchored`. In `shedFacade()` (`world.js:2113`), cut chip and glass emission by about 80%.
  * Lower the street casualties `strikeAt` causes from a building's own facade.
  * Make it cheap (about $60/m² of facade area) and pair it with a city policy (C3).

#### A3. Strengthening: shear walls, jacketing and bracing (the existing **Retrofit** tool)
* **Real basis:** Japan's post-1995 "taishin" diagnosis and retrofit subsidies for pre-1981 buildings. Turkey's ISMEP (2004–2015, $1.2 B with $550 M from the World Bank) retrofitted or rebuilt more than 1,000 schools and about 115 health buildings in Istanbul, to ASCE 41 and the Turkish code.
* **Game:** Keep it as is. Consider letting the player pick a **target performance** instead of a fixed "one level up":
  * **Life Safety**: cheaper. The building may be a write-off, but it won't collapse. Raise only `collapse` and `medians[3]`.
  * **Immediate Occupancy**: more expensive. Raise all medians. This matters for hospitals and fire stations.

  ASCE 41 uses exactly this split, and it gives players a real trade-off.

#### A4. Supplemental dampers (viscous dampers, BRBs, oil dampers)
* **Real basis:** Shinjuku Center Building (Tokyo) was retrofitted with oil dampers. In the 2011 Tōhoku earthquake its recorded response was about 20% lower than it would have been without them. Studies of existing high-rises found fluid viscous dampers most effective at cutting repair cost, ahead of buckling-restrained braces.
* **Effect:** The damping ratio rises from about 5% to 15–25%, drift falls by about 20–40%, and the benefit is largest for mid- and high-rise buildings in long-period shaking.
* **Game:**
  * Set `b.damping = 0.2`. In `stepFrame()` (`world.js:2335`), scale the dashpot coefficient.
  * In `quakeSim`, apply a demand reduction of about `1/sqrt(ζ/0.05)`, capped at about 0.7×. This is the standard spectral damping modifier, so it is physically grounded.
  * Restrict it to 4+ floors.

#### A5. Tuned mass damper for very tall buildings
* **Real basis:** Shinjuku Mitsui Building (55 floors, 1974). In 2015 Kajima installed six roof pendulums of about 300 t each to counter long-period ground motion, an alternative to demolition. Taipei 101 is the best-known example of the same idea.
* **Effect:** It works only near the building's own period. That makes it the natural counter to `resonance()`.
* **Game:**
  * Allow it on 20+ floors only.
  * When `|T_building − T_ground| / T_building < 0.3`, cut the resonance multiplier toward 1.0. Otherwise it has little effect.
  * Give the building a visible roof pendulum.
  * This teaches players about resonance directly.

#### A6. Base isolation (existing **Isolate** tool)
* **Real basis:** Retrofits of San Francisco City Hall (1997, about 550,000 ft², the largest isolation retrofit of its time), the Utah State Capitol (256 isolators), and NZ's Te Papa and Parliament. Engineers chose it for historic and essential buildings because it leaves the interior untouched.
* **Game:** It is already modelled.
  * It suits short and mid-rise buildings and works poorly on very soft soil with long-period shaking. Consider scaling its benefit down when `groundPeriod` is above about 2 s, which is a real design limitation.
  * Also add a moat gap requirement (see B3).

### B. Foundations and ground

#### B1. Ground improvement against liquefaction ★ high priority, area tool
* **Real basis:** Kobe 1995. On Port and Rokko Islands, ground treated with sand compaction piles or vibro-compaction suffered much less deformation than untreated fill next to it. It was not perfect: sites failed where the bottom of the fill was left untreated. After 2011, Urayasu installed **grid-wall deep soil mixing** under residential blocks.
* **Methods:**

  | Method | Approach | Cost | Best for |
  |---|---|---|---|
  | Compaction (sand compaction piles or vibro) | Densifies the soil | Cheapest | Open land |
  | Gravel drains | Relieve pore pressure | Moderate | Retrofit near buildings |
  | Deep soil mixing grids | Cement walls in a grid | Most expensive | Under existing streets and houses |
  | Compaction grouting | Injected grout | Moderate | Under existing buildings |

* **Game:**
  * Make it a new **paint tool** over ground cells, like the levee tool.
  * In `GroundFailure`, raise `crr0[k]` (and therefore `crr[k]`) by 1.5–2.5×. This matches the 1.5–2.5× resistance gain measured at Port Island.
  * Price it per cell. Make it cheaper on cells with no building (open land) and more expensive under buildings (grouting).
  * The visual: a liquefaction overlay that turns from red to green.

#### B2. Pile or deep foundations for low-rise on soft soil
* **Real basis:** In Urayasu, houses on shallow foundations tilted badly enough that residents got dizzy, even though the houses were otherwise undamaged. Piled buildings nearby did not tilt.
* **Game:** Set `b.piled = true`, which makes the code use the existing `piled` path (`quakeSim.js:557`) instead of assuming piles only at 10+ floors. Price it per footprint area. Only buildings on liquefiable cells benefit, and the inspect panel should say so.

#### B3. Seismic gaps and pounding prevention
* **Real basis:** Mexico City 1985 had many pounding failures, typically top floors smashed by a neighbour with different floor heights. A secondary source says pounding led to collapse in about 15% of the cases where it occurred. Modern codes require a separation gap, the square-root-of-sum-of-squares of both buildings' drifts.
* **Game:**
  * The sim doesn't model pounding yet. Add it cheaply: for adjacent buildings, where the sway amplitudes from `frameOf` summed exceed the gap and the periods differ, apply `applyImpact` to both.
  * Mitigation options are "tie together" (steel links, for equal heights) or "add bumpers/infill" for the lower building.
  * This is medium priority: it needs new simulation work.

### C. City policies (new `UPGRADES` entries, with the realistic part being **time** and **compliance**)

Real programs are mandates with deadlines and partial compliance, not instant upgrades. LA's 7-year window reached about 69% completion. A good mechanic is "pass ordinance → X% of eligible buildings get done per prep-turn, with cost split between city and owners (cheaper for the city, slower)."

#### C1. Mandatory soft-storey ordinance (LA/SF model)
It applies A1 automatically to a share of eligible buildings, with the city paying only for subsidies.

#### C2. Seismic code upgrade and enforcement
* **Real basis:** Japan 1981 and 2000, Turkey's post-1999 code, and Turkey's amnesty failure.
* **Game:** New buildings get better medians. A separate **enforcement / inspection** upgrade affects a hidden **compliance** factor. Without it, X% of "modern" buildings secretly perform one class lower. Expose this through Inspect, for example "Code compliance: unverified". This teaches the Turkey 2023 lesson.

#### C3. Earthquake-prone building register (NZ model)
Rating buildings (%NBS-style), placarding them, and setting deadlines. In the game it reveals the risk overlay and precise numbers, and is a prerequisite for C1 and A2 subsidies. It is cheap. **Information as a resource** is a good early-game buy.

#### C4. Microzonation and soil-based zoning
* **Real basis:** Mexico City's code zones (Lake/Transition/Hill) and Japan's liquefaction hazard maps.
* **Game:** Unlock a soil and ground-period overlay. It lets you forbid new mid-rise buildings in resonance-prone zones, or require piles on liquefiable cells.

#### C5. Earthquake early warning (existing)
* **Real basis:** Mexico's SASMEX gave Mexico City about 60–120 s for distant coastal quakes, but only seconds for the close Puebla 2017 quake.
* **Game:** Scale the casualty reduction by epicentral distance. A close quake gives about 0–10 s, so the benefit is small. Also add trains stopping and elevators parking at the nearest floor (Japan's UrEDAS / Shinkansen).

#### C6. Automatic gas shutoff (existing)
* **Real basis:** Tokyo Gas microcomputer meters cut supply at about JMA 5 shaking. The SUPREME network uses about 3,800 seismic sensors to isolate districts.
* **Game:** Possibly split it into two upgrades: household meters (fewer ignitions) and network-block shutoff (stops fire spreading on gas lines).

### D. Urban form, fire and lifelines

#### D1. Firebreak belts and fire-resistant rebuilding in dense wooden districts
* **Real basis:** Tokyo's post-Kobe "Urban Development Plan for Disaster Resistance" covers 28 districts and about 6,500 ha. It widens roads as firebreaks and evacuation routes and subsidises rebuilding wooden houses as fire-resistant ones.
* **Game:**
  * Designate a road or strip as a "fire-break corridor". It demolishes or widens the strip, stops fire spreading in `fireSim.js`, and keeps the road passable.
  * Add a "fireproof rebuild subsidy" for `wood_old` (lower `fire`).

#### D2. Evacuation parks / open space (existing **Park**)
* **Real basis:** Japan's designated wide-area evacuation sites, many of them parks with water tanks, emergency toilets and stockpiles.
* **Game:** Add a "disaster-prevention park" upgrade for parks, with a water cistern (helps firefighting nearby) and stockpiles (fewer injuries become critical).

#### D3. Seismic-resistant water mains
* **Real basis:** Kubota's earthquake-resistant ductile iron pipe (vendor claim: about 270 km in Kobe 1995 with no leaks). LADWP pilots after Northridge, where more than 1,000 mains broke at a cost of $41 M.
* **Game:** If fire-fighting depends on water pressure, this keeps hydrants working after the quake. It strongly links to the fire sim.

#### D4. Bridge retrofit (seat extenders, column jacketing)
* **Real basis:** Caltrans' statewide bridge retrofit after the Loma Prieta (Cypress Viaduct) and Northridge earthquakes.
* **Game:** Bridges already exist in `quakeSim` (`quakeSim.js:346`). Retrofit lowers the chance of a span falling and keeps evacuation and rescue routes open.

#### D5. Hospital and school priority programs
* **Real basis:** California SB 1953 (hospitals), the Field Act (schools, after Long Beach 1933), Japan's near-complete public-school retrofit, and Istanbul's ISMEP.
* **Game:** A bundle discount for retrofitting all buildings of a type. The after-action report shows "hospital functional after the quake" as a key metric.

---

## 3. Using the new physics models in the UI

* **Inspect panel: the resonance gauge.**
  * Show the building period from `buildingPeriod(b)` on a horizontal axis, next to the ground's predominant period from `groundPeriod(...)` for the scenario.
  * Shade the band where `resonance()` > 1.2. Label it: "This 9-storey frame (T≈0.9 s) is close to the soft-soil shaking period (≈1 s): +40% demand."
  * Mexico City 1985 is a good tooltip example.
* **Recommendations engine.** Based on soil type and resonance, rank the measures by risk reduction per $M, using the same math as `quakeRisk`:
  * liquefiable + low-rise → ground improvement or piles;
  * resonance band + mid-rise → dampers;
  * tall + long-period → TMD;
  * URM on a busy street → facade anchoring;
  * open shopfront → soft-storey retrofit.
* **After-action report.** Report "losses avoided by your measures", by re-running a counterfactual with the same seed. Then show the benefit-cost ratio next to the real-world NIBS benchmarks: 13:1 for retrofit, 12:1 for code adoption.

---

## 4. Suggested priority order

| # | Measure | Why first | Effort |
|---|---|---|---|
| 1 | Soft-storey retrofit (A1) | Hook (`openFront`) already exists; large real-world evidence base | S |
| 2 | Facade anchoring (A2) | Hook (`shedFacade`) exists; addresses street casualties | S |
| 3 | Resonance gauge in Inspect (§3) | Models exist; makes A4/A5 meaningful | S |
| 4 | Ground improvement paint tool (B1) + piles (B2) | `crr` grid + `piled` path exist | M |
| 5 | Dampers (A4) + TMD (A5) | Small change in `stepFrame`/demand | M |
| 6 | Policies with compliance over time (C1–C3) | New progression mechanic | M |
| 7 | Code enforcement / hidden compliance (C2) | Strong teaching point | M |
| 8 | Firebreaks, water mains, bridges (D1, D3, D4) | Couples to fire/traffic sims | M–L |
| 9 | Pounding + seismic gaps (B3) | Needs new physics | L |

Small fix to do along the way: in `fracture.js` the density table uses the key `wood`, but the construction is called `wood_mod`, so it falls back to a default density.

---

## Sources

* LA soft-story program results and costs: [Univ. of Colorado study](https://scholar.colorado.edu/downloads/4f16c4248), [Pasadena staff report 2019](https://ww2.cityofpasadena.net/2019%20Agendas/Feb_25_19/AR%2015.pdf), [CBS News](https://www.cbsnews.com/news/los-angeles-earthquake-retrofit-apartment-buildings-new-rules/)
* NIBS Mitigation Saves: [seismic retrofit 13:1](https://www.NIBS.org/files/pdfs/ms_v3_retrofit_earthquake.pdf), [code adoption](https://www.NIBS.org/files/pdfs/ms_v3_adopts_earthquake.pdf), [exceed code](https://www.NIBS.org/files/pdfs/ms_v3_exceeds_earthquake.pdf)
* Istanbul ISMEP: [World Bank brief](https://www.worldbank.org/en/country/turkey/brief/the-istanbul-seismic-risk-mitigation-project), [World Bank results](https://www.worldbank.org/en/results/2014/08/05/enhancing-seismic-preparedness-in-istanbul), [IPCU](https://www.ipkb.gov.tr/en/istanbul-project-coordination-unit-strenghtened-26-schools-and-kartal-dr-lutfi-kirdar-training-and-research-hospital-against-earthquake-in-2019/)
* Shinjuku TMD / dampers: [Kajima 17WCEE paper](https://wcee.nicee.org/wcee/article/17WCEE/2g-0107.pdf), [16WCEE 3440](https://www.wcee.nicee.org/wcee/article/16WCEE/WCEE2017-3440.pdf), [SmartPlanet](https://www.smartplanet.com/article/tokyos-innovative-solution-to-keep-skyscrapers-from-toppling-during-earthquakes/), [damper comparison WCEE2017-1930](https://www.wcee.nicee.org/wcee/article/16WCEE/WCEE2017-1930.pdf)
* Kobe ground improvement: [GEER Kobe ch.4 improved ground](https://geerassociation.org/components/com_geer_reports/geerfiles/Kobe_1995/ch4-1.html), [GEER summary](https://geerassociation.org/components/com_geer_reports/geerfiles/Kobe_1995/ch8.html)
* Urayasu liquefaction and grid walls: [WCEE2012-2641](https://www.iitk.ac.in/nicee/wcee/article/WCEE2012_2641.pdf), [17WCEE 4b-0012](https://wcee.nicee.org/wcee/article/17WCEE/4b-0012.pdf)
* Mexico City 1985 resonance and pounding: [EGU blog](https://blogs.egu.eu/network/volcanicdegassing/2015/09/18/the-mexico-city-earthquake-19-september-1985/), [Penn State summary](https://www.engr.psu.edu/ae/thesis/failures/MKP/failures/failures.wikispaces.com/1985_Mexico_City_Summary_and_Lessons_Learned.html), [Nature abstract](https://www.doi.org/10.1038/326783A0)
* Japan 1981 code: [GFDRR knowledge note](https://www.gfdrr.org/sites/default/files/publication/knowledge-note-japan-earthquake-1-2.pdf), [Cotality](https://www.cotality.com/au/hazard-hq/magnitude-7-5-earthquake-shocks-western-japan) (secondary)
* Turkey 2023 enforcement: [Frontiers in Earth Science 2024](https://www.frontiersin.org/articles/10.3389/feart.2024.1376924/full), [Institut Kurde / NYT reprint](https://www.institutkurde.org/en/info/amnesty-in-turkey-for-construction-violations-is-scrutinized-after-quake-1232552258)
* NZ facades and EPB: [Newshub 2017](https://newshub.co.nz/home/new-zealand/2017/01/wellington-s-quake-prone-building-owners-given-12-month-deadline.html), [2025 EPB review](https://www.beehive.govt.nz/sites/default/files/2025-09/Report%20of%20Seismic%20Risk%20Management%20Review.pdf), [Canterbury Royal Commission](https://canterbury.royalcommission.govt.nz/documents-by-key/20111205.1529/$File/BUI.COL605-613.0009.pdf)
* Base isolation retrofits: [Forell | Elsesser](https://forell.com/practice/expertise/base-isolation), [BD+C Utah Capitol](https://bdcnetwork.com/home/article/55144176/platinum-award-world-class-revival-on-utahs-capitol-hill)
* Early warning: [SSA on SASMEX](https://seismosoc.org/news/mexicos-early-warning-system-perform-recent-earthquakes), [PreventionWeb 78 s](https://www.preventionweb.net/news/78-seconds-earthquake-early-warning)
* Gas shutoff: [Tokyo Gas SUPREME (13WCEE)](https://wcee.nicee.org/wcee/article/13_157.pdf), [ADRC Japan good practices](https://www.adrc.asia/publications/TDRM2005/TDRM_Good_Practices/PDF/PDF-2009e/4.Japan-1.pdf)
* Tokyo dense wooden districts: [TMG urban development pamphlet](https://www.toshiseibi.metro.tokyo.lg.jp/documents/d/toshiseibi/pdf_pamphlet_pdf_udt2025english_2), [Tokyo Resilience](https://tokyo-resilience.metro.tokyo.lg.jp/en/news/4410/)
* Water mains: [Kubota ERDIP](https://www.kubota.com/products/ironpipe/catalog/pdf/ERDIP.pdf) (vendor), [WaterWorld LADWP pilot](https://www.waterworld.com/drinking-water-treatment/distribution/article/16193807/earthquake-resistant-ductile-iron-pipe-makes-us-debut-in-los-angeles)
