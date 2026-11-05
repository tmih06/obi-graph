/**
 * Library build: ESM bundle + type declarations + stylesheet.
 *
 * Runtime code is bundled for the browser, while React (the only peer
 * dependency) stays external so consumers install it normally. Everything else
 * — the force simulation included — is bundled, so the package has no runtime
 * dependencies at all.
 * Declarations are emitted separately by tsc (see tsconfig.build.json) with
 * relative import extensions rewritten for NodeNext consumers.
 */
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = new URL("../dist/", import.meta.url);
const binary = (name: string) =>
  fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));

const externals = ["react", "react/jsx-runtime", "react-dom"];

async function run(command: string[], label: string) {
  const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) {
    console.error(`\n${label} failed with exit code ${code}`);
    process.exit(code);
  }
}

await rm(dist, { recursive: true, force: true });

await run([binary("tsc"), "--project", "tsconfig.build.json"], "Declaration build (tsc)");

await run(
  [
    "bun",
    "build",
    "./src/graph/index.ts",
    "--outdir",
    "./dist",
    "--target",
    "browser",
    "--format",
    "esm",
    "--minify",
    ...externals.map((name) => `--external=${name}`),
  ],
  "Library bundle (bun build)",
);

await mkdir(dist, { recursive: true });
await copyFile(new URL("../src/graph/graph.css", import.meta.url), new URL("styles.css", dist));
await Bun.write(new URL("styles.d.ts", dist), "export {};\n");

const declaration = await stat(new URL("index.d.ts", dist));
if (declaration.size === 0) {
  console.error("Declaration build produced an empty dist/index.d.ts");
  process.exit(1);
}
