import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { getDb } from "../db/database.js";
import { ensureUser, updateUser, getUser, getMentionName } from "../db/queries.js";
import { formatNumber, generateId } from "../utils.js";
import type { WASocket } from "@whiskeysockets/baileys";
const wcgJoinTimers = new Map<string, NodeJS.Timeout>();
const wcgWordTimers = new Map<string, NodeJS.Timeout>();

/** Normalize a JID or phone to plain digits for comparison */
function normalizePlayer(id: string): string {
  return id.split("@")[0].split(":")[0].replace(/\D/g, "") || id.split("@")[0].split(":")[0];
}

/** Check if two JIDs/phones refer to the same WhatsApp user */
function samePlayer(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return normalizePlayer(a) === normalizePlayer(b);
}

const WCG_START_WORDS = [
  "apple","banana","cat","dog","elephant","forest","guitar","house","island","jungle",
  "kite","lemon","mango","night","ocean","planet","queen","river","stone","tiger",
  "umbrella","violet","water","xerox","yellow","zebra",
];

// ── WCG time limit: starts at 60s, decreases by 5s every 3 rounds, minimum 10s ──
function getWcgTimeLimit(roundNumber: number): number {
  const reduction = Math.floor(roundNumber / 3) * 5;
  return Math.max(10, 60 - reduction);
}

async function startWcgGame(sock: WASocket, from: string, gameId: string, players: string[]): Promise<void> {
  const db = getDb();
  const startWord = WCG_START_WORDS[Math.floor(Math.random() * WCG_START_WORDS.length)];
  db.prepare("UPDATE word_chain SET status = 'active', last_word = ?, used_words = ?, current_player = 0, round_number = 0 WHERE id = ?")
    .run(startWord, JSON.stringify([startWord]), gameId);
  const playerTags = players.map((p) => `@${getMentionName(p)}`).join(", ");
  const timeLimit = getWcgTimeLimit(0);
  await sock.sendMessage(from, {
    text:
      `📝 *Word Chain Started!*\n\n` +
      `Players: ${playerTags}\n\n` +
      `First word: *${startWord}*\n` +
      `Next word must start with: *${startWord.slice(-1).toUpperCase()}*\n\n` +
      `@${getMentionName(players[0])}'s turn! ⏱️ ${timeLimit} seconds!`,
    mentions: players,
  });
  startWcgWordTimer(sock, from, gameId, players, 0, 0);
}

function startWcgWordTimer(sock: WASocket, from: string, gameId: string, players: string[], playerIdx: number, roundNumber: number): void {
  const db = getDb();
  const prev = wcgWordTimers.get(from);
  if (prev) clearTimeout(prev);
  const timeLimit = getWcgTimeLimit(roundNumber);
  const timer = setTimeout(async () => {
    wcgWordTimers.delete(from);
    const game = db.prepare("SELECT * FROM word_chain WHERE id = ? AND status = 'active'").get(gameId) as any;
    if (!game) return;
    const currentPlayers: string[] = JSON.parse(game.players);
    const timedOut = currentPlayers[game.current_player];
    if (!timedOut) return;
    currentPlayers.splice(game.current_player, 1);
    await sock.sendMessage(from, {
      text: `⏰ @${getMentionName(timedOut)} ran out of time and was *eliminated*!`,
      mentions: [timedOut],
    });
    if (currentPlayers.length <= 1) {
      db.prepare("UPDATE word_chain SET status = 'ended' WHERE id = ?").run(gameId);
      await sock.sendMessage(from, {
        text: `🏆 @${currentPlayers[0] ? getMentionName(currentPlayers[0]) : "Nobody"} wins Word Chain! 🎉`,
        mentions: currentPlayers,
      });
      return;
    }
    const nextIdx = game.current_player % currentPlayers.length;
    const nextRound = game.round_number + 1;
    const nextTimeLimit = getWcgTimeLimit(nextRound);
    db.prepare("UPDATE word_chain SET players = ?, current_player = ?, round_number = ? WHERE id = ?")
      .run(JSON.stringify(currentPlayers), nextIdx, nextRound, gameId);
    await sock.sendMessage(from, {
      text: `@${getMentionName(currentPlayers[nextIdx])}'s turn! Word must start with *${game.last_word.slice(-1).toUpperCase()}* — ⏱️ ${nextTimeLimit}s!`,
      mentions: [currentPlayers[nextIdx]],
    });
    startWcgWordTimer(sock, from, gameId, currentPlayers, nextIdx, nextRound);
  }, timeLimit * 1000);
  wcgWordTimers.set(from, timer);
}

function createTTTBoard(): string[][] {
  return [
    ["1","2","3"],["4","5","6"],["7","8","9"]
  ];
}

function renderTTT(board: string[][]): string {
  return board.map((row) => row.join(" | ")).join("\n---------\n");
}

