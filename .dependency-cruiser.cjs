/**
 * Architecture enforcement.
 *
 * This file is the executable half of docs/architecture.md § "Dependency rules".
 * ESLint owns forbidden packages, filenames, and naming; dependency-cruiser owns
 * the things only a graph tool can see: layer edges, same-feature isolation, and
 * cycles.
 *
 * The `([^/]+)` capture in a rule's `from.path` is referenced as `$1` in its
 * `to` clause. That is what lets a single rule say "a feature may import itself
 * and nothing else" without listing every feature.
 *
 * Run: pnpm arch
 */

/** Layers every slice may always reach: its own pure kernel and the zero-dependency shared code. */
const SHARED = "^src/shared/";

/** Platform interfaces. Implementations live behind these and are wired in app/. */
const PLATFORM_CONTRACT = "^src/platform/[^/]+/[^/]*\\.contract\\.ts$";

/** node_modules, however the package manager happens to lay it out. */
const NODE_MODULES = "node_modules";

/**
 * Every rule below is scoped to `^src/`, and src/ holds only shipped code —
 * tests live in tests/ and never match.
 *
 * That invariant is not assumed: tests/architecture/boundaries.test.ts fails if
 * a test file appears under src/, and fails if a test loses the source file it
 * was written for.
 */

module.exports = {
  forbidden: [
    // ── Universal ────────────────────────────────────────────────────────────
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle means these modules are really one module with a false boundary. Extract the shared piece, invert a dependency, or merge them.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Nothing imports this file. Either wire it up or delete it — dead code that typechecks is the hardest kind to notice.",
      from: {
        orphan: true,
        pathNot: ["\\.d\\.ts$", "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$", "\\.config\\.(js|cjs|mjs|ts)$"],
      },
      to: {},
    },

    // ── RULE 2: domain is pure ───────────────────────────────────────────────
    {
      name: "domain-is-pure",
      severity: "error",
      comment:
        "Domain code must be testable with no database, no Discord client, no clock, and no environment. It may import its own feature's domain and src/shared only.",
      from: { path: "^src/features/([^/]+/[^/]+)/domain/" },
      to: { pathNot: ["^src/features/$1/domain/", SHARED] },
    },

    // ── RULE 3: use cases depend on ports, never implementations ─────────────
    {
      name: "application-depends-on-ports",
      severity: "error",
      comment:
        "A use case may import its own domain, its own ports, src/shared, and platform *contracts*. Importing infrastructure, api, discord, or a driver makes it untestable and couples it to a technology choice.",
      from: { path: "^src/features/([^/]+/[^/]+)/application/" },
      to: {
        pathNot: [
          "^src/features/$1/application/",
          "^src/features/$1/domain/",
          SHARED,
          PLATFORM_CONTRACT,
        ],
      },
    },

    // ── RULE 1 + 4: the api layer speaks contracts, not libraries ────────────
    {
      name: "api-speaks-contracts",
      severity: "error",
      comment:
        "A feature's Discord adapter may import its own application and domain, src/discord/contracts, src/shared, and platform contracts. It must not reach discord.js, infrastructure, or another feature.",
      from: { path: "^src/features/([^/]+/[^/]+)/api/" },
      to: {
        pathNot: [
          "^src/features/$1/api/",
          "^src/features/$1/application/",
          "^src/features/$1/domain/",
          "^src/discord/contracts/",
          SHARED,
          PLATFORM_CONTRACT,
          // Command input schemas are declared here, so validation is the one
          // external library the adapter may see.
          `${NODE_MODULES}.*[/\\\\]zod[/\\\\]`,
        ],
      },
    },

    // ── Infrastructure implements ports, and may use the platform ────────────
    {
      name: "infrastructure-implements-ports",
      severity: "error",
      comment:
        "An adapter may import its own ports and domain, the platform, the outbound Discord gateway, and src/shared. It must not import its own api layer, the Discord kernel, or another feature.",
      from: { path: "^src/features/([^/]+/[^/]+)/infrastructure/" },
      to: {
        pathNot: [
          "^src/features/$1/infrastructure/",
          "^src/features/$1/application/",
          "^src/features/$1/domain/",
          "^src/platform/",
          // Infrastructure is the layer where technology choices live, and the
          // outbound governor is one. It is deliberately narrower than all of
          // src/discord: the kernel stays off limits, and discord.js remains
          // banned by lint, so an adapter must still go through the gateway.
          "^src/discord/gateway/",
          SHARED,
          NODE_MODULES,
        ],
      },
    },

    // ── RULE 7: features are islands ─────────────────────────────────────────
    {
      name: "features-are-islands",
      severity: "error",
      comment:
        "One feature must never import another feature's internals. Cross-feature work goes through a published contract or the domain event bus, so a feature stays deletable in one directory.",
      from: { path: "^src/features/([^/]+/[^/]+)/" },
      to: { path: "^src/features/(?!$1/)[^/]+/[^/]+/" },
    },

    // ── The discord layer must not depend on features ────────────────────────
    {
      name: "discord-kernel-is-feature-agnostic",
      severity: "error",
      comment:
        "The kernel, design system, and gateway dispatch registered descriptors; they must not know which features exist. Composition belongs in src/app.",
      from: { path: "^src/discord/" },
      to: { path: "^src/features/" },
    },
    {
      name: "discord-contracts-are-standalone",
      severity: "error",
      comment:
        "src/discord/contracts is imported by feature adapters, which must stay free of discord.js. If a contract needs the library, the abstraction has leaked.",
      from: { path: "^src/discord/contracts/" },
      to: { pathNot: ["^src/discord/contracts/", SHARED] },
    },

    // ── The platform is beneath everything and knows nothing above it ────────
    {
      name: "platform-is-a-foundation",
      severity: "error",
      comment:
        "Platform code may import other platform code, src/shared, and libraries. Importing features, discord, or app would invert the dependency direction.",
      from: { path: "^src/platform/" },
      to: { pathNot: ["^src/platform/", SHARED, NODE_MODULES] },
    },

    // ── shared/ is the floor: universal and dependency-free ──────────────────
    {
      name: "shared-is-dependency-free",
      severity: "error",
      comment:
        "src/shared is imported by domain code, so it must stay pure: no platform, no libraries, no I/O. If it needs a dependency it is not shared — it is platform.",
      from: { path: SHARED },
      to: { pathNot: [SHARED] },
    },

    // ── Test doubles never reach production ──────────────────────────────────
    {
      name: "src-does-not-import-tests",
      severity: "error",
      comment:
        "src/testing holds fakes. A fake reachable from production code is a fake that will eventually run in production.",
      from: { path: "^src/", pathNot: ["^src/testing/", "\\.test\\.ts$"] },
      to: { path: "^src/testing/" },
    },

    // ── Only the composition root may wire ───────────────────────────────────
    {
      name: "only-app-composes",
      severity: "error",
      comment:
        "Feature manifests are constructed in src/app. Nothing else may import a feature's manifest, or registration order stops being knowable.",
      from: { pathNot: ["^src/app/", "^src/features/", "^tests/"] },
      to: { path: "^src/features/[^/]+/feature\\.ts$" },
    },
  ],

  options: {
    doNotFollow: { path: NODE_MODULES },
    includeOnly: "^(src|tests)/",

    // Analyse type-only imports too. A `import type` from domain to platform is
    // still an architectural dependency even though it erases at compile time.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },

    enhancedResolveOptions: {
      // Matches tsconfig `customConditions` and the dev script's --conditions,
      // so "#platform/*" resolves to src/ here exactly as it does at runtime.
      conditionNames: ["development", "import", "node", "default"],
      exportsFields: ["exports"],
      mainFields: ["module", "main", "types"],
    },

    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
