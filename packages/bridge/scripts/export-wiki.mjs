import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/wiki");
const destinationArg = process.argv[2];
if (!destinationArg || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/export-wiki.mjs <destination-directory>");
}
const destination = resolve(destinationArg);
if (destination === source) throw new Error("Export into a separate directory from docs/wiki");

const names = (await readdir(source)).filter((name) => name.endsWith(".md")).sort();
const pages = new Set(names);
const baseURL = "https://github.com/productivehub/ai-bridge/wiki";

// Read and validate every page before writing any destination files.
const exported = await Promise.all(names.map(async (name) => {
  const markdown = await readFile(join(source, name), "utf8");
  const content = markdown.replace(/\]\(\.\/([^\s)]+\.md)(#[^\s)]*)?\)/g, (_, page, fragment = "") => {
    if (!pages.has(page)) throw new Error(`${name}: missing wiki page ${page}`);
    return `](${baseURL}/${encodeURIComponent(page.slice(0, -3))}${fragment})`;
  });
  return { name, content };
}));

await mkdir(destination, { recursive: true });
for (const { name, content } of exported) await writeFile(join(destination, name), content);
console.log(`Exported ${exported.length} wiki files to ${destination}`);
