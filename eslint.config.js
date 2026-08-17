import js from "@eslint/js";
import checkFile from "eslint-plugin-check-file";
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

/**
 * Lint is one half of the architecture harness. It owns the checks that benefit
 * from instant in-editor feedback:
 *
 *   - forbidden package imports (discord.js, drivers, process.env)
 *   - filename and folder conventions
 *   - symbol naming
 *   - import ordering
 *   - file size ceilings
 *
 * The other half — layer edges, same-feature isolation, and cycles — lives in
 * .dependency-cruiser.cjs, which can express "this feature may only import
 * itself" via capture groups. Neither tool duplicates the other.
 *
 * See docs/architecture.md § "How the rules are enforced".
 */

/** Packages that must never appear outside their designated directory. */
const DISCORD_PACKAGES = ["discord.js", "@discordjs/*"];
const DRIVER_PACKAGES = ["pg", "pg-*", "ioredis", "undici"];

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".devdb/**"],
  },

  js.configs.recommended,

  // Type-aware rules only apply to TypeScript sources. Config files such as
  // this one are plain JS and are not part of the TS program, so applying
  // type-checked rules to them fails at load time.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts"],
  })),

  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "import-x": importX,
      "check-file": checkFile,
    },
    rules: {
      // ── Correctness ────────────────────────────────────────────────────────
      // The highest-value rule in the set: an unawaited promise in an event
      // handler is silent in development and a lost interaction in production.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // tsconfig already reports these via noUnusedLocals / noUnusedParameters;
      // reporting them twice is noise, not safety.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",

      // ── Import hygiene ─────────────────────────────────────────────────────
      "import-x/no-duplicates": "error",
      "import-x/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          pathGroups: [
            { pattern: "#app/**", group: "internal", position: "before" },
            { pattern: "#platform/**", group: "internal", position: "before" },
            { pattern: "#discord/**", group: "internal", position: "before" },
            { pattern: "#features/**", group: "internal", position: "before" },
            { pattern: "#shared/**", group: "internal", position: "before" },
            { pattern: "#testing/**", group: "internal", position: "before" },
          ],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      // TypeScript resolves imports; a second resolver only adds a second way
      // to be wrong about the same thing.
      "import-x/no-unresolved": "off",

      // ── File and folder conventions (docs/conventions.md) ──────────────────
      "check-file/folder-naming-convention": [
        "error",
        { "src/**/": "KEBAB_CASE", "scripts/**/": "KEBAB_CASE", "tests/**/": "KEBAB_CASE" },
      ],
      "check-file/filename-naming-convention": [
        "error",
        { "**/*.ts": "KEBAB_CASE" },
        // Role suffixes are middle extensions: ticket.entity.ts, close-ticket.usecase.ts.
        { ignoreMiddleExtensions: true },
      ],
      // Grab-bag filenames and barrel files. A name that does not say what the
      // file is guarantees the file becomes whatever is convenient; barrels
      // hide dependencies and create cycles. The suggestion is a glob, so the
      // reasoning lives in docs/conventions.md.
      "check-file/filename-blocklist": [
        "error",
        {
          "**/utils.ts": "*.<role>.ts",
          "**/util.ts": "*.<role>.ts",
          "**/helpers.ts": "*.<role>.ts",
          "**/helper.ts": "*.<role>.ts",
          "**/misc.ts": "*.<role>.ts",
          "**/common.ts": "*.<role>.ts",
          "**/index.ts": "*.<role>.ts",
          "**/types.ts": "*.types.ts",
          "**/constants.ts": "*.constants.ts",
        },
      ],

      // ── Size ceilings ──────────────────────────────────────────────────────
      // Not aesthetics: a file outgrowing its ceiling is the earliest reliable
      // signal that something belongs in another layer.
      "max-lines": ["warn", { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── discord.js containment (RULE 1) ────────────────────────────────────────
  // The single most important rule in the codebase. Feature code — including
  // its Discord-facing adapter — speaks the contracts in src/discord/contracts,
  // never the library itself.
  {
    files: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    // tests/ mirrors src/, so tests/discord tests the one layer allowed to use
    // the library and may name its types. Everywhere else the ban is absolute.
    ignores: ["src/discord/**", "tests/discord/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: DISCORD_PACKAGES,
              message:
                "discord.js may only be imported inside src/discord/. Use the contracts in #discord/contracts instead — see docs/architecture.md RULE 1.",
            },
          ],
        },
      ],
    },
  },

  // ── Driver containment (RULE 3) ────────────────────────────────────────────
  // Database and cache drivers belong to platform/ and to feature
  // infrastructure/. A use case that imports `pg` has stopped being testable.
  {
    files: ["src/features/*/*/domain/**/*.ts", "src/features/*/*/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...DISCORD_PACKAGES, ...DRIVER_PACKAGES],
              message:
                "Domain and api layers must not import drivers or discord.js. Depend on a port instead — see docs/architecture.md RULE 3.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/*/*/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...DISCORD_PACKAGES, ...DRIVER_PACKAGES],
              message:
                "Use cases must depend on ports, not drivers. Put the implementation in infrastructure/ — see docs/architecture.md RULE 3.",
            },
          ],
        },
      ],
    },
  },

  // ── process.env containment (RULE 6) ───────────────────────────────────────
  // Configuration is read once, validated once, and typed. A stray process.env
  // read is a variable nobody documented and nobody validates.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/platform/config/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "process.env is read only in src/platform/config/. Add the variable to the config schema and .env.example — see docs/architecture.md RULE 6.",
        },
      ],
    },
  },

  // ── Layer-specific size ceilings ───────────────────────────────────────────
  {
    files: ["src/features/*/*/application/**/*.usecase.ts"],
    rules: {
      "max-lines": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ["src/features/*/*/api/**/*.command.ts"],
    rules: {
      "max-lines": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
    },
  },

  // ── Domain purity ──────────────────────────────────────────────────────────
  // Domain code is pure: no I/O, no clock, no randomness. Time and identity
  // arrive as arguments so tests are deterministic without fakes.
  {
    files: ["src/features/*/*/domain/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Date",
          message: "Domain code must receive time as an argument. Inject a Clock port.",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "NewExpression[callee.name='Date']",
          message: "Domain code must receive time as an argument. Inject a Clock port.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: "Domain code must be deterministic. Pass generated ids in as arguments.",
        },
      ],
    },
  },

  // ── Tests and tooling ──────────────────────────────────────────────────────
  {
    files: ["**/*.test.ts", "tests/**/*.ts", "scripts/**/*.ts", "*.config.ts"],
    rules: {
      "max-lines": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Scripts are the one place a console is the correct output device.
      "no-console": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      // Everything else logs through the Logger port, which carries correlation
      // context a bare console.log cannot.
      "no-console": "error",
    },
  },
);
