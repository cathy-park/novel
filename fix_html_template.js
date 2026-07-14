const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

const startIndex = js.indexOf('let html = `<!DOCTYPE html>');
const endIndex = js.indexOf('</html>`;', startIndex);

if (startIndex !== -1 && endIndex !== -1) {
  let oldHtmlBlock = js.substring(startIndex, endIndex + 9);
  // Using string literal properly without evaluating inside Node script
  let newHtmlBlock = oldHtmlBlock.replace(
    '</style>\n</head>\n<body>\n${bodyContentHTML}\n${srcdocScripts}\n</body>\n</html>`;',
    '</style>\n${srcdocScripts}\n</head>\n<body>\n${bodyContentHTML}\n</body>\n</html>`;'
  );
  js = js.substring(0, startIndex) + newHtmlBlock + js.substring(endIndex + 9);
  fs.writeFileSync('app.js', js);
  console.log('HTML template fixed!');
} else {
  console.log('HTML template not found.');
}
