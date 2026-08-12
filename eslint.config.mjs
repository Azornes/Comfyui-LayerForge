import js from "@eslint/js";
import globals from "globals";

export default [
  {
    files: ["js/**/*.js", "tests/**/*.{js,mjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        // ComfyUI globals available at runtime.
        app: "readonly",
        api: "readonly",
        ComfyApp: "readonly",
        LiteGraph: "readonly",
        LGraphCanvas: "readonly",
        $el: "readonly",
        ChangeTracker: "readonly",
        MaskEditorDialog: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-self-assign": "error",
      "no-self-compare": "error",
      "eqeqeq": ["warn", "smart"],
      "no-var": "warn",
      "prefer-const": ["warn", { destructuring: "all" }],
      "no-shadow": "off",
      "no-throw-literal": "warn",
      "no-useless-escape": "warn",
      "no-prototype-builtins": "off",
      "no-case-declarations": "off",
    },
  },
  {
    ignores: [
      "node_modules/",
      "__pycache__/",
      "src/",
      ".git/",
    ],
  },
];
