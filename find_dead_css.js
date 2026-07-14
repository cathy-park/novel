const fs = require('fs');

const css = fs.readFileSync('style.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('app.js', 'utf8');
const fullText = html + '\n' + js;

// Match class names in CSS: `.className {` or `.className:` or `.className,`
const classRegex = /\.([a-zA-Z0-9_-]+)(?=[ \.\:\{,>])/g;
let match;
const cssClasses = new Set();
while ((match = classRegex.exec(css)) !== null) {
  cssClasses.add(match[1]);
}

const deadClasses = [];
for (const cls of cssClasses) {
  // Check if class exists in HTML or JS
  // It could be in class="...", classList.add("..."), or dynamically created.
  // We just check if the string exists.
  if (!fullText.includes(cls)) {
    // Also ignore classes that are part of other words, but simple include is safe enough to NOT delete if found.
    // If it's NOT found at all, it's definitely dead.
    deadClasses.push(cls);
  }
}

console.log('Dead CSS Classes:', deadClasses.join(', '));