function checkTTTWinner(b: string[][]): string | null {
  const lines = [
    [b[0][0],b[0][1],b[0][2]],[b[1][0],b[1][1],b[1][2]],[b[2][0],b[2][1],b[2][2]],
    [b[0][0],b[1][0],b[2][0]],[b[0][1],b[1][1],b[2][1]],[b[0][2],b[1][2],b[2][2]],
    [b[0][0],b[1][1],b[2][2]],[b[0][2],b[1][1],b[2][0]],
  ];
  for (const [a, bb, c] of lines) {
    if (a !== "1" && a !== "2" && a !== "3" && a !== "4" && a !== "5" && a !== "6" && a !== "7" && a !== "8" && a !== "9" && a === bb && bb === c) return a;
  }
  return null;
}

const UNO_COLORS = ["Red","Green","Blue","Yellow"];
const UNO_VALUES = ["0","1","2","3","4","5","6","7","8","9","Skip","Reverse","Draw2"];
const UNO_SPECIALS = ["Wild","Wild Draw4"];

function createUnoDeck(): string[] {
  const deck: string[] = [];
  for (const color of UNO_COLORS) {
    for (const val of UNO_VALUES) {
      deck.push(`${color} ${val}`);
      if (val !== "0") deck.push(`${color} ${val}`);
    }
  }
  for (const s of UNO_SPECIALS) {
    for (let i = 0; i < 4; i++) deck.push(s);
  }
  return shuffleArr(deck);
}

function shuffleArr<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Can a card be played on the current top card?
 * - topCard may have a forced wild_color (stored in game.wild_color).
 * - Wild Draw4 is only legal if the player has NO card matching the current color.
 *   (That check is enforced at play-time, not here.)
 */
function canPlayUno(card: string, topCard: string, wildColor: string): boolean {
  if (card.startsWith("Wild")) return true;
  const [cardColor, cardVal] = card.split(" ");
  // If wild was just played the effective color is wildColor
  const effectiveTopColor = wildColor || topCard.split(" ")[0];
  const topVal = topCard.split(" ")[1];
  return cardColor === effectiveTopColor || cardVal === topVal;
}

/** Point value of a card for scoring */
function unoCardPoints(card: string): number {
  if (card === "Wild" || card === "Wild Draw4") return 50;
  const val = card.split(" ")[1];
  if (val === "Skip" || val === "Reverse" || val === "Draw2") return 20;
  return parseInt(val, 10) || 0;
}

