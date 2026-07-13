const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');

const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("error", (e) => {
  console.log("JSDOM ERROR:", e.message || e);
});
virtualConsole.on("jsdomError", (e) => {
  if (!e.message.includes("createClient") && !e.message.includes("document.execCommand")) {
    console.log("JSDOM jsdomError:", e.message || e);
  }
});

try {
  const dom = new JSDOM(html, { 
    url: 'http://localhost',
    runScripts: "dangerously",
    virtualConsole 
  });
} catch(e) {
  console.log("TOP LEVEL ERROR:", e);
}
setTimeout(() => {
  console.log("DONE");
}, 1000);
