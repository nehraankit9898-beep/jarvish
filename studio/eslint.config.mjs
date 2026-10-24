import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Flat config: a rule that references a plugin only works where that plugin is
// registered. `eslint-config-next` registers `react` / `react-hooks` /
// `@next/next` ONLY for `**/*.{js,jsx,mjs,ts,tsx,mts,cts}` (`.cjs` is missing
// from that list) and `@typescript-eslint` globally.
//
// The previous single override block therefore broke `npm run lint` outright:
// ESLint's default flat-config file set includes `scripts/custom-tool-runner.cjs`,
// the `react-hooks/set-state-in-effect` override applied to it, the plugin
// resolved to `undefined` and ESLint aborted with
//   "could not find plugin 'react-hooks'"
// before reporting a single real problem. The overrides are now split per
// plugin family so every file that the config touches has its plugins defined.
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Rules from plugins that eslint-config-next registers for this file set.
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      // React rules
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/purity": "off",
      // eslint-config-next 16 ships the react-hooks v6 compiler rules. This
      // codebase uses the classic "load in an effect, then setState" pattern in
      // ~40 panels; the rule is a perf hint, not a bug, so it stays visible as a
      // warning instead of failing `npm run lint`.
      "react-hooks/set-state-in-effect": "warn",
      "react/no-unescaped-entities": "off",
      "react/display-name": "off",
      "react/prop-types": "off",
      "react-compiler/react-compiler": "off",

      // Next.js rules
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    // Plugin-free (core ESLint) rules — safe for every linted file, including
    // the CommonJS scripts.
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    rules: {
      "prefer-const": "off",
      "no-unused-vars": "off",
      "no-console": "off",
      "no-debugger": "off",
      "no-empty": "off",
      "no-irregular-whitespace": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "no-mixed-spaces-and-tabs": "off",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-unreachable": "off",
      "no-useless-escape": "off",
    },
  },
  {
    // TypeScript-only rules — `@typescript-eslint` is registered globally by
    // eslint-config-next/typescript, the same file set it targets.
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/prefer-as-const": "off",
      "@typescript-eslint/no-unused-disable-directive": "off",
    },
  },
  {
    // CommonJS scripts are loaded with require() by design — the custom-tool
    // runner is spawned as a plain .cjs child process so it stays outside the
    // Next.js module graph.
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "examples/**",
      "skills",
      "upload/**",
      "tool-results/**",
      "download/**",
      // sandbox-only helpers, never part of the deliverable
      "prisma.config.local.ts",
      ".agentic-workspace/**",
    ],
  },
];

export default eslintConfig;
