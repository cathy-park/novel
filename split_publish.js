const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

// The POD logic starts roughly around `// =====================================================`
// `// POD Studio & Paged.js`
const podStartMarker = '// =====================================================\n// POD Studio';
const podStartIndex = js.indexOf('// =====================================================');
if (podStartIndex !== -1) {
  // Wait, let's find the exact index.
  const lines = js.split('\n');
  let podStartLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('POD Studio & Paged.js')) {
      podStartLine = i - 1; // get the '=============' line
      break;
    }
  }
  if (podStartLine !== -1) {
    let publishJsLines = lines.splice(podStartLine);
    fs.writeFileSync('app.js', lines.join('\n'));
    fs.writeFileSync('publish.js', publishJsLines.join('\n'));
    
    let html = fs.readFileSync('index.html', 'utf8');
    html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>\n<script src="publish.js"></script>');
    fs.writeFileSync('index.html', html);
    console.log('Publish logic extracted successfully!');
  } else {
    console.log('Marker not found');
  }
}
