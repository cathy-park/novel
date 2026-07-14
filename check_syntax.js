const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scriptRegex = /<script.*?>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  let content = match[1];
  if(content.trim()) {
    const filename = `temp_script_${count}.js`;
    fs.writeFileSync(filename, content);
    console.log(`Extracted script ${count}`);
    count++;
  }
}
