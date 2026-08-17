import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The documentation, checked against the repository it describes.
 *
 * Prose drifts silently. A rename moves the code and every test still passes,
 * while the architecture document quietly starts describing a directory that no
 * longer exists — and the docs are the thing a newcomer trusts most.
 *
 * This is not a spell-checker. It asserts two specific, mechanical things: that
 * every concrete path the docs mention exists, and that the instructions given
 * to AI agents still say the thing that makes them work.
 */

const ROOT = resolve(process.cwd());

const DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/architecture.md",
  "docs/conventions.md",
];

/**
 * Paths in backticks that point into the repository.
 *
 * Placeholders (`<group>`, `*`, `…`) are skipped — they are illustrative by
 * design, and the alternative is a regex that fights the prose.
 */
function referencedPaths(markdown: string): string[] {
  const found = new Set<string>();

  for (const match of markdown.matchAll(/`((?:src|tests|scripts|docs|database)\/[^`\s]*)`/g)) {
    const raw = match[1] ?? "";
    if (/[<>*…]/.test(raw)) continue;
    // Trailing punctuation from the surrounding sentence.
    found.add(raw.replace(/[.,;:)]+$/, ""));
  }

  return [...found];
}

interface MarkdownLink {
  /** The whole target, kept for the failure message. */
  readonly target: string;
  /** Path part, empty for a same-document link. */
  readonly file: string;
  /** Fragment without the `#`, empty when the link has none. */
  readonly anchor: string;
}

/** Inline links to somewhere in this repository. External URLs are not ours to check. */
function markdownLinks(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];

  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] ?? "";
    if (/^(https?:|mailto:)/.test(target)) continue;

    const [file = "", anchor = ""] = target.split("#");
    links.push({ target, file, anchor });
  }

  return links;
}

/** Resolves a link relative to the document containing it. */
function resolveLink(fromDoc: string, file: string): string {
  return resolve(ROOT, dirname(fromDoc), file);
}

/**
 * GitHub's heading-to-anchor rule: lower-cased, punctuation dropped, spaces to
 * hyphens. `## 4. The rules` becomes `4-the-rules`, which is why a renumbered
 * section silently breaks every link that named its old number.
 */
function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();

  for (const match of markdown.matchAll(/^#{1,6} +(.+?) *$/gm)) {
    const heading = match[1] ?? "";
    slugs.add(
      heading
        .replace(/`/g, "")
        .toLowerCase()
        .replace(/[^\w\- ]+/g, "")
        .trim()
        .replace(/ +/g, "-"),
    );
  }

  return slugs;
}

/** Every production source file concatenated, for "is this referenced" checks. */
async function readSourceText(): Promise<string> {
  const parts: string[] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts") && !full.includes("metrics.catalog")) {
        parts.push(await readFile(full, "utf8"));
      }
    }
  }

  await walk(join(ROOT, "src"));
  return parts.join(" ");
}

const docs = await Promise.all(
  DOCS.map(async (path) => ({ path, text: await readFile(join(ROOT, path), "utf8") })),
);

/**
 * Every markdown file whose headings a link might target, by absolute path.
 *
 * The ADRs are included as link *targets* though they are not audited as
 * documents: architecture.md indexes them, and that index is exactly the kind
 * of list that gains an entry on disk and not in the table.
 */
const documentText = new Map<string, string>(
  await Promise.all(
    [
      ...DOCS,
      ...(await readdir(join(ROOT, "docs/adr")))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/adr/${name}`),
    ].map(
      async (path) =>
        [resolve(ROOT, path), await readFile(join(ROOT, path), "utf8")] as [string, string],
    ),
  ),
);

