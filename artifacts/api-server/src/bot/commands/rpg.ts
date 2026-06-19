import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { ensureRpg, updateRpg, addToInventory, getInventory, removeFromInventory, getUser, updateUser, getGroup, updateGroup, getMentionName } from "../db/queries.js";
import { formatNumber } from "../utils.js";

const CLASSES = ["Warrior", "Mage", "Archer", "Rogue", "Paladin", "Assassin"];
const CLASS_STATS: Record<string, { hp: number; attack: number; defense: number; speed: number }> = {
  Warrior: { hp: 150, attack: 25, defense: 20, speed: 10 },
  Mage: { hp: 80, attack: 40, defense: 8, speed: 18 },
  Archer: { hp: 100, attack: 35, defense: 12, speed: 22 },
  Rogue: { hp: 90, attack: 38, defense: 10, speed: 28 },
  Paladin: { hp: 140, attack: 22, defense: 28, speed: 8 },
  Assassin: { hp: 85, attack: 45, defense: 7, speed: 30 },
};

const ADVENTURES = [
  { name: "Forest Quest", enemy: "Goblin", reward: 300, difficulty: 1 },
  { name: "Mountain Climb", enemy: "Troll", reward: 600, difficulty: 2 },
  { name: "Dark Cave", enemy: "Dragon", reward: 1500, difficulty: 3 },
  { name: "Castle Siege", enemy: "Dark Knight", reward: 3000, difficulty: 4 },
  { name: "Shadow Realm", enemy: "Demon Lord", reward: 8000, difficulty: 5 },
];

const QUESTS = [
  { name: "Slay 5 slimes", reward: 200, xp: 50 },
  { name: "Collect 10 herbs", reward: 150, xp: 30 },
  { name: "Rescue a village", reward: 500, xp: 100 },
  { name: "Defeat the bandit boss", reward: 800, xp: 150 },
  { name: "Find the lost artifact", reward: 1200, xp: 200 },
];

interface DungeonBattle {
  groupId: string;
  floor: number;
  enemyName: string;
  enemyHp: number;
  enemyMaxHp: number;
  enemyAttack: number;
  enemyLevel: number;
  enemyReward: number;
  playerHp: number;
  playerMaxHp: number;
  playerAttack: number;
  playerDefense: number;
  healCooldown: number;
  defendActive: boolean;
  lastActivity: number;
}

export const activeDungeonBattles = new Map<string, DungeonBattle>();
const BATTLE_TIMEOUT = 15 * 60 * 1000;

function getDungeonEnemy(floor: number) {
  const enemies = [
    { name: "Goblin", hp: 40, attack: 8, reward: 150, level: 1 },
    { name: "Goblin", hp: 62, attack: 12, reward: 250, level: 1 },
    { name: "Orc", hp: 90, attack: 18, reward: 400, level: 2 },
    { name: "Dark Knight", hp: 130, attack: 28, reward: 700, level: 3 },
    { name: "Shadow Wraith", hp: 180, attack: 38, reward: 1200, level: 4 },
    { name: "Demon Lord", hp: 250, attack: 52, reward: 2000, level: 5 },
  ];
  const idx = Math.min(floor - 1, enemies.length - 1);
  const base = { ...enemies[idx] };
  if (floor > enemies.length) {
    const scale = floor - enemies.length;
    base.hp += scale * 30;
    base.attack += scale * 6;
    base.reward += scale * 300;
    base.level += scale;
  }
  return base;
}

function getPlayerTitle(level: number): string {
  if (level >= 50) return "Legend";
  if (level >= 30) return "Champion";
  if (level >= 20) return "Knight";
  if (level >= 10) return "Warrior";
  if (level >= 5) return "Apprentice";
  return "Novice";
}

function makeHpBar(current: number, max: number, length = 10): string {
  const pct = max > 0 ? Math.max(0, current) / max : 0;
  const filled = Math.round(pct * length);
  const empty = length - filled;
  const bar = "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
  const color = pct > 0.6 ? "🟢" : pct > 0.2 ? "🟡" : "🔴";
  return `${color} ${bar}`;
}

