const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

// The functions to remove: normalizeProject, mmToPreviewPx, applyFmTheme
const funcsToRemove = ['normalizeProject', 'mmToPreviewPx', 'applyFmTheme'];

funcsToRemove.forEach(fn => {
  // Regex to match `function name(...) { ... }` where it handles braces
  // Since it's hard to match exact brace depth with Regex, we will just use replace with a custom replacer.
  const regex = new RegExp(`function\\s+${fn}\\s*\\([^\\)]*\\)\\s*\\{`);
  const match = regex.exec(js);
  if (match) {
    const startIndex = match.index;
    let braceCount = 0;
    let endIndex = startIndex;
    let started = false;
    for (let i = startIndex; i < js.length; i++) {
      if (js[i] === '{') {
        braceCount++;
        started = true;
      } else if (js[i] === '}') {
        braceCount--;
      }
      if (started && braceCount === 0) {
        endIndex = i + 1;
        break;
      }
    }
    js = js.substring(0, startIndex) + js.substring(endIndex);
  }
});

fs.writeFileSync('app.js', js);
console.log('Removed dead functions.');
