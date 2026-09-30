#include "gamedata.h"

//
// Table of items
//
// name, plural, abbr,
// flags,
// pSkill, pLevel, pMonths, pOutput, pInput array
// weight, type, baseprice, combat,


std::vector<ItemType> ItemDefs =
{
    {"leader", "leaders", "LEAD",
     ItemType::NOTRANSPORT,
     NULL, 0, 0, 0, {{-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}},
     10, IT_MAN | IT_LEADER, 100, 1},
    // A stray brace in a comment must not confuse the parser: {
    {"iron", "iron", "IRON",
     0,
     "MINI", 1, 1, 1, {{-1, 0}, {-1, 0}, {-1, 0}, {-1, 0}},
     5, IT_NORMAL, 60, 0},
    {"plate armor","plate armor","PARM",
     ItemType::DISABLED,
     "ARMO",3,3,1, {{I_IRON,3},{-1,0},{-1,0},{-1,0}},
     3, IT_NORMAL | IT_ARMOR, 250,1},
};

//
// Table of armor.
//
// abbr, flags, from, slashChance, ...
//
std::vector<ArmorType> ArmorDefs = {
    // ARMOR_PLATEARMOR
    { "PARM", 0, 100, {67, 67, 67, 67, 33, 33, 33, 33}},
};

//
// Table of skills.
//
// name, abbr, cost,
// flags
//
std::vector<SkillType> SkillDefs = {
    {"armorer","ARMO",10,
     0,
     std::nullopt, std::nullopt,
     {{NULL,0},{NULL,0},{NULL,0}}},
    {"tactics","TACT",200,
     SkillType::BATTLEREP,
     std::nullopt, std::nullopt,
     {{NULL,0},{NULL,0},{NULL,0}}},
};
