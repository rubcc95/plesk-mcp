import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts"
  },
  format: ["esm"],
  target: "node22",
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version)
  }
});
