import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { logger } from "../../lib/logger.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const DEFAULT_STICKER_NAME = "𝐓𝐄𝐍𝐊𝐔 反逆";
const DEFAULT_STICKER_PACK = "Atomic";

export async function handleConverter(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, msg, sock } = ctx;

  if (cmd === "sticker" || cmd === "s") {
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = context?.quotedMessage;
    const hasQuotedImage = !!(quotedMsg?.imageMessage || quotedMsg?.stickerMessage);
    const hasQuotedVideo = !!(quotedMsg?.videoMessage);
    const hasDirect = !!(msg.message?.imageMessage || msg.message?.videoMessage);

    if (!hasQuotedImage && !hasQuotedVideo && !hasDirect) {
      await sendText(from, "❌ Reply to an image or video, or send media with .s caption.");
      return;
    }

    try {
      const isVideo = !!(hasQuotedVideo || msg.message?.videoMessage);
      let target: any;
      if (hasQuotedImage || hasQuotedVideo) {
        target = {
          key: {
            remoteJid: from,
            fromMe: false,
            id: context?.stanzaId || "",
            participant: context?.participant,
          },
          message: quotedMsg,
        };
      } else {
        target = msg;
      }

      const downloaded = await downloadMediaMessage(target as any, "buffer", {}, { reuploadRequest: (sock as any).updateMediaMessage } as any);
      const input = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
      let webp: Buffer;

      if (quotedMsg?.stickerMessage && !isVideo) {
        webp = input;
      } else if (isVideo) {
        webp = await convertVideoToStickerWebp(input);
      } else {
        webp = await convertToStickerWebp(input);
      }

      const stickerDisplayName = quotedMsg?.stickerMessage
        ? (ctx.msg.pushName || sender.split("@")[0])
        : DEFAULT_STICKER_NAME;
      const buf = addWebpExif(webp, DEFAULT_STICKER_PACK, stickerDisplayName);
      await sock.sendMessage(from, {
        sticker: buf,
        mimetype: "image/webp",
      });
    } catch (err) {
      logger.error({ err }, "Failed to create sticker");
      await sendText(from, "❌ Failed to create sticker.");
    }
    return;
  }

  if (cmd === "speech") {
    const text = args.join(" ");
    if (!text) {
      await sendText(from, "❌ Usage: .speech [text] — reply to a sticker or image");
      return;
    }
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = context?.quotedMessage;
    if (!quotedMsg?.stickerMessage && !quotedMsg?.imageMessage) {
      await sendText(from, "❌ Reply to a sticker or image with .speech [text]");
      return;
    }
    try {
      const target = {
        key: {
          remoteJid: from,
          fromMe: false,
          id: context?.stanzaId || "",
          participant: context?.participant,
        },
        message: quotedMsg,
      };
      const downloaded = await downloadMediaMessage(target as any, "buffer", {}, { reuploadRequest: (sock as any).updateMediaMessage } as any);
      const input = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
      const imgBuf = await sharp(input).png().toBuffer();
      const meta = await sharp(imgBuf).metadata();
      const w = meta.width || 512;
      const h = meta.height || 512;
      const fontSize = Math.max(18, Math.floor(w / 18));
      const barH = Math.max(48, Math.floor(h * 0.20));
      const displayText = text.length > 55 ? text.substring(0, 52) + "..." : text;
      const escapedText = displayText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${barH}">
        <rect width="${w}" height="${barH}" rx="0" fill="rgba(0,0,0,0.72)"/>
        <text x="${w / 2}" y="${barH / 2}" dominant-baseline="middle" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" fill="white" font-weight="bold">
          ${escapedText}
        </text>
      </svg>`;
      const result = await sharp(imgBuf)
        .composite([{ input: Buffer.from(svg), gravity: "south" }])
        .jpeg({ quality: 88 })
        .toBuffer();
      await sock.sendMessage(from, { image: result, caption: `💬 "${text}"` });
    } catch (err) {
      logger.error({ err }, "Speech command failed");
      await sendText(from, "❌ Failed to create speech bubble.");
    }
    return;
  }

  if (cmd === "toimg" || cmd === "turnimg") {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.stickerMessage) {
      await sendText(from, "❌ Reply to a sticker with .toimg to convert it.");
      return;
    }
    try {
      const target = {
        key: {
          remoteJid: from,
          fromMe: false,
          id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || "",
          participant: msg.message?.extendedTextMessage?.contextInfo?.participant,
        },
        message: quoted,
      };
      const downloaded = await downloadMediaMessage(target as any, "buffer", {}, { reuploadRequest: (sock as any).updateMediaMessage } as any);
      const buf = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
      await sock.sendMessage(from, { image: buf, caption: "Here's your image! 🖼️" });
    } catch {
      await sendText(from, "❌ Failed to convert sticker.");
    }
    return;
  }

  if (cmd === "take") {
    const parts = args.join(" ").split(",").map((s) => s.trim());
    const packName = parts[0] || DEFAULT_STICKER_PACK;
    const stickerName = parts[1] || DEFAULT_STICKER_NAME;
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.stickerMessage) {
      await sendText(from, "❌ Reply to a sticker with .take <pack>, <name>");
      return;
    }
    try {
      const context = msg.message?.extendedTextMessage?.contextInfo;
      const target = {
        key: {
          remoteJid: from,
          fromMe: false,
          id: context?.stanzaId || "",
          participant: context?.participant,
        },
        message: quoted,
      };
      const downloaded = await downloadMediaMessage(target as any, "buffer", {}, { reuploadRequest: (sock as any).updateMediaMessage } as any);
      const input = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
      const renamed = addWebpExif(input, packName, stickerName);
      await sock.sendMessage(from, {
        sticker: renamed,
        mimetype: "image/webp",
      } as any);
    } catch (err) {
      logger.error({ err }, "Failed to rename sticker");
      await sendText(from, "❌ Failed to rename sticker.");
    }
    return;
  }

  if (cmd === "mood") {
    const tag = args[0];
    if (!tag) { await sendText(from, "❌ Usage: .mood <tag>"); return; }
    await sendText(from, `🎭 Mood sticker for "#${tag}" — Mood sticker feature coming soon!`);
    return;
  }

  if (cmd === "pintimg") {
    const query = args.join(" ");
    if (!query) { await sendText(from, "❌ Usage: .pintimg <query>"); return; }
    await sendText(from, `🖼️ Pinterest search for "${query}" — Image search feature coming soon!`);
    return;
  }

  if (cmd === "play") {
    const song = args.join(" ");
    if (!song) { await sendText(from, "❌ Usage: .play <song name>"); return; }
    await sendText(from, `🔎 Searching YouTube for: *${song}*`);
    try {
      const play = await import("play-dl");
      const results = await play.search(song, { limit: 1 });
      const video = results[0];
      if (!video?.url) {
        await sendText(from, "❌ Song not found on YouTube.");
        return;
      }
      const title = video.title || song;
      const duration = video.durationRaw || "Unknown";
      const channel = video.channel?.name || "Unknown channel";
      const thumbnail = video.thumbnails?.[0]?.url;
      const info = `🎵 *${title}*\n\n👤 Channel: ${channel}\n⏱️ Duration: ${duration}\n🔗 ${video.url}\n\n⬇️ Converting to audio...`;
      if (thumbnail) {
        await sock.sendMessage(from, { image: { url: thumbnail }, caption: info });
      } else {
        await sendText(from, info);
      }
      let mp3: Buffer;
      try {
        const streamInfo = await play.stream(video.url, { quality: 2 });
        const sourceBuffer = await readStream(streamInfo.stream as any);
        mp3 = await convertToMp3(sourceBuffer);
      } catch (streamErr) {
        logger.warn({ err: streamErr, url: video.url }, "play-dl stream failed; trying yt-dlp fallback");
        mp3 = await downloadAudioWithYtDlp(video.url);
      }
      await sock.sendMessage(from, {
        audio: mp3,
        mimetype: "audio/mpeg",
        fileName: `${sanitizeFileName(title)}.mp3`,
      });
    } catch (err: any) {
      logger.error({ err, song }, "Failed to play YouTube audio");
      await sendText(from, `❌ Failed to fetch audio: ${err?.message || "YouTube request failed"}`);
    }
    return;
  }
}

async function convertToStickerWebp(input: Buffer): Promise<Buffer> {
  const MAX_SIZE = 95 * 1024;
  let quality = 80;
  let result: Buffer;
  do {
    result = await sharp(input, { animated: false })
      .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality, effort: 6, lossless: false, smartSubsample: true })
      .toBuffer();
    quality -= 10;
  } while (result.length > MAX_SIZE && quality > 10);
  return result;
}

async function convertVideoToStickerWebp(input: Buffer): Promise<Buffer> {
  const dir = path.join(process.cwd(), "data", "tmp");
  await fs.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const inputPath = path.join(dir, `${id}.input`);
  const outputPath = path.join(dir, `${id}.webp`);
  await fs.writeFile(inputPath, input);
  try {
    await runFfmpeg([
      "-y",
      "-i", inputPath,
      "-t", "7",
      "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=12",
      "-loop", "0",
      "-lossless", "0",
      "-quality", "75",
      "-compression_level", "6",
      "-preset", "default",
      "-an",
      outputPath,
    ]);
    const buf = await fs.readFile(outputPath);
    if (buf.length > 1000 * 1024) {
      throw new Error("Video too large to convert to sticker (max ~1MB).");
    }
    return buf;
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function convertToMp3(input: Buffer): Promise<Buffer> {
  const dir = path.join(process.cwd(), "data", "tmp");
  await fs.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const inputPath = path.join(dir, `${id}.input`);
  const outputPath = path.join(dir, `${id}.mp3`);
  await fs.writeFile(inputPath, input);
  try {
    await runFfmpeg(["-y", "-i", inputPath, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k", outputPath]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-500) || `ffmpeg exited with ${code}`));
    });
  });
}

async function downloadAudioWithYtDlp(url: string): Promise<Buffer> {
  const dir = path.join(process.cwd(), "data", "tmp");
  await fs.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const outputPath = path.join(dir, `${id}.mp3`);
  try {
    await runCommand("yt-dlp", [
      "--no-playlist",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "128K",
      "-o",
      outputPath,
      url,
    ]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-800) || `${command} exited with ${code}`));
    });
  });
}

function addWebpExif(webp: Buffer, packName: string, stickerName: string): Buffer {
  if (webp.length < 12 || webp.toString("ascii", 0, 4) !== "RIFF" || webp.toString("ascii", 8, 12) !== "WEBP") {
    return webp;
  }
  const exif = buildStickerExif(packName, stickerName);
  const exifSize = Buffer.alloc(4);
  exifSize.writeUInt32LE(exif.length, 0);
  const padByte = exif.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const exifChunk = Buffer.concat([
    Buffer.from("EXIF", "ascii"),
    exifSize,
    exif,
    padByte,
  ]);
  // Strip any existing EXIF chunk and rebuild
  const chunks: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= webp.length) {
    const type = webp.toString("ascii", offset, offset + 4);
    const size = webp.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    const end = offset + 8 + padded;
    if (end > webp.length) break;
    if (type !== "EXIF") chunks.push(webp.subarray(offset, end));
    offset = end;
  }
  const body = Buffer.concat([...chunks, exifChunk]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + body.length, 0); // "WEBP" + body
  return Buffer.concat([Buffer.from("RIFF"), riffSize, Buffer.from("WEBP"), body]);
}

function buildStickerExif(packName: string, stickerName: string): Buffer {
  // JSON payload for WhatsApp sticker metadata
  const json = Buffer.from(
    JSON.stringify({
      "sticker-pack-id": "requiem-order",
      "sticker-pack-name": packName,
      "sticker-pack-publisher": stickerName,
      "sticker-name": stickerName,
      emojis: ["✨"],
    }),
    "utf-8"
  );

  // Correct TIFF/little-endian EXIF structure:
  // [0-1]   "II" (little-endian marker)
  // [2-3]   42  (TIFF magic)
  // [4-7]   8   (offset to first IFD)
  // --- IFD at offset 8 ---
  // [8-9]   1   (number of directory entries)
  // --- Entry 0 (12 bytes) ---
  // [10-11] 0x5741 tag ("WA")
  // [12-13] 0x0007 type UNDEFINED
  // [14-17] json.length  (count)
  // [18-21] 26  (value offset — after IFD entry + next-IFD pointer)
  // --- next-IFD pointer (4 bytes) ---
  // [22-25] 0   (no next IFD)
  // --- JSON data starts at offset 26 ---
  const exif = Buffer.alloc(26 + json.length);
  exif[0] = 0x49; exif[1] = 0x49;                  // "II"
  exif[2] = 0x2a; exif[3] = 0x00;                  // magic 42
  exif.writeUInt32LE(8, 4);                         // IFD offset
  exif.writeUInt16LE(1, 8);                         // 1 entry
  exif.writeUInt16LE(0x5741, 10);                   // tag WA
  exif.writeUInt16LE(0x0007, 12);                   // type UNDEFINED
  exif.writeUInt32LE(json.length, 14);              // count
  exif.writeUInt32LE(26, 18);                       // value offset
  exif.writeUInt32LE(0, 22);                        // next IFD = none
  json.copy(exif, 26);
  return exif;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "audio";
}
