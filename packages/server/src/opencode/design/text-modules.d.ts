// Text files embedded by the native plugin build's loaders (`native-plugin-build.mjs`).
declare module "*.md" {
  const text: string
  export default text
}

declare module "*.txt" {
  const text: string
  export default text
}
