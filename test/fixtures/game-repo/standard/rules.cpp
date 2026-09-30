#include "gamedata.h"
#include "gamedefs.h"

static int am[] = { 0, 1, 2, 3, 5, 7 };
int *allowedMages = am;
int allowedMagesSize = sizeof(am) / sizeof(am[0]);

static GameDefs g = {
	"Wyreth",				// RULESET_NAME
	8, /* MAX_SPEED */
};