export async function handleGames(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, msg, sock, resolvedMentions } = ctx;
  const db = getDb();

  if (cmd === "tictactoe" || cmd === "ttt") {
    const challenged = resolvedMentions[0];
    if (!challenged) { await sendText(from, "❌ Mention someone to play! Usage: .ttt @user"); return; }
    if (challenged === sender) { await sendText(from, "❌ You can't play against yourself!"); return; }

    const existingGame = db.prepare("SELECT * FROM games WHERE group_id = ? AND type = 'ttt' AND status != 'ended'").get(from);
    if (existingGame) { await sendText(from, "❌ A game is already active. Use .stopgame to stop it."); return; }

    const board = createTTTBoard();
    const gameId = generateId(8);
    db.prepare(`
      INSERT INTO games (id, type, group_id, player1, player2, state, current_turn, status)
      VALUES (?, 'ttt', ?, ?, ?, ?, ?, 'active')
    `).run(gameId, from, sender, challenged, JSON.stringify(board), sender);

    await sock.sendMessage(from, {
      text: `⭕❌ *Tic Tac Toe*\n\n@${getMentionName(sender)} (❌) vs @${getMentionName(challenged)} (⭕)\n\n${renderTTT(board)}\n\n@${getMentionName(sender)}'s turn! Type 1-9 to place.`,
      mentions: [sender, challenged],
    });
    return;
  }

  if (cmd === "connectfour" || cmd === "c4") {
    const challenged = resolvedMentions[0];
    if (!challenged) { await sendText(from, "❌ Mention someone to play! Usage: .c4 @user"); return; }
    const board = Array.from({length:6}, () => Array(7).fill("⚫"));
    const gameId = generateId(8);
    db.prepare(`
      INSERT INTO games (id, type, group_id, player1, player2, state, current_turn, status)
      VALUES (?, 'c4', ?, ?, ?, ?, ?, 'active')
    `).run(gameId, from, sender, challenged, JSON.stringify(board), sender);

    const render = board.map((r) => r.join("")).join("\n") + "\n1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣";
    await sock.sendMessage(from, {
      text: `🔴🟡 *Connect Four*\n\n@${getMentionName(sender)} (🔴) vs @${getMentionName(challenged)} (🟡)\n\n${render}\n\n@${getMentionName(sender)}'s turn! Type 1-7 to drop.`,
      mentions: [sender, challenged],
    });
    return;
  }

  if (cmd === "stopgame") {
    const jt = wcgJoinTimers.get(from);
    if (jt) { clearTimeout(jt); wcgJoinTimers.delete(from); }
    const wt = wcgWordTimers.get(from);
    if (wt) { clearTimeout(wt); wcgWordTimers.delete(from); }
    const game = db.prepare("SELECT * FROM games WHERE group_id = ? AND status = 'active'").get(from) as any;
    if (!game) { await sendText(from, "❌ No active game."); return; }
    if (!ctx.isAdmin && !ctx.isOwner && game.player1 !== sender && game.player2 !== sender) {
      await sendText(from, "❌ Only admins or players can stop the game.");
      return;
    }
    db.prepare("UPDATE games SET status = 'ended' WHERE id = ?").run(game.id);
    await sendText(from, "✅ Game stopped.");
    return;
  }

  if (cmd === "truthordare" || cmd === "td") {
    const truths = [
      "What's the most embarrassing thing you've done?",
      "Who was your first crush?",
      "What's a secret you've never told anyone?",
      "What's the most childish thing you still do?",
      "What's your biggest fear?",
    ];
    const dares = [
      "Send a voice note singing a song!",
      "Change your status to something embarrassing for 1 hour!",
      "Send your most embarrassing photo!",
      "Text your crush right now!",
      "Do 10 push-ups and send proof!",
    ];
    const isTruth = Math.random() < 0.5;
    const list = isTruth ? truths : dares;
    const pick = list[Math.floor(Math.random() * list.length)];
    await sendText(from, `${isTruth ? "🤔 *TRUTH*" : "💥 *DARE*"}\n\n${pick}`);
    return;
  }

  if (cmd === "truth") {
    const truths = [
      "What's your biggest regret?","Have you ever lied to your best friend?",
      "What's something you've stolen?","Who do you have a crush on right now?","What's your darkest secret?",
    ];
    await sendText(from, `🤔 *Truth:*\n\n${truths[Math.floor(Math.random() * truths.length)]}`);
    return;
  }

  if (cmd === "dare") {
    const dares = [
      "Send a voice note of yourself saying a nursery rhyme!",
      "Change your profile picture for 1 hour!",
      "Tag 3 people and say something nice!",
      "Do a handstand and send a photo!",
      "Tell a joke right now!",
    ];
    await sendText(from, `💥 *Dare:*\n\n${dares[Math.floor(Math.random() * dares.length)]}`);
    return;
  }

  // ── UNO ──────────────────────────────────────────────────────────────────────
  if (cmd === "uno") {
    const existing = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'waiting'").get(from) as any;
    if (existing) {
      const players = JSON.parse(existing.players);
      if (!players.includes(sender)) {
        players.push(sender);
        db.prepare("UPDATE uno_games SET players = ? WHERE id = ?").run(JSON.stringify(players), existing.id);
        await sock.sendMessage(from, {
          text: `🃏 @${getMentionName(sender)} joined UNO! ${players.length} players. Type .startuno to start.`,
          mentions: [sender],
        });
      } else {
        await sendText(from, "❌ You're already in the game!");
      }
      return;
    }
    const gameId = generateId(8);
    db.prepare(`
      INSERT INTO uno_games (id, group_id, players, deck, discard, status)
      VALUES (?, ?, ?, '[]', '[]', 'waiting')
    `).run(gameId, from, JSON.stringify([sender]));
    await sock.sendMessage(from, {
      text: `🃏 *UNO* started! @${getMentionName(sender)} joined. Others type *.uno* to join!\nType *.startuno* when ready.`,
      mentions: [sender],
    });
    return;
  }

  if (cmd === "startuno") {
    const game = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'waiting'").get(from) as any;
    if (!game) { await sendText(from, "❌ No UNO game waiting. Use .uno to start one."); return; }
    const players: string[] = JSON.parse(game.players);
    if (players.length < 2) { await sendText(from, "❌ Need at least 2 players!"); return; }
    const deck = createUnoDeck();
    const hands: Record<string, string[]> = {};
    for (const p of players) {
      hands[p] = deck.splice(0, 7);
      db.prepare("INSERT OR REPLACE INTO uno_hands (game_id, user_id, cards) VALUES (?, ?, ?)")
        .run(game.id, p, JSON.stringify(hands[p]));
    }
    // Make sure the starting card is not a Wild Draw4
    let topCard = deck.splice(0, 1)[0];
    while (topCard === "Wild Draw4") {
      deck.push(topCard);
      shuffleArr(deck);
      topCard = deck.splice(0, 1)[0];
    }
    db.prepare("UPDATE uno_games SET deck = ?, discard = ?, status = 'active', wild_color = '', uno_called = '[]' WHERE id = ?")
      .run(JSON.stringify(deck), JSON.stringify([topCard]), game.id);

    const currentPlayer = players[0];
    await sock.sendMessage(from, {
      text: `🃏 *UNO Started!*\n\nPlayers: ${players.map((p) => `@${getMentionName(p)}`).join(", ")}\nTop card: *${topCard}*\n\n@${getMentionName(currentPlayer)}'s turn!\nType *.unohand* to see your cards.\nType *.unoplay [number]* to play a card.\nFor Wild cards: *.unoplay [number] [Red|Green|Blue|Yellow]*\nType *.unodraw* to draw a card.\nType *.unouno* when you're down to 2 cards!`,
      mentions: players,
    });
    return;
  }

  if (cmd === "unohand") {
    const game = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'active'").get(from) as any;
    if (!game) { await sendText(from, "❌ No active UNO game."); return; }
    const hand = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, sender) as any;
    if (!hand) { await sendText(from, "❌ You're not in this game."); return; }
    const cards: string[] = JSON.parse(hand.cards);
    const topCard = JSON.parse(game.discard).slice(-1)[0];
    const wildColor = game.wild_color || "";
    const effectiveTop = wildColor ? `${wildColor} (Wild)` : topCard;
    const text = `🃏 *Your UNO Hand* (${cards.length} cards)\n\n${cards.map((c, i) => `${i+1}. ${c}`).join("\n")}\n\nTop card: *${effectiveTop}*\n\n${wildColor ? `_Effective color: *${wildColor}*_` : ""}`;
    try {
      await sock.sendMessage(sender, { text });
      await sendText(from, "📬 Hand sent to your DM!");
    } catch {
      await sendText(from, text);
    }
    return;
  }

  if (cmd === "unouno") {
    // Player calls "UNO" when they have 2 cards (about to play down to 1)
    const game = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'active'").get(from) as any;
    if (!game) { await sendText(from, "❌ No active UNO game."); return; }
    const hand = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, sender) as any;
    if (!hand) { await sendText(from, "❌ You're not in this game."); return; }
    const cards: string[] = JSON.parse(hand.cards);
    if (cards.length !== 2) {
      await sendText(from, `❌ You can only call UNO when you have exactly 2 cards (you have ${cards.length}).`);
      return;
    }
    const unoCalled: string[] = JSON.parse(game.uno_called || "[]");
    if (unoCalled.includes(sender)) { await sendText(from, "✅ You already called UNO!"); return; }
    unoCalled.push(sender);
    db.prepare("UPDATE uno_games SET uno_called = ? WHERE id = ?").run(JSON.stringify(unoCalled), game.id);
    await sock.sendMessage(from, {
      text: `🃏 @${getMentionName(sender)} calls *UNO!* 🔔`,
      mentions: [sender],
    });
    return;
  }

  if (cmd === "unocatch") {
    // Catch a player who forgot to call UNO (they have 1 card and never called)
    const game = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'active'").get(from) as any;
    if (!game) { await sendText(from, "❌ No active UNO game."); return; }
    const players: string[] = JSON.parse(game.players);
    const unoCalled: string[] = JSON.parse(game.uno_called || "[]");
    // Find any player with 1 card who hasn't called UNO
    let caught = false;
    for (const p of players) {
      if (p === sender) continue;
      const pHand = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, p) as any;
      if (!pHand) continue;
      const pCards: string[] = JSON.parse(pHand.cards);
      if (pCards.length === 1 && !unoCalled.includes(p)) {
        // Penalty: draw 2
        const deck: string[] = JSON.parse(game.deck);
        const drawn = deck.splice(0, 2);
        pCards.push(...drawn);
        db.prepare("UPDATE uno_hands SET cards = ? WHERE game_id = ? AND user_id = ?").run(JSON.stringify(pCards), game.id, p);
        db.prepare("UPDATE uno_games SET deck = ? WHERE id = ?").run(JSON.stringify(deck), game.id);
        await sock.sendMessage(from, {
          text: `🚨 @${getMentionName(sender)} caught @${getMentionName(p)} forgetting to call UNO! @${getMentionName(p)} draws 2 cards as penalty! 😅`,
          mentions: [sender, p],
        });
        caught = true;
        break;
      }
    }
    if (!caught) await sendText(from, "❌ No one to catch right now!");
    return;
  }

  if (cmd === "unoplay") {
    const cardIdx = parseInt(args[0]) - 1;
    // Optional color argument for Wild cards
    const chosenColor = args[1]
      ? UNO_COLORS.find((c) => c.toLowerCase() === args[1].toLowerCase())
      : undefined;

    const game = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'active'").get(from) as any;
    if (!game) { await sendText(from, "❌ No active UNO game."); return; }
    const players: string[] = JSON.parse(game.players);
    const currentPlayer = players[game.current_player];
    if (!samePlayer(currentPlayer, sender)) { await sendText(from, "❌ It's not your turn!"); return; }
    const handRow = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, sender) as any;
    const hand: string[] = JSON.parse(handRow.cards);
    if (isNaN(cardIdx) || cardIdx < 0 || cardIdx >= hand.length) {
      await sendText(from, `❌ Invalid card number. You have ${hand.length} cards.`);
      return;
    }
    const card = hand[cardIdx];
    const discard: string[] = JSON.parse(game.discard);
    const topCard = discard[discard.length - 1];
    const wildColor: string = game.wild_color || "";

    // Wild Draw4 legality: can only play if you have NO card matching the effective color
    if (card === "Wild Draw4") {
      const effectiveColor = wildColor || topCard.split(" ")[0];
      const hasMatchingColor = hand.some((c, i) => i !== cardIdx && !c.startsWith("Wild") && c.split(" ")[0] === effectiveColor);
      if (hasMatchingColor) {
        await sendText(from, `❌ You can only play *Wild Draw4* if you have no cards matching the current color (*${effectiveColor}*). Play a different card!`);
        return;
      }
    }

    if (!canPlayUno(card, topCard, wildColor)) {
      const effectiveTop = wildColor ? `${wildColor} (Wild)` : topCard;
      await sendText(from, `❌ Can't play *${card}* on *${effectiveTop}*!`);
      return;
    }

    // Wild cards require a color
    if (card.startsWith("Wild")) {
      if (!chosenColor) {
        await sendText(from, `🌈 *${card}* is a Wild card!\n\nChoose a color:\n*.unoplay ${cardIdx + 1} Red*\n*.unoplay ${cardIdx + 1} Green*\n*.unoplay ${cardIdx + 1} Blue*\n*.unoplay ${cardIdx + 1} Yellow*`);
        return;
      }
    }

    hand.splice(cardIdx, 1);
    discard.push(card);
    db.prepare("UPDATE uno_hands SET cards = ? WHERE game_id = ? AND user_id = ?").run(JSON.stringify(hand), game.id, sender);

    // Clear UNO-called status for this player now they played (they need 1 card to win)
    const unoCalled: string[] = JSON.parse(game.uno_called || "[]");
    const newUnoCalled = unoCalled.filter((p) => p !== sender);

    // Announce UNO automatically when player reaches 1 card (if they forgot to call)
    if (hand.length === 1 && !unoCalled.includes(sender)) {
      // They'll need to survive a potential catch attempt — no auto-penalty, just no announcement
    }
    if (hand.length === 1 && unoCalled.includes(sender)) {
      await sock.sendMessage(from, {
        text: `🃏 @${getMentionName(sender)} has *1 card left!* 🔔 UNO!`,
        mentions: [sender],
      });
    }

    if (hand.length === 0) {
      // Calculate scores from remaining hands
      let totalPoints = 0;
      for (const p of players) {
        if (samePlayer(p, sender)) continue;
        const pHand = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, p) as any;
        if (pHand) {
          const pCards: string[] = JSON.parse(pHand.cards);
          totalPoints += pCards.reduce((sum, c) => sum + unoCardPoints(c), 0);
        }
      }
      db.prepare("UPDATE uno_games SET status = 'ended' WHERE id = ?").run(game.id);
      await sock.sendMessage(from, {
        text: `🎉 @${getMentionName(sender)} played *${card}* and *WON UNO*! 🏆\n\n*Round Points: ${totalPoints}*\n_(First to 500 points wins the game)_`,
        mentions: [sender],
      });
      return;
    }

    // Compute next player index
    let direction: number = game.direction;
    let newWildColor = card.startsWith("Wild") ? (chosenColor || "") : "";
    let nextPlayer = (game.current_player + direction + players.length) % players.length;

    if (card.includes("Skip")) {
      // 2-player: skip acts like an extra turn for current player; otherwise skip next
      if (players.length === 2) {
        nextPlayer = game.current_player; // current player goes again
      } else {
        nextPlayer = (nextPlayer + direction + players.length) % players.length;
      }
    }

    if (card.includes("Reverse")) {
      if (players.length === 2) {
        // 2-player: Reverse acts like Skip — current player goes again
        direction = game.direction; // direction unchanged
        nextPlayer = game.current_player;
      } else {
        direction = -game.direction;
        nextPlayer = (game.current_player + direction + players.length) % players.length;
      }
    }

    if (card.includes("Draw2")) {
      const nextHand = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, players[nextPlayer]) as any;
      if (nextHand) {
        const deck: string[] = JSON.parse(game.deck);
        const drawn = deck.splice(0, 2);
        const nh: string[] = JSON.parse(nextHand.cards);
        nh.push(...drawn);
        db.prepare("UPDATE uno_hands SET cards = ? WHERE game_id = ? AND user_id = ?").run(JSON.stringify(nh), game.id, players[nextPlayer]);
        db.prepare("UPDATE uno_games SET deck = ? WHERE id = ?").run(JSON.stringify(deck), game.id);
      }
      nextPlayer = (nextPlayer + direction + players.length) % players.length;
    }

    if (card === "Wild Draw4") {
      const nextHand = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, players[nextPlayer]) as any;
      if (nextHand) {
        const deck: string[] = JSON.parse(game.deck);
        const drawn = deck.splice(0, 4);
        const nh: string[] = JSON.parse(nextHand.cards);
        nh.push(...drawn);
        db.prepare("UPDATE uno_hands SET cards = ? WHERE game_id = ? AND user_id = ?").run(JSON.stringify(nh), game.id, players[nextPlayer]);
        db.prepare("UPDATE uno_games SET deck = ? WHERE id = ?").run(JSON.stringify(deck), game.id);
      }
      nextPlayer = (nextPlayer + direction + players.length) % players.length;
    }

    db.prepare("UPDATE uno_games SET discard = ?, current_player = ?, direction = ?, wild_color = ?, uno_called = ? WHERE id = ?")
      .run(JSON.stringify(discard), nextPlayer, direction, newWildColor, JSON.stringify(newUnoCalled), game.id);

    const effectiveColor = newWildColor ? ` → *${newWildColor}*` : "";
    await sock.sendMessage(from, {
      text: `🃏 @${getMentionName(sender)} played *${card}*!${effectiveColor}\nTop: ${card}${newWildColor ? ` (${newWildColor})` : ""}\n\n@${getMentionName(players[nextPlayer])}'s turn! (${hand.length} cards left for @${getMentionName(sender)})`,
      mentions: [sender, players[nextPlayer]],
    });
    return;
  }

  if (cmd === "unodraw") {
    const game = db.prepare("SELECT * FROM uno_games WHERE group_id = ? AND status = 'active'").get(from) as any;
    if (!game) { await sendText(from, "❌ No active UNO game."); return; }
    const players: string[] = JSON.parse(game.players);
    if (!samePlayer(players[game.current_player], sender)) { await sendText(from, "❌ Not your turn!"); return; }
    const deck: string[] = JSON.parse(game.deck);
    if (deck.length === 0) { await sendText(from, "❌ Deck is empty!"); return; }
    const drawn = deck.splice(0, 1)[0];
    const handRow = db.prepare("SELECT * FROM uno_hands WHERE game_id = ? AND user_id = ?").get(game.id, sender) as any;
    const hand: string[] = JSON.parse(handRow.cards);
    hand.push(drawn);
    db.prepare("UPDATE uno_hands SET cards = ? WHERE game_id = ? AND user_id = ?").run(JSON.stringify(hand), game.id, sender);
    db.prepare("UPDATE uno_games SET deck = ? WHERE id = ?").run(JSON.stringify(deck), game.id);

    // If the drawn card can be played immediately, play it
    const discard: string[] = JSON.parse(game.discard);
    const topCard = discard[discard.length - 1];
    const wildColor: string = game.wild_color || "";
    const canPlay = canPlayUno(drawn, topCard, wildColor);

    if (canPlay) {
      await sock.sendMessage(from, {
        text: `🃏 @${getMentionName(sender)} drew *${drawn}* — and it can be played!\nType *.unoplay ${hand.length}* to play it, or pass your turn.`,
        mentions: [sender],
      });
      // Don't advance turn yet — player gets to decide
      return;
    }

    const nextPlayer = (game.current_player + game.direction + players.length) % players.length;
    db.prepare("UPDATE uno_games SET current_player = ? WHERE id = ?").run(nextPlayer, game.id);
    await sock.sendMessage(from, {
      text: `🃏 @${getMentionName(sender)} drew a card (no playable card — turn skipped).\n@${getMentionName(players[nextPlayer])}'s turn!`,
      mentions: [sender, players[nextPlayer]],
    });
    return;
  }

  // ── Word Chain ────────────────────────────────────────────────────────────────
  if (cmd === "wordchain" || cmd === "wcg") {
    const sub = args[0]?.toLowerCase();
    if (sub === "start") {
      const existing = db.prepare("SELECT * FROM word_chain WHERE group_id = ? AND status != 'ended'").get(from) as any;
      if (existing) { await sendText(from, "❌ A Word Chain game is already active. Use .stopgame to cancel."); return; }
      const gameId = generateId(8);
      const joinDeadline = Math.floor(Date.now() / 1000) + 20;
      db.prepare(`INSERT INTO word_chain (id, group_id, players, status, join_deadline, round_number) VALUES (?, ?, ?, 'waiting', ?, 0)`)
        .run(gameId, from, JSON.stringify([sender]), joinDeadline);
      await sock.sendMessage(from, {
        text: `📝 *Word Chain Game!*\n\n@${getMentionName(sender)} started a game!\nType *.joinwcg* to join (20 seconds)\nType *.wcg go* to start early\n\n_Max 5 players. Auto-starts in 20s!_\n\n⏱️ Time starts at 60s and gets faster each round!`,
        mentions: [sender],
      });
      // Auto-start after 20 seconds
      const joinTimer = setTimeout(async () => {
        wcgJoinTimers.delete(from);
        const game = db.prepare("SELECT * FROM word_chain WHERE id = ? AND status = 'waiting'").get(gameId) as any;
        if (!game) return;
        const players: string[] = JSON.parse(game.players);
        if (players.length < 2) {
          db.prepare("UPDATE word_chain SET status = 'ended' WHERE id = ?").run(gameId);
          await sendText(from, "❌ Word Chain cancelled — not enough players joined (need 2+).");
          return;
        }
        await startWcgGame(sock, from, gameId, players);
      }, 20000);
      wcgJoinTimers.set(from, joinTimer);
      return;
    }
    if (sub === "go") {
      const game = db.prepare("SELECT * FROM word_chain WHERE group_id = ? AND status = 'waiting'").get(from) as any;
      if (!game) { await sendText(from, "❌ No waiting Word Chain game."); return; }
      const players: string[] = JSON.parse(game.players);
      if (players.length < 2) { await sendText(from, "❌ Need at least 2 players to start!"); return; }
      const joinTimer = wcgJoinTimers.get(from);
      if (joinTimer) { clearTimeout(joinTimer); wcgJoinTimers.delete(from); }
      await startWcgGame(sock, from, game.id, players);
      return;
    }
    await sendText(from, "📝 *Word Chain (WCG)*\n\n.wcg start — Start a new game\n.joinwcg — Join a game\n.wcg go — Force start early\n\nEach player must say the next word before time runs out.\n⏱️ Time limit starts at 60s and *decreases* each round!\nWrong word or timeout = eliminated!\nLast player standing wins! 🏆");
    return;
  }

  if (cmd === "joinwcg") {
    const game = db.prepare("SELECT * FROM word_chain WHERE group_id = ? AND status = 'waiting'").get(from) as any;
    if (!game) { await sendText(from, "❌ No waiting Word Chain game. Use .wcg start to begin one."); return; }
    const players: string[] = JSON.parse(game.players);
    if (players.length >= 5) { await sendText(from, "❌ Game is full (max 5 players)."); return; }
    if (players.includes(sender)) { await sendText(from, "❌ You're already in!"); return; }
    players.push(sender);
    db.prepare("UPDATE word_chain SET players = ? WHERE id = ?").run(JSON.stringify(players), game.id);
    await sock.sendMessage(from, {
      text: `✅ @${getMentionName(sender)} joined Word Chain! (${players.length}/5 players)`,
      mentions: [sender],
    });
    return;
  }

  if (cmd === "startbattle") {
    const challenged = resolvedMentions[0];
    if (!challenged) { await sendText(from, "❌ Mention someone to battle!"); return; }
    const { ensureRpg } = await import("../db/queries.js");
    const p1 = ensureRpg(sender);
    const p2 = ensureRpg(challenged);
    const damage = (atk: number, def: number) => Math.max(1, atk - Math.floor(def * 0.5) + Math.floor(Math.random() * 20) - 10);
    let p1hp = p1.hp, p2hp = p2.hp;
    let log = `⚔️ *Battle!*\n@${getMentionName(sender)} (HP:${p1hp}) vs @${getMentionName(challenged)} (HP:${p2hp})\n\n`;
    let round = 0;
    while (p1hp > 0 && p2hp > 0 && round < 20) {
      round++;
      const d1 = damage(p1.attack, p2.defense);
      const d2 = damage(p2.attack, p1.defense);
      p2hp -= d1; p1hp -= d2;
      log += `R${round}: @${getMentionName(sender)} dealt ${d1} dmg | @${getMentionName(challenged)} dealt ${d2} dmg\n`;
      if (round >= 5) break;
    }
    const winner = p1hp > p2hp ? sender : p2hp > p1hp ? challenged : null;
    log += `\n${winner ? `🏆 @${getMentionName(winner)} wins!` : "🤝 Draw!"}`;
    await sock.sendMessage(from, { text: log, mentions: [sender, challenged] });
    return;
  }
}

