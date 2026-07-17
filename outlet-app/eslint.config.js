import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "supabase/**"],
  },
  {
    files: ["src/client/**/*.ts"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        console: "readonly",
        Tesseract: "readonly",
        XLSX: "readonly",
        FileReader: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLFormElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLLabelElement: "readonly",
        FileList: "readonly",
        Response: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["src/server/**/*.ts", "*.config.ts"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs", "tests/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        Request: "readonly",
        Response: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  }
);
