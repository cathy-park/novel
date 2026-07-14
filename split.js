const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Extract CSS
const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>', styleStart);
if (styleStart !== -1 && styleEnd !== -1) {
  const css = html.substring(styleStart + 7, styleEnd).trim();
  fs.writeFileSync('style.css', css);
  html = html.substring(0, styleStart) + '<link rel="stylesheet" href="style.css">' + html.substring(styleEnd + 8);
}

// 2. Extract Main JS
// Find the last <script> tag which contains the main logic.
const scripts = html.match(/<script>(.*?)<\/script>/gs);
if (scripts && scripts.length >= 2) {
  // The last script block is the main one.
  const mainScriptMatch = scripts[scripts.length - 1];
  const jsStart = html.lastIndexOf(mainScriptMatch);
  if (jsStart !== -1) {
    const jsContent = mainScriptMatch.replace(/^<script>/, '').replace(/<\/script>$/, '').trim();
    fs.writeFileSync('app.js', jsContent);
    html = html.substring(0, jsStart) + '<script src="app.js"></script>' + html.substring(jsStart + mainScriptMatch.length);
  }
}

fs.writeFileSync('index.html', html);
console.log('Split completed!');
