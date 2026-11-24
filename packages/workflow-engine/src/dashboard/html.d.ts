// The dashboard page is one self-contained HTML file, bundled as a string by the `.html` text loader.
declare module '*.html' {
  const html: string;
  export default html;
}
