import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const deploy = path.join(root, ".deploy");
const docs = path.join(deploy, "docs");

await rm(deploy, { recursive: true, force: true });
await mkdir(docs, { recursive: true });
await cp(dist, docs, { recursive: true });

for (const platformFile of ["_headers", "_redirects"]) {
  const source = path.join(dist, platformFile);
  const staged = path.join(deploy, platformFile);
  const copied = await cp(source, staged, {
    force: false,
  }).then(() => true).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
    return false;
  });
  if (copied) await rm(path.join(docs, platformFile), { force: true });
}

console.log("Staged Cloudflare assets at .deploy/docs/.");