describe("documentation", () => {
  it("checks the documents that actually exist", () => {
    expect(docs).toHaveLength(DOCS.length);
  });

  it("references no path that is missing from the repository", () => {
    const broken = docs.flatMap((doc) =>
      referencedPaths(doc.text)
        .filter((path) => !existsSync(join(ROOT, path)))
        .map((path) => `${doc.path} → ${path}`),
    );

    expect(broken).toEqual([]);
  });

  describe("links", () => {
    // A path in backticks is checked above; a *link* is not, and a link is what
    // a reader actually clicks. Both halves rot silently: the file gets moved,
    // or a section is renumbered and every "§ 13" pointing at it now lands on
    // whatever inherited the number — which is worse than a 404, because it
    // looks like it worked.

    it("links to no file that is missing", () => {
      const broken = docs.flatMap((doc) =>
        markdownLinks(doc.text)
          .filter((link) => link.file !== "")
          .filter((link) => !existsSync(resolveLink(doc.path, link.file)))
          .map((link) => `${doc.path} → ${link.target}`),
      );

      expect(broken).toEqual([]);
    });

    it("links to no heading that does not exist", () => {
      const broken = docs.flatMap((doc) =>
        markdownLinks(doc.text)
          .filter((link) => link.anchor !== "")
          .filter((link) => {
            const target =
              link.file === "" ? join(ROOT, doc.path) : resolveLink(doc.path, link.file);
            const text = documentText.get(target);
            // A link into a file this suite does not read is out of scope here;
            // the existence check above already covered the file itself.
            return text !== undefined && !headingSlugs(text).has(link.anchor);
          })
          .map((link) => `${doc.path} → ${link.target}`),
      );

      expect(broken).toEqual([]);
    });
  });

  describe("the AI harness", () => {
    // AGENTS.md is the source. A tool that cannot read it by that name gets a
    // pointer file instead — and the pointer must only ever point, never
    // restate, because a second copy of the rules is a second copy to drift.
    //
    // There is deliberately no Cursor file: Cursor reads AGENTS.md directly, so
    // one would be a duplicate maintained for nothing.
    const POINTERS = ["CLAUDE.md", ".github/copilot-instructions.md"];

    it("has an entry point for every major tool", () => {
      const missing = ["AGENTS.md", ...POINTERS].filter((path) => !existsSync(join(ROOT, path)));

      expect(missing).toEqual([]);
    });

    it("keeps every tool pointing at the same source", async () => {
      const notPointing: string[] = [];
      for (const path of POINTERS) {
        const text = await readFile(join(ROOT, path), "utf8");
        if (!text.includes("AGENTS.md")) notPointing.push(path);
      }

      expect(notPointing).toEqual([]);
    });

    it("still tells agents to run the verification command", async () => {
      // The single instruction the whole harness depends on. If it is ever
      // edited out, agents stop self-correcting and nothing else here matters.
      const text = await readFile(join(ROOT, "AGENTS.md"), "utf8");

      expect(text).toContain("pnpm verify");
    });

    it("still forbids weakening the checks", async () => {
      // The failure the harness cannot catch by itself, because the harness is
      // what gets edited. It only exists as an instruction, so it has to stay.
      const text = await readFile(join(ROOT, "AGENTS.md"), "utf8");

      expect(text.toLowerCase()).toContain("never weaken");
    });
  });

  describe("scripts", () => {
    it("documents every script the package defines", async () => {
      const { scripts } = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };

      const readme = docs.find((doc) => doc.path === "README.md")?.text ?? "";
      const undocumented = Object.keys(scripts).filter((name) => !readme.includes(name));

      expect(undocumented).toEqual([]);
    });
  });

  describe("architecture decision records", () => {
    it("indexes every ADR on disk", async () => {
      // The index is the only way anyone finds an ADR — nothing imports one, so
      // an unlisted record is a decision that was written down and then lost.
      // It goes wrong in the ordinary way: the ADR is added in one commit and
      // the table is a different file that nobody reopened.
      const files = (await readdir(join(ROOT, "docs/adr")))
        .filter((name) => name.endsWith(".md"))
        .sort();

      expect(files.length).toBeGreaterThan(5);

      const architecture = docs.find((doc) => doc.path === "docs/architecture.md")?.text ?? "";
      const unlisted = files.filter((name) => !architecture.includes(`adr/${name}`));

      expect(unlisted).toEqual([]);
    });
  });

  describe("metrics", () => {
    it("has a producer for every metric it declares", async () => {
      // A metric declared in the catalog but never referenced is a series that
      // silently never appears on /metrics — you go looking for it during an
      // incident and it is simply not there.
      //
      // Scope, stated honestly: this catches "declared but never referenced".
      // It does not catch "referenced only from a function nobody calls", which
      // is what actually went wrong with bot_database_pool_connections —
      // publishPoolMetrics existed and no one invoked it. Catching that needs
      // call-graph analysis, which is not worth it here.
      const catalog = await readFile(join(ROOT, "src/platform/metrics/metrics.catalog.ts"), "utf8");
      const declared = [...catalog.matchAll(/^ {2}(\w+): (?:counter|gauge|histogram)\(/gm)].map(
        (match) => match[1] ?? "",
      );

      expect(declared.length).toBeGreaterThan(5);

      const sources = await readSourceText();
      const unused = declared.filter((name) => !sources.includes(`Metric.${name}`));

      expect(unused).toEqual([]);
    });
  });

  describe("feature groups", () => {
    it("has a directory for every group the scaffolder offers", async () => {
      const scaffolder = await readFile(join(ROOT, "scripts/new-feature.ts"), "utf8");
      const groups = [...scaffolder.matchAll(/^ {2}(\w+):\s*"/gm)].map((m) => m[1] ?? "");

      expect(groups.length).toBeGreaterThan(0);

      const missing = groups.filter((group) => !existsSync(join(ROOT, "src", "features", group)));

      expect(missing).toEqual([]);
    });

    it("has no feature directory outside a known group", async () => {
      const entries = await readdir(join(ROOT, "src", "features"), { withFileTypes: true });
      const groups = new Set(["guild", "user", "bot", "owner"]);

      const unexpected = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => !groups.has(name));

      expect(unexpected).toEqual([]);
    });
  });
});