function dungeonBattleDisplay(battle: DungeonBattle, rpgLevel: number, header?: string): string {
  const title = getPlayerTitle(rpgLevel);
  const healNote = battle.healCooldown > 0 ? ` (${battle.healCooldown}t CD)` : "";
  let msg = "";
  if (header) msg += `${header}\n\n`;
  msg +=
    `🏰 *DUNGEON FLOOR ${battle.floor}*  |  📊 Lv.${rpgLevel} ${title}\n` +
    `A wild *${battle.enemyName}* lurks! (Lv.${battle.enemyLevel})\n\n` +
    `⚔️ *You* ❤️ ${makeHpBar(battle.playerHp, battle.playerMaxHp)} \`${Math.max(0, battle.playerHp)}/${battle.playerMaxHp}\`\n` +
    `👾 *${battle.enemyName}* 💀 ${makeHpBar(battle.enemyHp, battle.enemyMaxHp)} \`${Math.max(0, battle.enemyHp)}/${battle.enemyMaxHp}\`\n\n` +
    `_Choose your move:_\n` +
    `⚔️ *.attack* - Standard strike\n` +
    `💥 *.heavy* - High-damage swing (65% hit)\n` +
    `🛡️ *.defend* - Block 60% of next attack\n` +
    `🌟 *.special* - Focus — deal 1.5x dmg\n` +
    `🧪 *.heal* - Recover 20% HP${healNote}\n` +
    `🎒 *.item* - Use a potion from inventory\n` +
    `🏃 *.flee* - Try to escape (45%)\n` +
    `🔍 *.explore* - Search for gold\n` +
    `🏕️ *.rest* - Recover a bit of HP`;
  return msg;
}

function calcDmg(base: number, multiplier: number): number {
  const variance = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.floor(base * multiplier * variance));
}

const RPG_GROUP_LINK = "https://chat.whatsapp.com/EaLPA8uKdr9F8TeH6Fvn9o";

