const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');
const virtualConsole = new jsdom.VirtualConsole();
virtualConsole.on("jsdomError", (err) => {
  console.error("JSDOM Error:", err.stack, err.detail);
});
try {
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole, url: "https://novel-iota-mauve.vercel.app/" });
  setTimeout(() => {
    console.log("getPublishSettings:", typeof dom.window.getPublishSettings);
    process.exit(0);
  }, 1000);
} catch(e) {
  console.error("Sync Error:", e);
}
