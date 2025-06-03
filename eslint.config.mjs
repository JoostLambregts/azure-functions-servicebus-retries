import tseslint from 'typescript-eslint';

const tsFiles = ["src/**/*.ts", "src/**/*.tsx"]

export default [
{ ignores: [
  "**/coverage",
  "**/node_modules",
  "**/dist", 
  "vitest.config.ts",
  "**/*.d.ts",
  "*.js"
] },
...tseslint.configs.recommended, 
{
    files: tsFiles,
    languageOptions: {
        parserOptions: {
            project: "./tsconfig.json",
        },
    },

    rules: {
        "@typescript-eslint/strict-boolean-expressions": ["error", {
            allowString: false,
            allowNumber: false,
            allowNullableObject: false,
            allowNullableBoolean: false,
            allowNullableString: false,
            allowNullableNumber: false,
            allowAny: false,
        }],

        indent: ["error", 2, {
            SwitchCase: 1,
        }],

        "no-trailing-spaces": ["error"],
        quotes: ["error", "single"],
        semi: ["error", "never"],
    },
}];