export async function handleGameInput(ctx: CommandContext, text: string): Promise<boolean> {
  const { from, sender, sock } = ctx;
  const db = getDb();

  // ── TTT input ──────────────────────────────────────────────────────────────
  const tttGame = db.prepare("SELECT * FROM games WHERE group_id = ? AND type = 'ttt' AND status = 'active'").get(from) as any;
  if (tttGame) {
    const num = parseInt(text.trim());
    if (!isNaN(num) && num >= 1 && num <= 9 && samePlayer(tttGame.current_turn, sender)) {
      const board: string[][] = JSON.parse(tttGame.state);
      const piece = samePlayer(tttGame.player1, sender) ? "❌" : "⭕";
      let placed = false;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          if (board[r][c] === String(num)) { board[r][c] = piece; placed = true; break; }
        }
        if (placed) break;
      }
      if (!placed) return false;
      const winner = checkTTTWinner(board);
      const nextTurn = samePlayer(tttGame.current_turn, tttGame.player1) ? tttGame.player2 : tttGame.player1;
      const flat = board.flat();
      const isDraw = !winner && !flat.some((v) => !["❌","⭕"].includes(v));
      if (winner) {
        db.prepare("UPDATE games SET status = 'ended' WHERE id = ?").run(tttGame.id);
        await sock.sendMessage(from, { text: `${renderTTT(board)}\n\n🏆 @${getMentionName(sender)} wins!`, mentions: [sender] });
      } else if (isDraw) {
        db.prepare("UPDATE games SET status = 'ended' WHERE id = ?").run(tttGame.id);
        await sendText(from, `${renderTTT(board)}\n\n🤝 It's a draw!`);
      } else {
        db.prepare("UPDATE games SET state = ?, current_turn = ? WHERE id = ?").run(JSON.stringify(board), nextTurn, tttGame.id);
        await sock.sendMessage(from, { text: `${renderTTT(board)}\n\n@${getMentionName(nextTurn)}'s turn!`, mentions: [nextTurn] });
      }
      return true;
    }
  }

  // ── Connect Four input ─────────────────────────────────────────────────────
  const c4Game = db.prepare("SELECT * FROM games WHERE group_id = ? AND type = 'c4' AND status = 'active'").get(from) as any;
  if (c4Game) {
    const col = parseInt(text.trim()) - 1;   // 1-7 → 0-6
    if (!isNaN(col) && col >= 0 && col <= 6 && samePlayer(c4Game.current_turn, sender)) {
      const board: string[][] = JSON.parse(c4Game.state);
      const piece = samePlayer(c4Game.player1, sender) ? "🔴" : "🟡";

      // Drop piece to lowest empty row in the chosen column
      let row = -1;
      for (let r = 5; r >= 0; r--) {
        if (board[r][col] === "⚫") { row = r; break; }
      }
      if (row === -1) {
        await sendText(from, `❌ Column ${col + 1} is full! Choose another (1-7).`);
        return true;
      }

      board[row][col] = piece;
      const render = board.map((r) => r.join("")).join("\n") + "\n1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣";

      if (checkC4Winner(board, piece)) {
        db.prepare("UPDATE games SET status = 'ended' WHERE id = ?").run(c4Game.id);
        await sock.sendMessage(from, {
          text: `${render}\n\n🏆 @${getMentionName(sender)} wins Connect Four! 🎉`,
          mentions: [sender],
        });
        return true;
      }

      const isFull = board[0].every((cell) => cell !== "⚫");
      if (isFull) {
        db.prepare("UPDATE games SET status = 'ended' WHERE id = ?").run(c4Game.id);
        await sendText(from, `${render}\n\n🤝 It's a draw!`);
        return true;
      }

      const nextTurn = samePlayer(c4Game.current_turn, c4Game.player1) ? c4Game.player2 : c4Game.player1;
      const nextPiece = samePlayer(nextTurn, c4Game.player1) ? "🔴" : "🟡";
      db.prepare("UPDATE games SET state = ?, current_turn = ? WHERE id = ?").run(JSON.stringify(board), nextTurn, c4Game.id);
      await sock.sendMessage(from, {
        text: `${render}\n\n${nextPiece} @${getMentionName(nextTurn)}'s turn! Type 1-7 to drop.`,
        mentions: [nextTurn],
      });
      return true;
    }
  }

  // ── Word Chain input ───────────────────────────────────────────────────────
  const wcgGame = db.prepare("SELECT * FROM word_chain WHERE group_id = ? AND status = 'active'").get(from) as any;
  if (wcgGame && /^[a-zA-Z]+$/.test(text.trim())) {
    const word = text.trim().toLowerCase();
    const players: string[] = JSON.parse(wcgGame.players);
    const currentPlayer = players[wcgGame.current_player];
    if (currentPlayer !== sender) return false;
    const lastWord: string = wcgGame.last_word;
    const usedWords: string[] = JSON.parse(wcgGame.used_words);
    const roundNumber: number = wcgGame.round_number || 0;

    // Wrong starting letter — give warning but DON'T eliminate immediately.
    // Player must answer correctly within the remaining time frame.
    // Only a timeout eliminates them.
    if (word[0] !== lastWord.slice(-1).toLowerCase()) {
      await sock.sendMessage(from, {
        text: `⚠️ @${getMentionName(sender)} — *${word}* doesn't start with *${lastWord.slice(-1).toUpperCase()}*! Try again before time runs out!`,
        mentions: [sender],
      });
      return true; // consumed the message but did NOT eliminate
    }

    // Word already used — same grace: warn, don't eliminate mid-timer
    if (usedWords.includes(word)) {
      await sock.sendMessage(from, {
        text: `⚠️ @${getMentionName(sender)} — *${word}* was already used! Try a different word before time runs out!`,
        mentions: [sender],
      });
      return true;
    }

    // Real-word check via free dictionary API (3-second timeout, allow on failure)
    // Wrong/fake word: warn but don't eliminate — only the timer eliminates
    const wordIsReal = await isRealWord(word);
    if (!wordIsReal) {
      await sock.sendMessage(from, {
        text: `⚠️ @${getMentionName(sender)} — *${word}* doesn't seem to be a real English word! Try again before time runs out!`,
        mentions: [sender],
      });
      return true;
    }

    // ✅ Valid word — clear timer, advance turn
    const timer = wcgWordTimers.get(from);
    if (timer) { clearTimeout(timer); wcgWordTimers.delete(from); }
    usedWords.push(word);
    const nextIdx = (wcgGame.current_player + 1) % players.length;
    const nextRound = roundNumber + 1;
    const nextTimeLimit = getWcgTimeLimit(nextRound);
    db.prepare("UPDATE word_chain SET last_word = ?, used_words = ?, current_player = ?, round_number = ? WHERE id = ?")
      .run(word, JSON.stringify(usedWords), nextIdx, nextRound, wcgGame.id);
    await sock.sendMessage(from, {
      text: `✅ @${getMentionName(sender)} said *${word}*!\nNext: @${getMentionName(players[nextIdx])} — must start with *${word.slice(-1).toUpperCase()}* ⏱️ ${nextTimeLimit}s`,
      mentions: [sender, players[nextIdx]],
    });
    startWcgWordTimer(sock, from, wcgGame.id, players, nextIdx, nextRound);
    return true;
  }

  return false;
}

/** Free dictionary API word check — allows word on network failure */
async function isRealWord(word: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return true; // Don't penalise players when API is unreachable
  }
}

/** Check if a Connect Four piece has won */
function checkC4Winner(board: string[][], piece: string): boolean {
  const R = 6, C = 7;
  for (let r = 0; r < R; r++)
    for (let c = 0; c <= C - 4; c++)
      if ([0,1,2,3].every((d) => board[r][c+d] === piece)) return true;
  for (let c = 0; c < C; c++)
    for (let r = 0; r <= R - 4; r++)
      if ([0,1,2,3].every((d) => board[r+d][c] === piece)) return true;
  for (let r = 0; r <= R - 4; r++)
    for (let c = 0; c <= C - 4; c++)
      if ([0,1,2,3].every((d) => board[r+d][c+d] === piece)) return true;
  for (let r = 0; r <= R - 4; r++)
    for (let c = 3; c < C; c++)
      if ([0,1,2,3].every((d) => board[r+d][c-d] === piece)) return true;
  return false;
}
