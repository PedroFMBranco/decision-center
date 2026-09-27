// esbuild's text loader turns an imported .html file into its contents.
declare module '*.html' {
  const text: string
  export default text
}