export async function handleRpg(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, isAdmin, isOwner } = ctx;

  if (cmd === "rpg" && (args[0]?.toLowerCase() === "on" || args[0]?.toLowerCase() === "off")) {
    if (!isAdmin && !isOwner && !ctx.isBotAdmin) {
      await sendText(from, "❌ Only group admins can toggle RPG.");
      return;
    }
    const toggle = args[0].toLowerCase() as "on" | "off";
    updateGroup(from, { rpg_enabled: toggle });
    await sendText(from, `✅ RPG commands ${toggle === "on" ? "enabled" : "disabled"} for this group.`);
    return;
  }

  const group = from.endsWith("@g.us") ? getGroup(from) : null;
  if (group && (group.rpg_enabled || "on") === "off") {
    await sendText(from, `❌ RPG commands are unavailable in this group.\nWant to battle? Join ${RPG_GROUP_LINK}`);
    return;
  }

  const user = getUser(sender);
  // Canonical DB key — user.id (phone), not raw sender which may be @lid
  const userId = user?.id || sender.split("@")[0].split(":")[0];
  const rpg = ensureRpg(userId);
  const now = Math.floor(Date.now() / 1000);

  const DUNGEON_MOVES = ["attack", "heavy", "defend", "special", "item", "flee", "explore", "rest"];

  if (DUNGEON_MOVES.includes(cmd)) {
    const battle = activeDungeonBattles.get(sender);

    if (battle && Date.now() - battle.lastActivity > BATTLE_TIMEOUT) {
      activeDungeonBattles.delete(sender);
    }

    const currentBattle = activeDungeonBattles.get(sender);
    if (!currentBattle) {
      await sendText(from, "❌ You're not in an active dungeon battle. Use *.dungeon* to start one!");
      return;
    }

    if (currentBattle.groupId !== from) {
      await sendText(from, "❌ You can only continue your dungeon battle in the same group.");
      return;
    }

    currentBattle.lastActivity = Date.now();
    await processDungeonMove(ctx, currentBattle, rpg);
    return;
  }

  if (cmd === "skill") {
    const skillPts = rpg.skill_points || 0;
    if (!args[0]) {
      await sendText(from,
        `⚡ *Skill Points — ${getMentionName(sender)}*\n\n` +
        `📊 Available: *${skillPts} SP*\n\n` +
        `Current Stats:\n` +
        `⚔️ Attack: ${rpg.attack}  🛡️ Defense: ${rpg.defense}\n` +
        `💨 Speed: ${rpg.speed}  ❤️ Max HP: ${rpg.max_hp}\n\n` +
        `*Spend SP:*  _.skill [stat] [points]_\n` +
        `_Stats: attack, defense, speed, hp_\n` +
        `_e.g. .skill attack 5 → spends 5 SP, +10 ATK_\n\n` +
        `_Tip: You can also assign SP from the website!_`,
        [sender]
      );
      return;
    }
    const statMap: Record<string, string> = {
      attack: "attack", atk: "attack",
      defense: "defense", def: "defense",
      speed: "speed", spd: "speed",
      hp: "max_hp", health: "max_hp",
    };
    const statKey = statMap[args[0]?.toLowerCase()];
    if (!statKey) {
      await sendText(from, "❌ Unknown stat. Choose from: *attack*, *defense*, *speed*, *hp*");
      return;
    }
    const points = parseInt(args[1] || "1", 10);
    if (isNaN(points) || points < 1) {
      await sendText(from, "❌ Points must be a positive number.");
      return;
    }
    if (points > skillPts) {
      await sendText(from, `❌ Not enough skill points. You have *${skillPts} SP* available.`);
      return;
    }
    const gain = statKey === "max_hp" ? points * 5 : points * 2;
    const current = rpg[statKey] || 0;
    const updates: Record<string, number> = {
      skill_points: skillPts - points,
      [statKey]: current + gain,
    };
    if (statKey === "max_hp") {
      updates.hp = Math.min((rpg.hp || 1) + gain, current + gain);
    }
    updateRpg(sender, updates);
    const statLabel = statKey === "max_hp" ? "Max HP" : statKey.charAt(0).toUpperCase() + statKey.slice(1);
    await sendText(from,
      `✅ Spent *${points} SP* on *${statLabel}*!\n\n` +
      `${statKey === "max_hp" ? "❤️" : statKey === "attack" ? "⚔️" : statKey === "defense" ? "🛡️" : "💨"} ` +
      `${statLabel}: ${current} → ${current + gain} (+${gain})\n` +
      `⚡ Remaining SP: ${skillPts - points}`
    );
    return;
  }

  if (cmd === "rpg") {
    await sendText(from,
      `*RPG STATUS @${getMentionName(sender)}* ⚔️🌌\n\n` +
      `🏆 *Class*: ${rpg.class}\n` +
      `❤️ *HP*: ${rpg.hp}/${rpg.max_hp}\n\n` +
      `⚔️ *Attack*: ${rpg.attack}\n` +
      `🛡️ *Defense*: ${rpg.defense}\n\n` +
      `💨 *Speed*: ${rpg.speed}\n` +
      `🗡️ *Level*: ${rpg.level}\n\n` +
      `🌠 *XP*: ${rpg.xp}\n` +
      `⛓️*Dungeon Floor*: ${rpg.dungeon_floor}`,
      [sender]
    );
    return;
  }

  if (cmd === "class") {
    const newClass = args[0];
    if (!newClass) {
      await sendText(from, `🎭 *Available Classes:*\n\n${CLASSES.map((c) => {
        const s = CLASS_STATS[c];
        return `• *${c}* — HP:${s.hp} ATK:${s.attack} DEF:${s.defense} SPD:${s.speed}`;
      }).join("\n")}\n\nUsage: .class [name]`);
      return;
    }
    const cls = CLASSES.find((c) => c.toLowerCase() === newClass.toLowerCase());
    if (!cls) { await sendText(from, "❌ Invalid class."); return; }
    const stats = CLASS_STATS[cls];
    updateRpg(sender, { class: cls, hp: stats.hp, max_hp: stats.hp, attack: stats.attack, defense: stats.defense, speed: stats.speed });
    await sendText(from, `✅ Class changed to *${cls}*!\n❤️ HP: ${stats.hp} | ⚔️ ATK: ${stats.attack} | 🛡️ DEF: ${stats.defense} | 💨 SPD: ${stats.speed}`);
    return;
  }

  if (cmd === "adventure") {
    const cooldown = 3600;
    if (now - (rpg.last_adventure || 0) < cooldown) {
      await sendText(from, `⏳ Adventure cooldown: ${formatDuration(cooldown - (now - rpg.last_adventure))} left.`);
      return;
    }
    const adv = ADVENTURES[Math.floor(Math.random() * ADVENTURES.length)];
    const successChance = Math.min(0.9, 0.4 + (rpg.level * 0.1) - (adv.difficulty * 0.1));
    const success = Math.random() < successChance;
    if (success) {
      const reward = adv.reward + Math.floor(Math.random() * adv.reward * 0.5);
      const xp = adv.difficulty * 50;
      updateRpg(sender, { last_adventure: now, xp: rpg.xp + xp });
      updateUser(sender, { balance: (user?.balance || 0) + reward });
      checkLevelUp(sender, rpg.xp + xp, rpg.level);
      await sendText(from, `⚔️ *Adventure: ${adv.name}*\n\nYou battled the *${adv.enemy}* and won!\n+$${formatNumber(reward)} | +${xp} XP`);
    } else {
      const hpLost = Math.floor(rpg.max_hp * 0.3);
      updateRpg(sender, { hp: Math.max(1, rpg.hp - hpLost), last_adventure: now });
      await sendText(from, `❌ *Adventure: ${adv.name}*\n\nThe *${adv.enemy}* was too strong!\n-${hpLost} HP`);
    }
    return;
  }

  if (cmd === "heal") {
    const battle = activeDungeonBattles.get(sender);
    if (battle && battle.groupId === from) {
      battle.lastActivity = Date.now();
      await processDungeonMove(ctx, battle, rpg);
      return;
    }
    if (rpg.hp >= rpg.max_hp) {
      await sendText(from, "❤️ You're already at full HP!");
      return;
    }
    const cost = 200;
    if (!user || (user.balance || 0) < cost) {
      await sendText(from, `❌ Need $${cost} to heal. Use potions from your inventory instead.`);
      return;
    }
    updateUser(sender, { balance: (user.balance || 0) - cost });
    updateRpg(sender, { hp: rpg.max_hp });
    await sendText(from, `❤️ Healed to full HP (${rpg.max_hp}/${rpg.max_hp}) for $${cost}.`);
    return;
  }

  if (cmd === "quest") {
    const cooldown = 240;
    if (now - (rpg.last_quest || 0) < cooldown) {
      await sendText(from, `⏳ Quest cooldown: ${formatDuration(cooldown - (now - rpg.last_quest))} left.`);
      return;
    }
    const quest = QUESTS[Math.floor(Math.random() * QUESTS.length)];
    const success = Math.random() < 0.7;
    if (success) {
      updateRpg(sender, { last_quest: now, xp: rpg.xp + quest.xp });
      updateUser(sender, { balance: (user?.balance || 0) + quest.reward });
      checkLevelUp(sender, rpg.xp + quest.xp, rpg.level);
      await sendText(from, `📜 *Quest: ${quest.name}*\n\n✅ Quest complete!\n+$${formatNumber(quest.reward)} | +${quest.xp} XP`);
    } else {
      updateRpg(sender, { last_quest: now });
      await sendText(from, `📜 *Quest: ${quest.name}*\n\n❌ Quest failed. Better luck next time!`);
    }
    return;
  }

  if (cmd === "dungeon") {
    const existingBattle = activeDungeonBattles.get(sender);
    if (existingBattle) {
      if (Date.now() - existingBattle.lastActivity > BATTLE_TIMEOUT) {
        activeDungeonBattles.delete(sender);
      } else {
        await sendText(from, dungeonBattleDisplay(existingBattle, rpg.level));
        return;
      }
    }

    const cooldown = 360;
    if (now - (rpg.last_dungeon || 0) < cooldown) {
      await sendText(from, `⏳ Dungeon cooldown: ${formatDuration(cooldown - (now - rpg.last_dungeon))} left.`);
      return;
    }

    if (rpg.hp < Math.floor(rpg.max_hp * 0.2)) {
      await sendText(from, `❤️ You're too injured to enter the dungeon! HP: ${rpg.hp}/${rpg.max_hp}\n\nUse *.heal* or a potion first.`);
      return;
    }

    const floor = rpg.dungeon_floor;
    const enemy = getDungeonEnemy(floor);

    const battle: DungeonBattle = {
      groupId: from,
      floor,
      enemyName: enemy.name,
      enemyHp: enemy.hp,
      enemyMaxHp: enemy.hp,
      enemyAttack: enemy.attack,
      enemyLevel: enemy.level,
      enemyReward: enemy.reward,
      playerHp: rpg.hp,
      playerMaxHp: rpg.max_hp,
      playerAttack: rpg.attack,
      playerDefense: rpg.defense,
      healCooldown: 0,
      defendActive: false,
      lastActivity: Date.now(),
    };

    activeDungeonBattles.set(sender, battle);
    updateRpg(sender, { last_dungeon: now });
    await sendText(from, dungeonBattleDisplay(battle, rpg.level, `⚔️ *Entering Dungeon Floor ${floor}...*`));
    return;
  }

  if (cmd === "raid") {
    const cooldown = 21600;
    if (now - (rpg.last_raid || 0) < cooldown) {
      await sendText(from, `⏳ Raid cooldown: ${formatDuration(cooldown - (now - rpg.last_raid))} left.`);
      return;
    }
    const success = Math.random() < 0.5;
    if (success) {
      const reward = 2000 + Math.floor(Math.random() * 3000);
      const xp = 200;
      updateRpg(sender, { last_raid: now, xp: rpg.xp + xp });
      updateUser(sender, { balance: (user?.balance || 0) + reward });
      checkLevelUp(sender, rpg.xp + xp, rpg.level);
      await sendText(from, `⚔️ *Raid Complete!*\n\nYour party stormed the fortress!\n+$${formatNumber(reward)} | +${xp} XP`);
    } else {
      const hpLost = Math.floor(rpg.max_hp * 0.4);
      updateRpg(sender, { hp: Math.max(1, rpg.hp - hpLost), last_raid: now });
      await sendText(from, `⚔️ *Raid Failed!*\n\nThe enemy was too powerful.\n-${hpLost} HP`);
    }
    return;
  }
}

