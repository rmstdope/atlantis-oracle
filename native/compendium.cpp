// Prints the game's own player-facing descriptions of every enabled item,
// monster, skill (per level) and object, as the engine writes them into turn
// reports. Built by atlantis-oracle (src/rules/build.ts) against the engine
// objects of one game variant; it is not part of the game.
//
// Output: a header line "@@<kind>\t<abbr>\t<name>\t<level>" followed by the
// description and a blank line. <kind> is monster, illusion, item, skill or
// object. Illusions share their monster's name and abbreviation in the tables.

#include "faction.h"
#include "game.h"
#include "gamedata.h"
#include "items.h"
#include "object.h"
#include "skills.h"

#include <cstdio>

static void entry(const char *kind, const char *abbr, const char *name, int level, AString *text)
{
	if (text && text->Len() > 0) {
		printf("@@%s\t%s\t%s\t%d\n%s\n\n", kind, abbr ? abbr : "", name ? name : "", level, text->Str());
	}
	delete text;
}

int main()
{
	Game game;
	initIO();
	game.ModifyTablesPerRuleset();
	Faction faction;

	for (int i = 0; i < NITEMS; i++) {
		if (ItemDefs[i].flags & ItemType::DISABLED) continue;
		const char *kind = (ItemDefs[i].type & IT_ILLUSION) ? "illusion"
			: (ItemDefs[i].type & IT_MONSTER) ? "monster" : "item";
		entry(kind, ItemDefs[i].abr, ItemDefs[i].name, 0, ItemDescription(i, 1));
	}

	for (int s = 0; s < NSKILLS; s++) {
		if (SkillDefs[s].flags & SkillType::DISABLED) continue;
		for (int level = 1; level <= 5; level++) {
			ShowSkill show(s, level);
			entry("skill", SkillDefs[s].abbr, SkillDefs[s].name, level, show.Report(&faction));
		}
	}

	for (int o = 0; o < NOBJECTS; o++) {
		entry("object", "", ObjectDefs[o].name, 0, ObjectDescription(o));
	}

	doneIO();
	return 0;
}
