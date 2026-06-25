import { type Request, type Response, type NextFunction } from "express";
import { col } from "../../bot/db/mongo.js";
import { verifySessionToken } from "./auth.js";

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
}

async function findUserById(userId: string): Promise<any> {
  const doc = await col("users").findOne({
    $or: [{ _id: userId as any }, { phone: userId }, { lid: userId }],
  });
  return doc ? { ...doc, id: doc._id } : null;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  const session = verifySessionToken(token);

  (async () => {
    if (!session) {
      // Legacy DB session fallback
      const now = Math.floor(Date.now() / 1000);
      const dbSession = await col("web_sessions").findOne({ _id: token as any, expires_at: { $gt: now } });
      if (!dbSession) {
        res.status(401).json({ success: false, message: "Invalid or expired session" });
        return;
      }
      const user = await findUserById(dbSession.user_id);
      if (!user) { res.status(401).json({ success: false, message: "User not found" }); return; }
      req.userId = user.id;
      req.user = user;
      next();
      return;
    }

    const user = await findUserById(session.userId);
    if (!user) { res.status(401).json({ success: false, message: "User not found" }); return; }
    req.userId = user.id as string;
    req.user = user;
    next();
  })().catch((err) => {
    res.status(500).json({ success: false, message: "Auth error" });
  });
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) { next(); return; }

  const token = authHeader.slice(7);
  (async () => {
    const session = verifySessionToken(token);
    if (session) {
      const user = await findUserById(session.userId);
      if (user) { req.userId = user.id; req.user = user; }
    } else {
      const now = Math.floor(Date.now() / 1000);
      const dbSession = await col("web_sessions").findOne({ _id: token as any, expires_at: { $gt: now } });
      if (dbSession) {
        const user = await findUserById(dbSession.user_id);
        if (user) { req.userId = user.id; req.user = user; }
      }
    }
    next();
  })().catch(() => next());
}
