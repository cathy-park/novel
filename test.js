const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "dangerously" });
const script = fs.readFileSync('app.js', 'utf8');
try {
  dom.window.eval(script);
  console.log("Evaluation successful");
} catch(e) {
  console.error("Evaluation error:", e);
}
