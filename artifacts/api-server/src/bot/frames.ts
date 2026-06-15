import sharp from "sharp";
import { getDb } from "./db/database.js";

const FRAME_SIZE = 220;

const DEFAULT_FRAMES: Array<{ name: string; theme: string; svg: string }> = [
  {
    name: "Celestial Sky",
    theme: "celestial",
    svg: `<svg width="220" height="220" xmlns="http://www.w3.org/2000/svg">
  <circle cx="110" cy="110" r="109" fill="none" stroke="#0369a1" stroke-width="1.5" opacity="0.5"/>
  <circle cx="110" cy="110" r="105" fill="none" stroke="#0ea5e9" stroke-width="3" opacity="0.8"/>
  <circle cx="110" cy="110" r="101" fill="none" stroke="#38bdf8" stroke-width="7"/>
  <circle cx="110" cy="110" r="96" fill="none" stroke="#7dd3fc" stroke-width="2" opacity="0.7"/>
  <circle cx="110" cy="110" r="94" fill="none" stroke="#bae6fd" stroke-width="1" opacity="0.4"/>
  <polygon points="110,1 113.5,9 122,9 115.5,14.5 118,23 110,17.5 102,23 104.5,14.5 98,9 106.5,9" fill="#ffffff" opacity="0.95"/>
  <polygon points="110,219 113.5,211 122,211 115.5,205.5 118,197 110,202.5 102,197 104.5,205.5 98,211 106.5,211" fill="#ffffff" opacity="0.95"/>
  <polygon points="1,110 9,106.5 9,98 14.5,104.5 23,102 17.5,110 23,118 14.5,115.5 9,122 9,113.5" fill="#ffffff" opacity="0.95"/>
  <polygon points="219,110 211,113.5 211,122 205.5,115.5 197,118 202.5,110 197,102 205.5,104.5 211,98 211,106.5" fill="#ffffff" opacity="0.95"/>
  <circle cx="110" cy="5" r="2" fill="#38bdf8" opacity="0.9"/>
  <circle cx="110" cy="215" r="2" fill="#38bdf8" opacity="0.9"/>
  <circle cx="5" cy="110" r="2" fill="#38bdf8" opacity="0.9"/>
  <circle cx="215" cy="110" r="2" fill="#38bdf8" opacity="0.9"/>
  <circle cx="155" cy="18" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="65" cy="18" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="202" cy="65" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="202" cy="155" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="18" cy="65" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="18" cy="155" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="155" cy="202" r="1.5" fill="#bae6fd" opacity="0.8"/>
  <circle cx="65" cy="202" r="1.5" fill="#bae6fd" opacity="0.8"/>
</svg>`,
  },
  {
    name: "Cherry Blossom",
    theme: "sakura",
    svg: `<svg width="220" height="220" xmlns="http://www.w3.org/2000/svg">
  <circle cx="110" cy="110" r="109" fill="none" stroke="#9d174d" stroke-width="1.5" opacity="0.4"/>
  <circle cx="110" cy="110" r="105" fill="none" stroke="#db2777" stroke-width="2.5" opacity="0.7"/>
  <circle cx="110" cy="110" r="101" fill="none" stroke="#ec4899" stroke-width="7"/>
  <circle cx="110" cy="110" r="96" fill="none" stroke="#f9a8d4" stroke-width="2" opacity="0.8"/>
  <circle cx="110" cy="110" r="94" fill="none" stroke="#fce7f3" stroke-width="1" opacity="0.5"/>
  <ellipse cx="110" cy="4" rx="4" ry="6" fill="#fda4af" opacity="0.95" transform="rotate(0,110,110)"/>
  <ellipse cx="110" cy="4" rx="4" ry="6" fill="#fda4af" opacity="0.95" transform="rotate(60,110,110)"/>
  <ellipse cx="110" cy="4" rx="4" ry="6" fill="#fda4af" opacity="0.95" transform="rotate(120,110,110)"/>
  <ellipse cx="110" cy="4" rx="4" ry="6" fill="#fda4af" opacity="0.95" transform="rotate(180,110,110)"/>
  <ellipse cx="110" cy="4" rx="4" ry="6" fill="#fda4af" opacity="0.95" transform="rotate(240,110,110)"/>
  <ellipse cx="110" cy="4" rx="4" ry="6" fill="#fda4af" opacity="0.95" transform="rotate(300,110,110)"/>
  <circle cx="110" cy="5" r="2" fill="#fdf2f8" opacity="0.9"/>
  <circle cx="155" cy="18" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="65" cy="18" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="202" cy="65" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="202" cy="155" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="18" cy="65" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="18" cy="155" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="155" cy="202" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="65" cy="202" r="1.5" fill="#fce7f3" opacity="0.8"/>
  <circle cx="110" cy="215" r="2" fill="#fda4af" opacity="0.9"/>
</svg>`,
  },
  {
    name: "Samurai Gold",
    theme: "samurai",
    svg: `<svg width="220" height="220" xmlns="http://www.w3.org/2000/svg">
  <circle cx="110" cy="110" r="109" fill="none" stroke="#78350f" stroke-width="1.5" opacity="0.5"/>
  <circle cx="110" cy="110" r="106" fill="none" stroke="#92400e" stroke-width="2" opacity="0.6"/>
  <circle cx="110" cy="110" r="102" fill="none" stroke="#d97706" stroke-width="3"/>
  <circle cx="110" cy="110" r="101" fill="none" stroke="#fbbf24" stroke-width="8"/>
  <circle cx="110" cy="110" r="97" fill="none" stroke="#d97706" stroke-width="2.5"/>
  <circle cx="110" cy="110" r="94" fill="none" stroke="#fef3c7" stroke-width="1" opacity="0.5"/>
  <polygon points="110,1 114,9 122,9 116,15 119,23 110,18 101,23 104,15 98,9 106,9" fill="#fbbf24"/>
  <polygon points="110,219 114,211 122,211 116,205 119,197 110,202 101,197 104,205 98,211 106,211" fill="#fbbf24"/>
  <polygon points="1,110 9,106 9,98 15,104 23,101 18,110 23,119 15,116 9,122 9,114" fill="#fbbf24"/>
  <polygon points="219,110 211,114 211,122 205,116 197,119 202,110 197,101 205,104 211,98 211,106" fill="#fbbf24"/>
  <polygon points="156,20 159,27 153,27" fill="#fbbf24" opacity="0.9"/>
  <polygon points="64,20 67,27 61,27" fill="#fbbf24" opacity="0.9"/>
  <polygon points="200,64 207,61 207,67" fill="#fbbf24" opacity="0.9"/>
  <polygon points="200,156 207,153 207,159" fill="#fbbf24" opacity="0.9"/>
  <polygon points="20,64 27,61 27,67" fill="#fbbf24" opacity="0.9"/>
  <polygon points="20,156 27,153 27,159" fill="#fbbf24" opacity="0.9"/>
  <polygon points="156,200 159,193 153,193" fill="#fbbf24" opacity="0.9"/>
  <polygon points="64,200 67,193 61,193" fill="#fbbf24" opacity="0.9"/>
</svg>`,
  },
  {
    name: "Neon Pulse",
    theme: "neon",
    svg: `<svg width="220" height="220" xmlns="http://www.w3.org/2000/svg">
  <circle cx="110" cy="110" r="109" fill="none" stroke="#7e22ce" stroke-width="1" opacity="0.5"/>
  <circle cx="110" cy="110" r="106" fill="none" stroke="#a855f7" stroke-width="2" opacity="0.6"/>
  <circle cx="110" cy="110" r="103" fill="none" stroke="#22d3ee" stroke-width="1.5" opacity="0.8"/>
  <circle cx="110" cy="110" r="101" fill="none" stroke="#a855f7" stroke-width="6"/>
  <circle cx="110" cy="110" r="97" fill="none" stroke="#22d3ee" stroke-width="3" opacity="0.9"/>
  <circle cx="110" cy="110" r="94" fill="none" stroke="#e879f9" stroke-width="1.5" opacity="0.7"/>
  <rect x="107" y="1" width="6" height="10" rx="2" fill="#22d3ee" opacity="0.95"/>
  <rect x="107" y="209" width="6" height="10" rx="2" fill="#22d3ee" opacity="0.95"/>
  <rect x="1" y="107" width="10" height="6" rx="2" fill="#22d3ee" opacity="0.95"/>
  <rect x="209" y="107" width="10" height="6" rx="2" fill="#22d3ee" opacity="0.95"/>
  <rect x="151" y="14" width="4" height="8" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(30,153,18)"/>
  <rect x="63" y="14" width="4" height="8" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(-30,65,18)"/>
  <rect x="198" y="60" width="8" height="4" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(30,202,62)"/>
  <rect x="198" y="152" width="8" height="4" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(-30,202,154)"/>
  <rect x="14" y="60" width="8" height="4" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(-30,18,62)"/>
  <rect x="14" y="152" width="8" height="4" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(30,18,154)"/>
  <rect x="151" y="198" width="4" height="8" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(-30,153,202)"/>
  <rect x="63" y="198" width="4" height="8" rx="1" fill="#e879f9" opacity="0.8" transform="rotate(30,65,202)"/>
  <circle cx="110" cy="5" r="2.5" fill="#a855f7" opacity="0.9"/>
  <circle cx="110" cy="215" r="2.5" fill="#a855f7" opacity="0.9"/>
  <circle cx="5" cy="110" r="2.5" fill="#a855f7" opacity="0.9"/>
  <circle cx="215" cy="110" r="2.5" fill="#a855f7" opacity="0.9"/>
</svg>`,
  },
  {
    name: "Dragon Fire",
    theme: "dragon",
    svg: `<svg width="220" height="220" xmlns="http://www.w3.org/2000/svg">
  <circle cx="110" cy="110" r="109" fill="none" stroke="#7f1d1d" stroke-width="1.5" opacity="0.5"/>
  <circle cx="110" cy="110" r="106" fill="none" stroke="#b91c1c" stroke-width="2" opacity="0.7"/>
  <circle cx="110" cy="110" r="102" fill="none" stroke="#f97316" stroke-width="2" opacity="0.6"/>
  <circle cx="110" cy="110" r="101" fill="none" stroke="#ef4444" stroke-width="7"/>
  <circle cx="110" cy="110" r="96" fill="none" stroke="#fbbf24" stroke-width="2" opacity="0.8"/>
  <circle cx="110" cy="110" r="94" fill="none" stroke="#fef3c7" stroke-width="1" opacity="0.4"/>
  <polygon points="110,1 113,12 120,6 116,17 124,14 117,23 110,20 103,23 96,14 104,17 100,6 107,12" fill="#f97316" opacity="0.95"/>
  <polygon points="110,219 113,208 120,214 116,203 124,206 117,197 110,200 103,197 96,206 104,203 100,214 107,208" fill="#f97316" opacity="0.95"/>
  <polygon points="1,110 12,107 6,100 17,104 14,96 23,103 20,110 23,117 14,124 17,116 6,120 12,113" fill="#f97316" opacity="0.95"/>
  <polygon points="219,110 208,113 214,120 203,116 206,124 197,117 200,110 197,103 206,96 203,104 214,100 208,107" fill="#f97316" opacity="0.95"/>
  <circle cx="156" cy="18" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="64" cy="18" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="202" cy="64" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="202" cy="156" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="18" cy="64" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="18" cy="156" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="156" cy="202" r="2" fill="#fbbf24" opacity="0.9"/>
  <circle cx="64" cy="202" r="2" fill="#fbbf24" opacity="0.9"/>
</svg>`,
  },
];

export async function svgToFramePng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg))
    .resize(FRAME_SIZE, FRAME_SIZE)
    .png()
    .toBuffer();
}

export async function seedDefaultFrames(): Promise<void> {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) as cnt FROM frames WHERE uploaded_by = 'system'").get() as any;
  if (existing?.cnt > 0) return;

  for (const frame of DEFAULT_FRAMES) {
    const png = await svgToFramePng(frame.svg);
    db.prepare(
      "INSERT OR IGNORE INTO frames (name, theme, svg, image, uploaded_by) VALUES (?, ?, ?, ?, 'system')"
    ).run(frame.name, frame.theme, frame.svg, png);
  }
}

export function getFrameBuffer(frame: any): Buffer | null {
  if (frame.image && Buffer.isBuffer(frame.image)) return frame.image;
  if (frame.svg) {
    return null;
  }
  return null;
}
