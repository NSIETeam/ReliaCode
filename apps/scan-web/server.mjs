import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
const root = process.cwd();
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8" };
createServer((req, res) => {
  const requested = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const target = normalize(join(root, requested));
  if (!target.startsWith(root) || !existsSync(target)) { res.writeHead(404); res.end("Not found"); return; }
  res.writeHead(200, { "Content-Type": types[extname(target)] || "application/octet-stream" });
  createReadStream(target).pipe(res);
}).listen(4173, () => console.log("ReliaCode MVP: http://localhost:4173"));
