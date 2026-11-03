# Atlantis code guide

A map from game topics to the functions, tables and constants in the Atlantis
engine (Atlantis-PBEM/Atlantis, `stable` layout) that decide them. The bot's
`read_guide` tool serves one topic at a time, with every symbol resolved to
`path:line` in the current checkout, so this file names symbols only and
never line numbers or values. Format: `## <topic>`, one to three sentences,
then entries `` - `Symbol` (path): what it decides ``. Run `npm run guide:check`
after editing it. Keep it pointing, not explaining: the numbers and formulas
must come from the code the model then reads.

## Starting a battle and who takes part
ATTACK only reaches units in the attacker's region and must pass the attacker's visibility and catching checks first; monsters attack on their own through the wandering-monster code. A unit inside any building or lair (anything but the region's dummy object) is always visible and catchable, so stealth and riding do not protect a lair monster. Other factions join a side based on attitudes, the NOAID flag and ALLIES_NOAID.
- `Game::DoAttackOrders` (runorders.cpp): walks each unit's ATTACK orders and hands each target to AttemptAttack.
- `Game::AttemptAttack` (runorders.cpp): the checks that make an ATTACK fail (target not seen, not caught, already routed) before the battle is run.
- `Faction::CanSee` (faction.cpp): visibility: own faction, reveal flags, guarding, being inside an object, then observation versus stealth.
- `Faction::CanCatch` (faction.cpp): whether a target can be caught; riding skill versus the target's, objects, and the mounted-pursuit rules.
- `Game::GetDFacs` (battle.cpp): which factions defend alongside the target (allies, NOAID, ALLIES_NOAID).
- `Game::GetSides` (battle.cpp): builds the two sides, including joiners from adjacent regions, guards and assassinations.
- `Game::CanAttack` (battle.cpp): whether a joining faction can engage a particular unit (someone must see it and someone must catch it).
- `Game::CheckWMonAttack` (runorders.cpp): the roll that makes a wandering monster attack a unit in its region, using the monster's hostility.
- `Game::RunBattle` (battle.cpp): top-level driver: gathers sides, runs the battle, reports it, and kills the dead.

## Battle rounds and the tactics bonus
Rounds run until one army is broken or the round limit in Battle::Run is reached. Tactics gives either a free round of attacks to the higher side (classic) or a per-round bonus when ADVANCED_TACTICS is set. A vastly outnumbered army counts as overwhelmed, which changes the free round.
- `Battle::Run` (battle.cpp): the whole battle loop: compares tactics, grants free rounds or the tactics bonus, runs rounds, decides rout and the winner.
- `Battle::FreeRound` (battle.cpp): a round where only one side attacks.
- `Battle::NormalRound` (battle.cpp): a regular round: updates shields, every soldier attacks, healing and regeneration afterwards.
- `IsArmyOverwhelmedBy` (battle.cpp): the size ratio at which an army counts as overwhelmed.
- `ADVANCED_TACTICS` (standard/rules.cpp): switch between free-round tactics and bonus tactics.
- `Army::Army` (army.cpp): how an army's tactics value is taken from its best tactician when it is built.

## Hit odds and the attack roll
Each attack resolves in Army::DoAnAttack: the attack type picks the shield that can block it and the defender's resistance, the attacker's level is rolled against the defender's, then armor may save. Mount bonuses and the front/behind rules decide who can be hit. The rules' Combat section gives the published odds; these functions give the exact order of checks.
- `Army::DoAnAttack` (army.cpp): one soldier's attacks for the round: shield check, target choice, attack level versus defence level, damage and effects.
- `Battle::DoAttack` (battle.cpp): prepares a soldier's normal and special attacks for the round (weapon class, mount bonus, number of attacks, behind rules).
- `Army::GetTargetNum` (army.cpp): who can be hit: front line first, behind only for attacks that may reach it, special target filters.
- `Soldier::Soldier` (army.cpp): a soldier's attack and defence levels per attack type from skills, weapon, armor, mount and building.
- `Soldier::ArmorProtect` (army.cpp): the armor save roll against a given weapon class.
- `Unit::GetAttackRiding` (unit.cpp): the riding bonus a unit gets when attacking, given its mount and terrain.
- `Unit::GetDefenseRiding` (unit.cpp): the riding bonus when defending.
- `WeaponDefs` (gamedata.cpp): per weapon: attack type, weapon class, skill needed, attack and defence modifiers, number of attacks, ranged or not.
- `ArmorDefs` (gamedata.cpp): per armor: save chances against each weapon class.

## Hits, number of attacks and damage
A man has one attack and hits from the toughness attribute; monsters take hits and attacks per round from MonDefs. Weapons can change attacks per round and damage.
- `Soldier::Soldier` (army.cpp): sets hits, attacks per round and damage for men and for monsters.
- `Army::Kill` (army.cpp): applies damage to a soldier and removes it when its hits are gone.
- `Army::Broken` (army.cpp): when an army routs: by figures lost or by hits lost, depending on ARMY_ROUT.
- `ARMY_ROUT` (standard/rules.cpp): rout counted by soldiers lost or by hits lost.
- `MonDefs` (gamedata.cpp): per monster: attack level, defence per attack type, number of attacks, hits, tactics, special, hostility, spoils.

## Special attacks, effects and shields
Specials (monster abilities and combat spells) are SpecialDefs entries. Each round a soldier with a special raises a shield or attacks the targets that pass CheckSpecialTarget; some hits apply an EffectDefs effect such as storm or fear, lasting the battle or one round.
- `Battle::UpdateShields` (specials.cpp): which soldiers put up shields each round and at what level.
- `ShieldList::GetHighShield` (shields.cpp): the strongest shield of a given type, used to block an incoming attack.
- `Battle::DoSpecialAttack` (specials.cpp): resolves a special attack: number of attacks, which targets, damage and effect.
- `Army::CheckSpecialTarget` (specials.cpp): which units or buildings a special may hit (target flags: illusions, mounts, undead, buildings and so on).
- `Soldier::SetEffect` (army.cpp): how an effect changes a soldier's attack and defence values.
- `SpecialDefs` (gamedata.cpp): every special: shields given, attack types, damage ranges, target filters and the effect it applies.
- `EffectDefs` (gamedata.cpp): every effect: attack and defence modifiers, and whether it persists.

## Rout, end of battle and the dead
After each round both armies are checked for being broken. The loser routs and may suffer a final free round; both breaking or the round limit means a tie. Dead units are removed after the battle, where necromancers may also raise the fallen.
- `Game::KillDead` (battle.cpp): removes dead units from the world and handles raised undead.
- `ONLY_ROUT_ONCE` (standard/rules.cpp): whether a routed unit can be attacked again the same turn.

## Casualties, healing and regeneration
After a win, healers and potions try to restore some of the dead; attempts and chance come from the healing tables scaled by HEALS_PER_MAN. Monsters regenerate in battle only with MONSTER_BATTLE_REGEN.
- `Soldier::SetupHealing` (specials.cpp): how many men a healer can try to heal and with what chance (skill, magical healing, potions).
- `Army::DoHeal` (army.cpp): the order in which magical healing, potions and normal healing are applied after a battle.
- `HealDefs` (gamedata.cpp): men healed and success rate per healing level.
- `HEALS_PER_MAN` (standard/rules.cpp): multiplier for men healed per level.
- `MONSTER_BATTLE_REGEN` (standard/rules.cpp): whether monsters regenerate during battle.

## Spoils and monster treasure
There is no separate lair loot: winners get battle spoils only. Battle::GetSpoils takes a share of what the dead carried and Army::GetMonSpoils adds a dead monster's silver and random items; spoils go to surviving units that can carry them, per their SPOILS order.
- `Battle::GetSpoils` (battle.cpp): what the losers' dead drop (items, ships, quest rewards).
- `Army::GetMonSpoils` (army.cpp): the silver and item treasure of a killed monster, from its MonDefs silver and spoil type.
- `Army::Win` (army.cpp): divides spoils among the winners and reports the outcome.
- `Unit::CanGetSpoil` (unit.cpp): whether a unit will take a given item: its SPOILS setting and carrying capacity.
- `MONSTER_NO_SPOILS` (standard/rules.cpp): turns monster treasure off.
- `MONSTER_SPOILS_RECOVERY` (standard/rules.cpp): whether monster treasure regenerates over time.

## Monsters: stats, lairs, wandering and hostility
Monster numbers live in MonDefs, keyed by the monster item's abbreviation; illusions share the entry and are looked up with the illusion flag. Lair monsters come with their lair object, wandering monsters spawn per terrain, and each turn monsters may move and attack by hostility.
- `MonDefs` (gamedata.cpp): the monster table: combat stats, special, hostility, number per group, silver and spoils.
- `FindMonster` (items.cpp): resolves a monster by abbreviation, with illusions separated.
- `Game::MakeLMon` (npc.cpp): which monsters are placed in which lair object when the world is made.
- `Game::GrowWMons` (npc.cpp): where and how often new wandering monsters appear, by terrain.
- `Game::MonsterCheck` (game.cpp): per-turn behaviour of monsters a player controls: escape, getting out of control, linked skills.
- `Unit::Hostile` (unit.cpp): a monster unit's hostility value, which feeds the attack roll in CheckWMonAttack.
- `MONSTER_ADVANCE_MIN_PERCENT` (standard/rules.cpp): how likely monsters are to move toward other units.

## Magic in combat
A mage fights with the spell set by COMBAT; it must carry the COMBAT skill flag and be known, else the mage fights as a plain soldier. The spell's special decides shields, attacks and targets (see the specials topic). Battle items grant specials or shields the same way.
- `Game::ProcessCombatOrder` (parseorders.cpp): parses the COMBAT order and stores the chosen spell on the unit.
- `Soldier::SetupSpell` (army.cpp): validates the combat spell at battle time and takes its special from SkillDefs.
- `Soldier::SetupCombatItems` (army.cpp): which carried battle items give specials, shields or extra defence.
- `SkillDefs` (gamedata.cpp): per skill: the COMBAT flag and the special it casts in battle.
- `BattleItemDefs` (gamedata.cpp): battle items and the specials or shields they grant.

## Turn sequence: the order in which orders resolve
Each month the engine runs order types in a fixed sequence; `Game::RunOrders` is that list, so read it for "does X happen before Y". FORM and instant orders are handled during parsing. Land and fleet movement is interleaved phase by phase up to MAX_SPEED.

- `Game::RunOrders` (runorders.cpp): the complete month sequence, one call per order type in resolution order.
- `Game::RunMovementOrders` (monthorders.cpp): MOVE/ADVANCE/SAIL in phases, with attacks on arrival.
- `Game::RunMonthOrders` (monthorders.cpp): month-long orders (BUILD, PRODUCE, STUDY, WORK, ENTERTAIN) after movement and teaching.
- `Game::RunGame` (game.cpp): the outer turn: read orders, run them, write reports.

## Order parsing, syntax and the order checker
Each order keyword has a Process…Order function in parseorders.cpp that validates arguments and reports syntax errors; the order checker runs the same code.

- `Game::ParseOrders` (parseorders.cpp): reads an order file: #atlantis, unit, FORM/TURN blocks, repeating `@` orders.
- `Game::ProcessOrder` (parseorders.cpp): the switch from keyword to its ProcessXxxOrder handler.
- `Game::ParseUnit` (parseorders.cpp): unit arguments (number, NEW n, FACTION f NEW n).
- `Game::ProcessFormOrder` (parseorders.cpp): FORM/END and new units; `Game::ProcessTurnOrder` handles TURN/ENDTURN.
- `Game::ProcessMoveOrder` (parseorders.cpp): MOVE arguments; `Game::ProcessAdvanceOrder` and `Game::ProcessSailOrder` are beside it.
- `Game::DoOrdersCheck` (game.cpp): the order checker entry point.

## Movement on land: MOVE, ADVANCE, movement points, weather
A unit's move type (walk, ride, fly, swim) comes from its weight versus the capacities of men, mounts and items; movement points come from the speed of the slowest man or mount used. Each hex costs points by terrain, weather and roads. ADVANCE is a MOVE that attacks units forbidding entry; FLIGHT_OVER_WATER governs flying over sea.

- `Game::DoAMoveOrder` (monthorders.cpp): one step of MOVE/ADVANCE: checks, cost, guards, entering objects, running out of points.
- `Unit::MoveType` (unit.cpp): chooses walk, ride, fly or swim from weight and capacities.
- `Unit::CalcMovePoints` (unit.cpp): movement points per month for that move type, with boosts.
- `ARegion::MoveCost` (aregion.cpp): the cost to enter a hex: terrain, weather, roads.
- `Unit::CanMoveTo` (unit.cpp): whether a step between two regions is allowed at all.
- `Unit::Weight` (unit.cpp): total weight; `Unit::WalkingCapacity`, `Unit::RidingCapacity`, `Unit::FlyingCapacity`, `Unit::SwimmingCapacity` follow it.
- `Unit::GetMount` (unit.cpp): which mount a unit rides and the bonus it gives.
- `ARegionList::GetWeather` (standard/world.cpp): the month's weather per region for this variant; `ARegion::SetWeather` in aregion.cpp applies it.
- `MAX_SPEED` (standard/rules.cpp): movement phases per month; `WEATHER_EXISTS` and `FLIGHT_OVER_WATER` are in the same `GameDefs` block.

## Sailing and fleets
A fleet moves when its owner issues SAIL; the ships' sailing requirement must be met by the sailing skill of units aboard that also gave SAIL, and the load must fit the capacity. Speed is the slowest ship plus wind, crew and load boosts.

- `Game::Do1SailOrder` (monthorders.cpp): one sailing step: crew check, load check, cost, blocked coasts, arrival.
- `Object::FleetSailingSkill` (object.cpp): combined sailing skill of the units sailing the fleet.
- `Object::FleetCapacity` (object.cpp): carrying capacity; `Object::FleetLoad` is the current load.
- `Object::GetFleetSpeed` (object.cpp): fleet movement points after wind, crew and load adjustments.
- `Object::CanEnter` (object.cpp): who may board a ship or enter a building.
- `FLEET_WIND_BOOST` (standard/rules.cpp): wind bonus to fleet speed; `FLEET_CREW_BOOST` and `FLEET_LOAD_BOOST` are beside it.

## Visibility, stealth and observation
Seeing a unit is decided per faction: the observer's observation versus the target's stealth, modified by amulets, invisibility and buildings. Units inside real buildings are always visible and catchable; a guard can only forbid units it can see and catch. Stealth and observation are attributes computed from skills and items.

- `Faction::CanSee` (faction.cpp): the visibility test (0, 1, or 2 when the faction is seen too).
- `Faction::CanCatch` (faction.cpp): whether a target can be caught (riding versus riding, buildings).
- `Unit::GetAttribute` (unit.cpp): computes stealth, observation, tactics and other attributes.
- `AttribDefs` (gamedata.cpp): which skills and items feed stealth, observation, tactics, wind.
- `Unit::Forbids` (unit.cpp): whether a guarding unit blocks entry.
- `Unit::AmtsPreventCrime` (unit.cpp): amulets of true seeing against a ring of invisibility.
- `Game::Do1Assassinate` (runorders.cpp): ASSASSINATE: who spots the assassin, guards, the duel; `Game::Do1Steal` and `Game::CanSeeSteal` are beside it.
- `MAX_ASSASSIN_FREE_ATTACKS` (standard/rules.cpp): assassination duel rules; `SKILL_PRACTICE_AMOUNT` is in the same block.

## Units, factions and faction points
Faction points limit mages, taxing and trading regions, quartermasters and tacticians; the allowed counts per faction type are tables in the variant's rules.cpp and the checks are `Game::Allowed*` and `Game::Count*`. Which skills a race can learn, and how far, comes from `ManDefs`; magic is leader-only unless MAGE_NONLEADERS is set.

- `Game::AllowedMages` (game.cpp): mages allowed by faction points; `Game::AllowedTaxes`, `Game::AllowedTrades`, `Game::AllowedQuarterMasters`, `Game::AllowedTacticians`, `Game::AllowedApprentices` follow.
- `Game::CountMages` (game.cpp): what counts as a mage toward the limit.
- `allowedMages` (standard/rules.cpp): the faction-point tables; `allowedTaxes`, `allowedTrades`, `allowedQuartermasters`, `allowedTacticians`, `allowedMartial` are in the same block.
- `FACTION_LIMIT_TYPE` (standard/rules.cpp): faction types versus other limit schemes; `FACTION_POINTS` is next to it.
- `SkillMax` (skills.cpp): the highest level a race can reach in a skill.
- `ManDefs` (gamedata.cpp): races: special skills, default and special max levels, leader flag.
- `Unit::IsLeader` (unit.cpp): leaders versus normal men; `LEADERS_EXIST` and `SKILL_LIMIT_NONLEADERS` are GameDefs fields in standard/rules.cpp.
- `Game::ProcessDeclareOrder` (parseorders.cpp): DECLARE attitudes; `Faction::GetAttitude` in faction.cpp resolves them.

## Maintenance, upkeep and starvation
After all orders, every unit pays upkeep per man (leaders cost more); food can cover part of it. Shortfalls fall back from the unit to the faction to allies, and unpaid men starve or lose skill days depending on SKILL_STARVATION.

- `Game::AssessMaintenance` (runorders.cpp): the maintenance pass and the order silver and food are consumed in.
- `Unit::MaintCost` (unit.cpp): a unit's monthly upkeep in silver.
- `Game::CheckUnitMaintenanceItem` (runorders.cpp): paying from the unit; `Game::CheckFactionMaintenanceItem` and `Game::CheckAllyMaintenanceItem` follow.
- `Unit::Short` (unit.cpp): what happens to an unpaid unit; `Unit::SkillStarvation` loses skill days instead of men.
- `MAINTENANCE_COST` (standard/rules.cpp): upkeep per man; `LEADER_COST`, `UPKEEP_FOOD_VALUE`, `UPKEEP_MINIMUM_FOOD`, `SKILL_STARVATION` are in the same block.

## Studying and teaching
STUDY adds days per man; levels need a growing number of days, skills may need prerequisites, and the race caps the level. TEACH doubles a student's days if the teacher knows the skill at a higher level and teaches at most STUDENTS_PER_TEACHER men. Study costs silver; some skills need a building or count against mage limits.

- `Game::Do1StudyOrder` (monthorders.cpp): STUDY: cost, prerequisites, building needs, mage limits, days gained.
- `Unit::CanStudy` (unit.cpp): prerequisite check; `Unit::CheckDepend` tests one dependency.
- `Unit::Study` (unit.cpp): adds study days and applies the race maximum; `Unit::GetSkillMax` is the cap.
- `GetDaysByLevel` (skills.cpp): days needed per level; `GetLevelByDays` is the inverse; `SkillCost` is the silver per man.
- `Game::Do1TeachOrder` (monthorders.cpp): TEACH: valid students, teacher level, student cap, days granted.
- `SkillDefs` (gamedata.cpp): skill table: cost, dependencies, flags (magic, combat, cast).
- `STUDENTS_PER_TEACHER` (standard/rules.cpp): teacher capacity; `APPRENTICES_EXIST` and `MAGE_NONLEADERS` are in the same block.

## Magic outside combat: CAST, monthly spells, gates and teleport
CAST syntax is parsed per spell in spells.cpp; the magic phase dispatches each cast to one `Run<Spell>` function, which holds that spell's effect, counts and costs.

- `Game::ProcessCastOrder` (spells.cpp): CAST syntax and which spells take which arguments.
- `Game::RunCastOrders` (runorders.cpp): the magic phase; `Game::ClearCastEffects` resets monthly effects first.
- `Game::RunACastOrder` (spells.cpp): spell dispatch plus common checks (level, one cast a month).
- `Game::RunSummonBalrog` (spells.cpp): a summoning spell; `Game::RunSummonDemon`, `Game::RunSummonImps`, `Game::RunSummonSkeletons`, `Game::RunSummonLich` have the same shape.
- `Game::RunCreateArtifact` (spells.cpp): magic item creation and its costs.
- `Game::RunFarsight` (spells.cpp): remote viewing; `Game::RunClearSkies` and `Game::RunWeatherLore` are the weather spells.
- `Game::RunTeleportOrders` (spells.cpp): the teleport phase; `Game::RunTeleport`, `Game::RunGateJump`, `Game::RunPortalLore` do the moves.
- `Game::RunForgetOrders` (runorders.cpp): FORGET; `Unit::ForgetSkill` in unit.cpp removes the skill.
- `GATES_EXIST` (standard/rules.cpp): gate availability; `GATES_NOT_PERENNIAL` is next to it.

## Quests
Quests (kill, harvest, build, visit, demolish) are checked from the engine phase that completes them, and rewards are granted on the spot.

- `QuestList::CheckQuestKillTarget` (quests.cpp): completing a kill quest after a battle.
- `QuestList::CheckQuestHarvestTarget` (quests.cpp): harvest quests; `QuestList::CheckQuestBuildTarget`, `QuestList::CheckQuestVisitTarget`, `QuestList::CheckQuestDemolishTarget` cover the rest.

## Taxing and pillaging
Per region, the engine counts men who qualify as taxers (weapons, skills, WHO_CAN_TAX), caps the total by the region's wealth and splits it between taxing units. Pillaging takes more at once but damages the region and needs enough pillagers. Forts add a bonus; TAX_PILLAGE_MONTH_LONG makes both month-long.
- `ARegion::CanTax` (aregion.cpp): whether a unit is allowed to tax here (guards, war status).
- `Unit::Taxers` (unit.cpp): how many men of a unit count as taxers, by weapon, skill and the WHO_CAN_TAX flags.
- `Game::FortTaxBonus` (runorders.cpp): extra taxers granted by a fort the unit is in.
- `Game::CountTaxes` (runorders.cpp): sums taxers in a region, caps by wealth, sets each unit's share.
- `Game::RunTaxRegion` (runorders.cpp): pays silver per taxer and reports it.
- `ARegion::CanPillage` (aregion.cpp): whether pillaging is allowed in the region.
- `Game::RunPillageRegion` (runorders.cpp): pillage income, minimum pillagers and the wealth hit.
- `ARegion::Pillage` (economy.cpp): what pillaging does to the region's economy afterwards.
- `TAX_BASE_INCOME` (standard/rules.cpp): base silver per taxer; neighbours TAX_BONUS_WEAPON, TAX_BONUS_ARMOR, TAX_BONUS_FORT and WHO_CAN_TAX.

## Working and entertaining
WORK and ENTERTAIN are silver production: each region has a wages pool and an entertainment pool sized by population, wages and towns (WORK_FRACTION, ENTERTAIN_FRACTION, ENTERTAIN_INCOME). Units share the pool, so many workers in one region deplete it.
- `ARegion::Wages` (economy.cpp): the wage level of a region (base wages, town bonus, pillage effects).
- `ARegion::SetupEconomy` (economy.cpp): creates the wages and entertainment products from population and wages.
- `Game::RunUnitProduce` (monthorders.cpp): a unit's silver production (WORK, ENTERTAIN) and item production: men times skill level plus tool bonus.
- `Game::RunAProduction` (monthorders.cpp): shares one region product between all units attempting it.
- `WORK_FRACTION` (standard/rules.cpp): divisor that turns regional wage limits into the workable amount; see ENTERTAIN_FRACTION and ENTERTAIN_INCOME next to it.

## Production and resources
PRODUCE takes a regional resource (a Production entry with amount and skill) or turns inputs into an item per the ItemType production fields. Output is men times skill level plus tool bonus, capped by the shared regional pool, which regenerates each turn.
- `Game::RunProduceOrders` (monthorders.cpp): the region loop that runs all PRODUCE orders.
- `Game::ValidProd` (monthorders.cpp): whether a unit may produce an item here (skill, region has it, inputs).
- `Unit::GetProductionBonus` (unit.cpp): tool bonus from items like picks and hammers.
- `ARegion::SetupProds` (economy.cpp): which resources a region gets at creation, by terrain.
- `ARegion::UpdateProducts` (economy.cpp): regeneration of resource amounts each turn.
- `ItemDefs` (gamedata.cpp): per item: production skill and level, months, inputs, output count.
- `Production` (production.cpp): one region resource entry: item, skill, amount, base amount.

## Buildings and ships as objects
Buildings, fleets and lairs are ObjectDefs rows: protection, capacity, sailors, build item, skill and level, maintenance and decay, lair monster. BUILD adds work towards the cost; ENTER can be refused by the owner. Decay only applies when DECAY is on.
- `ObjectDefs` (gamedata.cpp): the building and ship table (see the ObjectType fields in object.h).
- `ObjectType` (object.h): field names: protect, capacity, sailors, maxMages, item, cost, skill, level, maintenance, defenceArray.
- `Game::Run1BuildOrder` (monthorders.cpp): builds or repairs a structure: skill check, materials, progress.
- `Game::RunBuildShipOrder` (monthorders.cpp): ship building and adding ships to fleets.
- `Game::RunBuildHelpers` (monthorders.cpp): units helping another unit's BUILD.
- `Object::CanEnter` (object.cpp): whether a unit may enter; `Object::ForbiddenBy` is the owner's veto.
- `Game::Do1EnterOrder` (runorders.cpp): the ENTER order itself.
- `Object::FleetCapacity` (object.cpp): carrying capacity of a fleet; `Object::FleetLoad` is the current load.
- `ARegion::DoDecayCheck` (aregion.cpp): building decay and maintenance when DECAY is enabled.
- `ObjectDescription` (object.cpp): the engine's player-facing text for a building type.

## Markets and trade
Each region has Market entries (item, price, amount, buy or sell) created from terrain and town size (CITY_MARKET_*). BUY and SELL are shared out when demand exceeds supply; prices and amounts drift back towards base each turn. IT_NORMAL, IT_ADVANCED and IT_TRADE decide where an item can be traded.
- `ARegion::SetupCityMarket` (economy.cpp): which items a town buys and sells and at what price.
- `Market::PostTurn` (market.cpp): price and amount recovery each turn.
- `Game::RunBuyOrders` (runorders.cpp): BUY resolution; `Game::GetBuyAmount` totals demand, `Game::DoBuy` splits it.
- `Game::RunSellOrders` (runorders.cpp): SELL resolution; `Game::GetSellAmount` and `Game::DoSell` mirror the buy side.
- `CITY_MARKET_NORMAL_AMT` (standard/rules.cpp): market sizes; see the CITY_MARKET_* fields next to it.
- `IT_TRADE` (items.h): item type flags that classify goods for markets.

## Regions, terrain and the world
The TerrainDefs row gives population range, wages, economy, movement cost, races, resources and lair chances. Population grows and migrates; towns raise wages and markets. Weather and the levels (surface, underworld, underdeep, abyss, nexus) come from the variant's world and map code; gates exist when GATES_EXIST.
- `TerrainDefs` (gamedata.cpp): the terrain table (TerrainType fields in aregion.h: pop, wages, economy, movepoints, races, lairChance).
- `ARegion::SetupPop` (economy.cpp): starting population, race and town for a region.
- `ARegion::Grow` (economy.cpp): population growth each turn.
- `ARegion::TownGrowth` (economy.cpp): town growth and shrinkage.
- `ARegion::PostTurn` (economy.cpp): the end-of-turn update of a region's economy.
- `ARegion::MoveCost` (aregion.cpp): movement points to enter a region (terrain, roads, weather).
- `ARegionList::GetWeather` (standard/world.cpp): weather by month and latitude for the variant.
- `ARegionList::CreateUnderworldLevel` (standard/map.cpp): how underworld levels are built; see UNDERWORLD_LEVELS and UNDERDEEP_LEVELS in rules.cpp.
- `ARegionList::FinalSetupGates` (standard/map.cpp): gate placement; `Game::RunGateJump` in spells.cpp handles jumping.

## Items and the data tables
The gamedata.cpp tables follow the field order of the classes in items.h and skills.h, and row positions match the I_*, S_*, O_* enums in gamedata.h. A row is only the default: extra.cpp calls the Enable*/Modify* helpers in modify.cpp, and ItemType::DISABLED marks entries switched off.
- `ItemDefs` (gamedata.cpp): items (ItemType fields in items.h: flags, type, weight, capacities, production and magic production).
- `WeaponDefs` (gamedata.cpp): weapon class, attack type, skills, bonuses, attacks per round.
- `ArmorDefs` (gamedata.cpp): armor save chances per weapon class.
- `MountDefs` (gamedata.cpp): riding bonuses and the skill they need.
- `BattleItemDefs` (gamedata.cpp): items that grant a special in battle.
- `SkillDefs` (gamedata.cpp): skill cost, dependencies, flags, special and range (SkillType in skills.h).
- `DISABLED` (items.h): the ItemType flag values (CANTGIVE, DISABLED, NOMARKET and more).
- `Game::ModifyTablesPerRuleset` (standard/extra.cpp): the variant's edits to all tables.
- `Game::EnableItem` (modify.cpp): the Enable/Disable/Modify helpers extra.cpp uses, one per table field.
- `ItemDescription` (items.cpp): the engine's item text shown to players; `ShowSkill::Report` in skillshows.cpp does the same for skills.

## Variants and game constants
A variant directory holds rules.cpp (the GameDefs values), extra.cpp (table edits, faction setup), world.cpp and map.cpp (world generation, weather) and monsters.cpp. Code reads constants through Globals, so searching a field name finds every use.
- `GameDefs` (gamedefs.h): declares every constant with a comment explaining it; the authoritative field list.
- `Globals` (standard/rules.cpp): the variant's values, one line per field with the field name in a comment.
- `allowedMages` (standard/rules.cpp): faction point tables (also allowedApprentices, allowedTaxes, allowedTrades, allowedQuartermasters).
- `Game::SetupFaction` (standard/extra.cpp): a new faction's starting units, money and items.
- `Game::ModifyTablesPerRuleset` (standard/extra.cpp): items, skills and objects enabled or changed for the variant.
- `FACTION_LIMIT_TYPE` (standard/rules.cpp): which faction limit system the variant uses; FACTION_POINTS sets the points.
- `MAINTENANCE_COST` (standard/rules.cpp): upkeep per man; see BASE_MAN_COST and START_MONEY nearby.

## The player report and what players can see
The report lists regions where the faction is present or passed through; units are filtered by observation versus stealth, markets and products by skills, and item and skill writeups appear as they are discovered. Start here for "why don't I see X".
- `Faction::WriteReport` (faction.cpp): the whole report: regions, battles, errors, item and skill writeups.
- `ARegion::WriteReport` (aregion.cpp): one region: exits, products, markets, objects and units.
- `ARegion::GetObservation` (aregion.cpp): a faction's best observation in the region; `ARegion::GetTrueSight` is true seeing.
- `Faction::CanSee` (faction.cpp): whether a faction sees a unit (stealth vs observation, buildings, guards).
- `Unit::WriteReport` (unit.cpp): how much detail of a unit is shown at a given observation level.
- `ARegion::WriteProducts` (aregion.cpp): resources shown, advanced ones only with the skill.
- `Faction::DiscoverItem` (faction.cpp): when an item's description is added to the report.
