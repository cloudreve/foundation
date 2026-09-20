import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import type { Linter } from "eslint";
import globals from "globals";
import tseslint from "typescript-eslint";

export const ignores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.artifacts/**",
  "**/.runtime/**",
  "**/vendor/**",
];

export const forbiddenSdkGlobals = [
  "globalThis",
  "self",
  "global",
  "require",
  "eval",
  "Function",
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "XMLHttpRequest",
  "process",
  "Buffer",
  "Bun",
  "Deno",
];

const ambientSelectors = forbiddenSdkGlobals.flatMap((name) => [
  {
    selector: `VariableDeclaration[declare=true] > VariableDeclarator > Identifier[name='${name}']`,
    message: `Portable SDK must not declare ambient platform global ${name}.`,
  },
  {
    selector: `TSDeclareFunction > Identifier[name='${name}']`,
    message: `Portable SDK must not declare ambient platform function ${name}.`,
  },
]);

/** Baseline rules for Node.js tools and TypeScript test suites. */
export const nodeConfig: Linter.Config[] = [
  { ignores },
  js.configs.recommended,
  ...(tseslint.configs.recommended as Linter.Config[]),
  {
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  { files: ["**/*.ts", "**/*.tsx"], rules: { "no-undef": "off" } },
  {
    files: ["tests/**", "**/tests/**", "**/__tests__/**", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

/** Baseline rules plus explicit platform boundaries for portable SDK source. */
export const sdkConfig: Linter.Config[] = [
  ...nodeConfig,
  {
    files: ["src/**/*.ts"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "no-restricted-globals": [
        "error",
        {
          globals: forbiddenSdkGlobals,
          checkGlobalObject: true,
          globalObjects: ["global"],
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "react",
                "react-native",
                "expo",
                "expo-*",
                "@cloudreve/quality",
                "@cloudreve/quality/*",
                "@cloudreve/testkit",
                "@cloudreve/testkit/*",
              ],
              message: "SDK runtime imports must remain portable.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...ambientSelectors],
    },
  },
];

/** Enforce explicit control flow and modern JavaScript declarations. */
export const modernJavaScript: Linter.Config = {
  name: "cloudreve/modern-javascript",
  linterOptions: { reportUnusedDisableDirectives: "error" },
  rules: {
    curly: ["error", "all"],
    eqeqeq: ["error", "always", { null: "ignore" }],
    "no-var": "error",
    "one-var": ["error", "never"],
    "prefer-const": "error",
    "object-shorthand": "error",
  },
};

/** Separate logical sections without changing expression layout owned by Prettier. */
export const structuralSpacing: Linter.Config = {
  name: "cloudreve/structural-spacing",
  plugins: { "@stylistic": stylistic },
  rules: {
    "@stylistic/padding-line-between-statements": [
      "error",
      { blankLine: "always", prev: "*", next: ["const", "let", "var"] },
      { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
      { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
      {
        blankLine: "always",
        prev: "*",
        next: ["return", "throw", "if", "for", "while", "do", "switch", "try"],
      },
      {
        blankLine: "always",
        prev: ["block-like", "multiline-expression", "multiline-const", "multiline-let"],
        next: "*",
      },
      {
        blankLine: "always",
        prev: "*",
        next: ["multiline-expression", "multiline-const", "multiline-let"],
      },
      {
        blankLine: "always",
        prev: ["function", "class", "interface", "type", "enum", "export"],
        next: "*",
      },
      {
        blankLine: "always",
        prev: "*",
        next: ["function", "class", "interface", "type", "enum", "export"],
      },
      {
        blankLine: "always",
        prev: {
          selector:
            "VariableDeclaration:has(VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression))",
        },
        next: "*",
      },
      {
        blankLine: "always",
        prev: "*",
        next: {
          selector:
            "VariableDeclaration:has(VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression))",
        },
      },
      { blankLine: "any", prev: "function-overload", next: ["function-overload", "function"] },
      { blankLine: "always", prev: "import", next: "*" },
      { blankLine: "any", prev: "import", next: "import" },
    ],
    "@stylistic/lines-between-class-members": [
      "error",
      {
        enforce: [
          { blankLine: "always", prev: "*", next: "method" },
          { blankLine: "always", prev: "method", next: "*" },
        ],
      },
      { exceptAfterOverload: true },
    ],
    "@stylistic/lines-around-comment": [
      "error",
      {
        beforeBlockComment: true,
        beforeLineComment: true,
        allowBlockStart: true,
        allowClassStart: true,
        allowObjectStart: true,
        allowArrayStart: true,
        allowInterfaceStart: true,
        allowTypeStart: true,
      },
    ],
    "@stylistic/no-multiple-empty-lines": ["error", { max: 1, maxBOF: 0, maxEOF: 0 }],
  },
};

/** Enable promise and import checks using the consuming project’s TypeScript configuration. */
export function createTypedConfig(rootDir: string): Linter.Config {
  return {
    name: "cloudreve/typed-correctness",
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
    },
  };
}
