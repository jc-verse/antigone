import jcRules from "eslint-config-jc";
import { defineConfig } from "eslint/config";

export default defineConfig(
  {
    ignores: [
      "build/**",
      "**/build/**",
      ".vite/**",
      "**/.vite/**",
      ".secrets/**",
    ],
  },
  ...jcRules({
    react: ["**/*.tsx"],
    typescriptTypeCheck: ["**/*.ts", "**/*.tsx"],
  }),
  {
    rules: {
      // The server dynamically loads Vite only in development.
      "import-x/no-extraneous-dependencies": [
        "error",
        {
          bundledDependencies: false,
          devDependencies: ["**/*.config.{js,ts}", "**/server.ts"],
          optionalDependencies: false,
          peerDependencies: true,
        },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
