import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildLocalPlan,
  collectLocalTree,
  findLocalBase,
  resolveLocalEntry
} from "./local-tree.js";
import { buildExtractArgs } from "./upload-archive.js";

describe("local-tree", () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(path.join(os.tmpdir(), "plesk-local-"));
    await mkdir(path.join(project, "dist", "sub"), { recursive: true });
    await mkdir(path.join(project, "empty"), { recursive: true });
    await writeFile(path.join(project, "dist", "a.js"), "aaa");
    await writeFile(path.join(project, "dist", "sub", "b.js"), "bbbb");
    await writeFile(path.join(project, "dist", "app.js.map"), "map");
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it("computes the common base", async () => {
    const entries = await Promise.all([
      resolveLocalEntry(project, "dist"),
      resolveLocalEntry(project, "dist/sub")
    ]);
    expect(findLocalBase(entries.map((entry) => entry.absolute))).toBe(project);
  });

  it("walks files, directories, and sizes", async () => {
    const entries = [await resolveLocalEntry(project, "dist")];
    const tree = await collectLocalTree(entries, {
      exclude: ["*.map"]
    });

    expect(tree.base).toBe(project);
    expect(tree.files.map((file) => file.relative).sort()).toEqual([
      "dist/a.js",
      "dist/sub/b.js"
    ]);
    expect(tree.directories.map((directory) => directory.relative).sort()).toEqual([
      "dist",
      "dist/sub"
    ]);
    expect(tree.totalBytes).toBe(7);
  });

  it("keeps relative paths", async () => {
    const entries = [await resolveLocalEntry(project, "dist")];
    const tree = await collectLocalTree(entries, {
      exclude: ["*.map"]
    });
    const plan = buildLocalPlan(tree);

    expect(plan.files.map((file) => file.remoteRelative).sort()).toEqual([
      "dist/a.js",
      "dist/sub/b.js"
    ]);
    expect(plan.directories.map((directory) => directory.remoteRelative)).toEqual([
      "dist",
      "dist/sub"
    ]);
  });

  it("rejects paths outside the project", async () => {
    await expect(resolveLocalEntry(project, "../outside")).rejects.toThrow(
      /outside the project|does not exist/
    );
  });
});

describe("buildExtractArgs", () => {
  it("builds the command with skip", () => {
    expect(
      buildExtractArgs({
        tarBinary: "/bin/tar",
        realArchivePath: "/var/www/vhosts/x/.tmp/a.tar.gz",
        realRemoteDir: "/var/www/vhosts/x/httpdocs",
        overwrite: false
      })
    ).toEqual([
      "/bin/tar",
      "-xzf",
      "/var/www/vhosts/x/.tmp/a.tar.gz",
      "-C",
      "/var/www/vhosts/x/httpdocs",
      "--no-same-owner",
      "--skip-old-files"
    ]);
  });
});
