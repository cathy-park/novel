const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');
const safeHtml = html.replace(/<script src="[^"]+"><\/script>/g, '');

const dom = new JSDOM(safeHtml, { runScripts: "dangerously" });
const window = dom.window;

window.showToast = console.log;
window.state = { 
  projects: [{
    id: 1, 
    planSections: [
      {id: '1', title: 'sec 1', body: 'body 1', type: 'text', open: true},
      {id: '2', title: 'sec 2', body: 'body 2', type: 'text', open: false}
    ]
  }], 
  selectedProjectId: 1 
};
window.currentProject = () => window.state.projects[0];
window.currentEpisode = () => ({id: 1, title: 'ep', body: ''});
window.episodeScrollState = new Map();

try {
  window.togglePlanDrawer();
  console.log("togglePlanDrawer success");
} catch (e) {
  console.error("Error calling togglePlanDrawer:", e.stack);
}
