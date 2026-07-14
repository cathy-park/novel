const fs = require('fs');

const js = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const fullText = html + '\n' + js;

// Find all function declarations: `function foo(...)`
const funcRegex = /function\s+([a-zA-Z0-9_$]+)\s*\(/g;
let match;
const funcs = new Set();
while ((match = funcRegex.exec(js)) !== null) {
  funcs.add(match[1]);
}

const deadFuncs = [];
for (const fn of funcs) {
  // Count occurrences of the function name
  const regex = new RegExp('\\b' + fn + '\\b', 'g');
  const matches = fullText.match(regex);
  // If count is exactly 1 (the declaration itself), it's dead!
  if (matches && matches.length === 1) {
    deadFuncs.push(fn);
  }
}

console.log('Dead JS Functions:', deadFuncs.join(', '));
