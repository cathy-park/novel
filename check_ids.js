const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const idRegex = /\$\('#([^']+)'\)/g;
let match;
while ((match = idRegex.exec(html)) !== null) {
  const id = match[1];
  if (!html.includes('id="' + id + '"')) {
    console.log("MISSING ID:", id);
  }
}
