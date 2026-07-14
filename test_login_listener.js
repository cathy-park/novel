const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');
const virtualConsole = new jsdom.VirtualConsole();
let hasErrors = false;
virtualConsole.on("jsdomError", (err) => {
  if (err.stack && err.stack.includes('createClient')) return; // ignore supabase missing
  console.error("JSDOM Error:", err.stack);
  hasErrors = true;
});
virtualConsole.on("error", (err) => {
  console.error("Console Error:", err);
  hasErrors = true;
});

const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole, url: "https://novel-iota-mauve.vercel.app/" });

setTimeout(() => {
  const btn = dom.window.document.getElementById('googleLoginBtn');
  console.log("Button found:", !!btn);
  if (btn) {
    console.log("Button onclick type:", typeof btn.onclick);
  }
  process.exit(hasErrors ? 1 : 0);
}, 2000);
