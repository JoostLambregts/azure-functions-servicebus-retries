import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default [
  {
    input: "src/main.ts",
    output: [
      {
        file: "dist/main.cjs",
        format: "cjs"
      },
      {
        file: "dist/main.mjs",
        format: "esm"
      },
      {
        file: "dist/main.js",
        format: "esm",
        banner: "// @ts-self-types=\"./main.d.ts\""
      }
    ],
    plugins: [
    typescript({ tsconfig: './tsconfig.json' }), nodeResolve()],
    external: [/node_modules/]
  }
];