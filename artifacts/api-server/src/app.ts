import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const publicDirCandidates = [
  path.join(__dirname, "public"),
  path.join(process.cwd(), "dist", "public"),
  path.join(process.cwd(), "artifacts", "api-server", "dist", "public"),
];
const publicDir = publicDirCandidates.find((d) => fs.existsSync(d));

if (publicDir) {
  app.use(express.static(publicDir));
  app.use((_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.json({ status: "ok", message: "Requiem Order API is running" });
  });
}

export default app;
