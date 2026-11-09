import { describe, expect, it } from "vitest";
import type { PleskClient } from "./client.js";
import {
  buildWalkPlan,
  findUnsafeLocalNames,
  parseEntries,
  relativeTo,
  walkRemote
} from "./remote-tree.js";

function fakeClient(tree: Record<string, unknown[]>): PleskClient {
  return {
    fsList: async (remote: string) => {
      if (!(remote in tree)) {
        throw new Error(`Does not exist ${remote}`);
      }
      return tree[remote];
    },
    fsStat: async (remote: string) => {
      if (!(remote in tree)) {
        throw new Error(`Does not exist ${remote}`);
      }
      return {
        name: remote.split("/").pop(),
        type: Array.isArray(tree[remote]) &&
          (tree[remote] as Array<{ name?: string }>).some((entry) => entry.name)
          ? "directory"
          : "directory"
      };
    }
  } as unknown as PleskClient;
}

describe("parseEntries", () => {
  it("accepts array, entries, and data", () => {
    const entry = { name: "a.txt", type: "file", size: 3 };
    expect(parseEntries([entry])).toHaveLength(1);
    expect(parseEntries({ entries: [entry] })).toHaveLength(1);
    expect(parseEntries({ data: [entry] })).toHaveLength(1);
  });

  it("normalizes types and sizes", () => {
    const [dir, file, link] = parseEntries([
      { name: "assets", type: "directory" },
      { name: "a.txt", type: "file", size: "12" },
      { name: "link", type: "symlink" }
    ]);
    expect(dir?.type).toBe("directory");
    expect(file?.size).toBe(12);
    expect(link?.type).toBe("symlink");
  });
});

describe("walkRemote", () => {
  const tree = {
    "/httpdocs": [
      { name: "assets", type: "directory" },
      { name: "index.php", type: "file", size: 10 },
      { name: "node_modules", type: "directory" }
    ],
    "/httpdocs/assets": [
      { name: "app.js", type: "file", size: 20 },
      { name: "nested", type: "directory" }
    ],
    "/httpdocs/assets/nested": [
      { name: "logo.png", type: "file", size: 30 }
    ],
    "/httpdocs/node_modules": [
      { name: "dep.js", type: "file", size: 99 }
    ]
  };

  it("walks, excludes, and sums sizes", async () => {
    const result = await walkRemote(fakeClient(tree), ["/httpdocs"], {
      base: "/",
      exclude: ["node_modules"]
    });

    expect(result.files.map((file) => file.relative).sort()).toEqual([
      "httpdocs/assets/app.js",
      "httpdocs/assets/nested/logo.png",
      "httpdocs/index.php"
    ]);
    expect(result.totalBytes).toBe(60);
    expect(result.warnings).toEqual([]);
  });

  it("walks the whole tree without limits", async () => {
    const result = await walkRemote(fakeClient(tree), ["/httpdocs/assets"], {
      base: "/httpdocs",
      exclude: []
    });
    expect(result.files.map((file) => file.relative).sort()).toEqual([
      "assets/app.js",
      "assets/nested/logo.png"
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe("buildWalkPlan", () => {
  it("keeps relative paths", () => {
    const plan = buildWalkPlan({
      files: [{ remote: "/httpdocs/assets/app.js", relative: "assets/app.js", size: 1 }],
      directories: [
        { remote: "/httpdocs/assets", relative: "assets" },
        { remote: "/httpdocs/assets/nested", relative: "assets/nested" }
      ],
      totalBytes: 1,
      warnings: []
    });

    expect(plan.files[0]?.localRelative).toBe("assets/app.js");
    expect(plan.directories.map((directory) => directory.localRelative)).toEqual([
      "assets",
      "assets/nested"
    ]);
  });

  it("detects invalid Windows names", () => {
    expect(() =>
      buildWalkPlan({
        files: [{ remote: "/x/a:b.txt", relative: "a:b.txt", size: 1 }],
        directories: [],
        totalBytes: 1,
        warnings: []
      })
    ).toThrow(/cannot be created on Windows/);
  });
});

describe("path utilities", () => {
  it("computes relative paths", () => {
    expect(relativeTo("/httpdocs", "/httpdocs/assets/a.js")).toBe("assets/a.js");
    expect(relativeTo("/", "/httpdocs")).toBe("httpdocs");
  });

  it("detects reserved names", () => {
    expect(findUnsafeLocalNames(["CON.txt"])).toHaveLength(1);
    expect(findUnsafeLocalNames(["ok/file.txt"])).toEqual([]);
  });
});
