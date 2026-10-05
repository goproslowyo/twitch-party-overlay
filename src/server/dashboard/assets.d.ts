/**
 * The Dashboard ships two assets through Bun's text imports (`import x from "./file" with { type: "text" }`), so
 * `bun build --compile` embeds them in the binary. Bun resolves them at runtime; tsc needs their module shape.
 */
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.js" {
  const text: string;
  export default text;
}
