import { type Request, type Response, type NextFunction } from "express";
import { getDb } from "../../bot/db/database.js";
import { verifySessionToken } from "./auth.js";

export interface AuthRequest extends Request {
  userId?: string;
  user?: any;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);

  // Try new stateless signed token first
  const session = verifySessionToken(token);
  if (!session) {
    // Fall back to legacy DB session for tokens issued before this change
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const dbSession = db.prepare("SELECT * FROM web_sessions WHERE token = ? AND expires_at > ?").get(token, now) as any;
    if (!dbSession) {
      res.status(401).json({ success: false, message: "Invalid or expired session" });
      return;
    }
    const user = db.prepare(
      "SELECT * FROM users WHERE id = ? OR phone = ? OR lid = ? LIMIT 1"
    ).get(dbSession.user_id, dbSession.user_id, dbSession.user_id) as any;
    if (!user) {
      res.status(401).json({ success: false, message: "User not found" });
      return;
    }
    req.userId = user.id;
    req.user = user;
    next();
    return;
  }

  const db = getDb();
  const user = db.prepare(
    "SELECT * FROM users WHERE id = ? OR phone = ? OR lid = ? LIMIT 1"
  ).get(session.userId, session.userId, session.userId) as any;
  if (!user) {
    res.status(401).json({ success: false, message: "User not found" });
    return;
  }

  req.userId = user.id;
  req.user = user;
  next();
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Try stateless signed token first
    const session = verifySessionToken(token);
    if (session) {
      const db = getDb();
      const user = db.prepare(
        "SELECT * FROM users WHERE id = ? OR phone = ? OR lid = ? LIMIT 1"
      ).get(session.userId, session.userId, session.userId) as any;
      if (user) {
        req.userId = user.id;
        req.user = user;
      }
    } else {
      // Fall back to legacy DB session
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const dbSession = db.prepare("SELECT * FROM web_sessions WHERE token = ? AND expires_at > ?").get(token, now) as any;
      if (dbSession) {
        const user = db.prepare(
          "SELECT * FROM users WHERE id = ? OR phone = ? OR lid = ? LIMIT 1"
        ).get(dbSession.user_id, dbSession.user_id, dbSession.user_id) as any;
        if (user) {
          req.userId = user.id;
          req.user = user;
        }
      }
    }
  }
  next();
}