async function processDungeonMove(ctx: CommandContext, battle: DungeonBattle, rpg: any): Promise<void> {
  const { from, sender, command: cmd } = ctx;
  const user = getUser(sender);

  if (battle.healCooldown > 0) battle.healCooldown--;
  const wasDefending = battle.defendActive;
  battle.defendActive = false;

  let resultLines: string[] = [];
  let playerDmgDealt = 0;
  let enemyDmgTaken = 0;
  let ended = false;

  if (cmd === "attack") {
    playerDmgDealt = calcDmg(battle.playerAttack, 1.0);
    battle.enemyHp -= playerDmgDealt;
    resultLines.push(`⚔️ You struck *${battle.enemyName}* for *${playerDmgDealt} damage*!`);
  } else if (cmd === "heavy") {
    if (Math.random() < 0.65) {
      playerDmgDealt = calcDmg(battle.playerAttack, 1.8);
      battle.enemyHp -= playerDmgDealt;
      resultLines.push(`💥 *HEAVY HIT!* You smashed *${battle.enemyName}* for *${playerDmgDealt} damage*!`);
    } else {
      resultLines.push(`💥 You swung hard but *missed*! Off-balance...`);
      enemyDmgTaken = calcDmg(battle.enemyAttack, 1.5);
    }
  } else if (cmd === "defend") {
    playerDmgDealt = calcDmg(battle.playerAttack, 0.5);
    battle.enemyHp -= playerDmgDealt;
    battle.defendActive = true;
    resultLines.push(`🛡️ You defend and counter for *${playerDmgDealt} damage*! Blocking incoming attack...`);
  } else if (cmd === "special") {
    playerDmgDealt = calcDmg(battle.playerAttack, 1.5);
    battle.enemyHp -= playerDmgDealt;
    resultLines.push(`🌟 *Special attack!* You focused and dealt *${playerDmgDealt} damage*!`);
  } else if (cmd === "heal") {
    if (battle.healCooldown > 0) {
      await sendText(from, `🧪 Heal is on cooldown! (${battle.healCooldown} turns left)`);
      battle.healCooldown++;
      return;
    }
    const healAmt = Math.floor(battle.playerMaxHp * 0.2);
    battle.playerHp = Math.min(battle.playerMaxHp, battle.playerHp + healAmt);
    battle.healCooldown = 3;
    resultLines.push(`🧪 You recovered *${healAmt} HP*! (3-turn cooldown)`);
  } else if (cmd === "item") {
    const inv = getInventory(userId);
    const potion = inv.find((i: any) =>
      i.item.toLowerCase().includes("potion") || i.item.toLowerCase().includes("elixir")
    );
    if (!potion) {
      await sendText(from, "🎒 No potions in your inventory! Use *.buy Health Potion* in the shop.");
      return;
    }
    const healFull = potion.item.toLowerCase().includes("elixir");
    const healAmt = healFull ? battle.playerMaxHp - battle.playerHp : 50;
    battle.playerHp = Math.min(battle.playerMaxHp, battle.playerHp + healAmt);
    removeFromInventory(userId, potion.item);
    resultLines.push(`🎒 Used *${potion.item}* — recovered *${healAmt} HP*!`);
  } else if (cmd === "flee") {
    if (Math.random() < 0.45) {
      activeDungeonBattles.delete(sender);
      await sendText(from, "🏃 You fled from battle! No reward.\n\n_Use *.dungeon* to try again._");
      return;
    } else {
      resultLines.push("🏃 You tried to flee but *couldn't escape*!");
    }
  } else if (cmd === "explore") {
    const gold = 50 + Math.floor(Math.random() * 150);
    updateUser(sender, { balance: (user?.balance || 0) + gold });
    resultLines.push(`🔍 You found *$${formatNumber(gold)}* while exploring!`);
    enemyDmgTaken = calcDmg(battle.enemyAttack, 0.8);
  } else if (cmd === "rest") {
    const restHeal = Math.floor(battle.playerMaxHp * 0.05);
    battle.playerHp = Math.min(battle.playerMaxHp, battle.playerHp + restHeal);
    resultLines.push(`🏕️ You rested and recovered *${restHeal} HP*.`);
  }

  const doesEnemyAttack = cmd !== "item" && cmd !== "flee";
  if (doesEnemyAttack && battle.enemyHp > 0) {
    const incomingMult = battle.defendActive ? 0.4 : (cmd === "heavy" && resultLines[0].includes("missed")) ? 1.5 : 1.0;
    const dmg = enemyDmgTaken || calcDmg(battle.enemyAttack - Math.floor(battle.playerDefense * 0.3), incomingMult);
    battle.playerHp -= dmg;
    resultLines.push(`👾 *${battle.enemyName}* strikes back for *${dmg} damage*!`);
  }

  const rpgFresh = ensureRpg(userId);

  if (battle.enemyHp <= 0) {
    const xp = battle.floor * 80;
    const reward = battle.enemyReward;
    const newFloor = battle.floor + 1;
    const hpAfter = Math.max(1, battle.playerHp);
    const skillPts = Math.max(1, Math.floor(battle.floor / 2));
    updateRpg(sender, {
      dungeon_floor: newFloor,
      hp: hpAfter,
      xp: rpgFresh.xp + xp,
      skill_points: (rpgFresh.skill_points || 0) + skillPts,
    });
    updateUser(sender, { balance: (user?.balance || 0) + reward });
    addToInventory(userId, "Dungeon Key");
    checkLevelUp(sender, rpgFresh.xp + xp, rpgFresh.level);
    activeDungeonBattles.delete(sender);
    const victoryMsg =
      resultLines.join("\n") + "\n\n" +
      `🏆 *VICTORY!* You defeated *${battle.enemyName}*!\n\n` +
      `💰 Reward: $${formatNumber(reward)}\n` +
      `✨ XP: +${xp}\n` +
      `⚡ Skill Points: +${skillPts}\n` +
      `🗝️ Dungeon Key obtained!\n` +
      `🏰 Next floor: *Floor ${newFloor}*\n\n` +
      `_Use *.dungeon* to continue._`;
    await sendText(from, victoryMsg);
    return;
  }

  if (battle.playerHp <= 0) {
    updateRpg(sender, { hp: 1 });
    activeDungeonBattles.delete(sender);
    const defeatMsg =
      resultLines.join("\n") + "\n\n" +
      `💀 *DEFEATED!* You were overcome by *${battle.enemyName}*...\n\n` +
      `❤️ HP reduced to 1\n` +
      `🏰 Floor ${battle.floor} — better luck next time!\n\n` +
      `_Use *.heal* to recover then try *.dungeon* again._`;
    await sendText(from, defeatMsg);
    return;
  }

  updateRpg(sender, { hp: Math.max(1, battle.playerHp) });
  const header = resultLines.join("\n");
  await sendText(from, dungeonBattleDisplay(battle, rpgFresh.level, header));
}

function checkLevelUp(userId: string, xp: number, currentLevel: number) {
  const xpNeeded = currentLevel * 100;
  if (xp >= xpNeeded) {
    updateRpg(userId, { level: currentLevel + 1, xp: xp - xpNeeded });
  }
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
