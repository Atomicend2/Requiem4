import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { requireAuth, type AuthRequest } from "./middleware.js";
import { getDb } from "../../bot/db/database.js";
import { getAllFrames, getFrameById, addFrame, equipFrame, getUserEquippedFrame } from "../../bot/db/queries.js";
import { svgToFramePng } from "../../bot/frames.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const BOT_OWNER = (process.env["BOT_OWNER_LID"] || "2348144550593").replace(/\D/g, "");

function isStaff(req: AuthRequest): boolean {
  const phone = (req.user?.phone || "").replace(/\D/g, "");
  const userId = req.user?.id || "";
  if (phone === BOT_OWNER || userId === `${BOT_OWNER}@s.whatsapp.net`) return true;
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM staff WHERE user_id = ? OR user_id LIKE ?").get(userId, `${userId.split("@")[0]}%`);
  return !!row;
}

router.get("/", (_req, res) => {
  try {
    const frames = getAllFrames();
    res.json({
      success: true,
      frames: frames.map((f) => ({
        id: f.id,
        name: f.name,
        theme: f.theme,
        uploadedBy: f.uploaded_by,
        createdAt: f.created_at,
        isSystem: f.uploaded_by === "system",
      })),
    });
  } catch {
    res.status(500).json({ success: false, message: "Failed to fetch frames" });
  }
});

router.get("/:id/image", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, message: "Invalid ID" }); return; }
    const frame = getFrameById(id);
    if (!frame) { res.status(404).json({ success: false, message: "Frame not found" }); return; }

    let imageBuffer: Buffer;
    if (frame.image && Buffer.isBuffer(frame.image) && frame.image.length > 0) {
      imageBuffer = frame.image;
    } else if (frame.svg) {
      imageBuffer = await svgToFramePng(frame.svg);
    } else {
      res.status(404).json({ success: false, message: "Frame has no image" }); return;
    }
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(imageBuffer);
  } catch {
    res.status(500).json({ success: false, message: "Failed to render frame" });
  }
});

router.put("/equip", requireAuth, (req: AuthRequest, res) => {
  try {
    const { frameId } = req.body;
    if (frameId === null || frameId === undefined) {
      equipFrame(req.userId!, null);
      res.json({ success: true, message: "Frame unequipped" });
      return;
    }
    const id = parseInt(String(frameId), 10);
    if (isNaN(id)) { res.status(400).json({ success: false, message: "Invalid frameId" }); return; }
    const frame = getFrameById(id);
    if (!frame) { res.status(404).json({ success: false, message: "Frame not found" }); return; }
    equipFrame(req.userId!, id);
    res.json({ success: true, message: `Frame "${frame.name}" equipped` });
  } catch {
    res.status(500).json({ success: false, message: "Failed to equip frame" });
  }
});

router.get("/me", requireAuth, (req: AuthRequest, res) => {
  try {
    const frame = getUserEquippedFrame(req.userId!);
    res.json({ success: true, frame: frame ? { id: frame.id, name: frame.name, theme: frame.theme } : null });
  } catch {
    res.status(500).json({ success: false, message: "Failed to get equipped frame" });
  }
});

router.post("/upload", requireAuth, upload.single("frame"), async (req: AuthRequest, res) => {
  try {
    if (!isStaff(req)) {
      res.status(403).json({ success: false, message: "Staff only" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }
    const name = String(req.body.name || "Custom Frame").slice(0, 50);
    const theme = String(req.body.theme || "custom").slice(0, 30);

    const png = await sharp(req.file.buffer)
      .resize(220, 220, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const id = addFrame(name, theme, null, png, req.userId!);
    res.json({ success: true, message: `Frame "${name}" uploaded`, frameId: id });
  } catch {
    res.status(500).json({ success: false, message: "Failed to upload frame" });
  }
});

router.delete("/:id", requireAuth, (req: AuthRequest, res) => {
  try {
    if (!isStaff(req)) {
      res.status(403).json({ success: false, message: "Staff only" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) { res.status(400).json({ success: false, message: "Invalid ID" }); return; }
    const db = getDb();
    const frame = db.prepare("SELECT * FROM frames WHERE id = ?").get(id) as any;
    if (!frame) { res.status(404).json({ success: false, message: "Frame not found" }); return; }
    if (frame.uploaded_by === "system") {
      res.status(403).json({ success: false, message: "Cannot delete system frames" }); return;
    }
    db.prepare("DELETE FROM frames WHERE id = ?").run(id);
    res.json({ success: true, message: "Frame deleted" });
  } catch {
    res.status(500).json({ success: false, message: "Failed to delete frame" });
  }
});

export { router as framesRouter };
