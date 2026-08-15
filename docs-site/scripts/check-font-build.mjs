import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedConfig = await readFile(
  join(root, ".blume", "astro.config.mjs"),
  "utf8",
);

const localProviderCount = [...generatedConfig.matchAll(/fontProviders\.local\(\)/g)].length;
if (localProviderCount !== 2) {
  throw new Error(
    `Expected two local font families in the generated Blume config; found ${localProviderCount}.`,
  );
}

for (const provider of ["google", "fontsource", "bunny", "fontshare"]) {
  if (generatedConfig.includes(`fontProviders.${provider}()`)) {
    throw new Error(`Documentation fonts must not depend on the remote ${provider} provider.`);
  }
}

const sourceFiles = [
  "Geist-Variable.woff2",
  "Geist-VariableItalic.woff2",
  "GeistMono-Variable.woff2",
  "GeistMono-VariableItalic.woff2",
];
for (const name of sourceFiles) {
  const encodedPath = JSON.stringify(join(root, "fonts", name)).slice(1, -1);
  if (!generatedConfig.includes(encodedPath)) {
    throw new Error(`Generated Blume config is missing local font source ${name}.`);
  }
}

const license = await readFile(join(root, "fonts", "OFL.txt"), "utf8");
if (!license.includes("SIL OPEN FONT LICENSE Version 1.1")) {
  throw new Error("The vendored Geist fonts must include their SIL Open Font License.");
}

const index = await readFile(join(root, "dist", "index.html"), "utf8");
for (const remoteHost of ["fonts.googleapis.com", "fonts.gstatic.com"]) {
  if (index.includes(remoteHost)) {
    throw new Error(`Built documentation must not reference ${remoteHost}.`);
  }
}
if (!index.includes("/docs/_astro/fonts/")) {
  throw new Error("Built documentation does not reference its self-hosted font assets.");
}

const emittedFonts = (await readdir(join(root, "dist", "_astro", "fonts")))
  .filter((name) => name.endsWith(".woff2"));
if (emittedFonts.length !== sourceFiles.length) {
  throw new Error(
    `Expected ${sourceFiles.length} emitted font assets; found ${emittedFonts.length}.`,
  );
}

console.log(
  `Font build checks passed: ${emittedFonts.length} self-hosted assets, no remote font providers.`,
);
