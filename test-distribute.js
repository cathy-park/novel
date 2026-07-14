const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('index.html', 'utf8');
const safeHtml = html.replace(/<script src="[^"]+"><\/script>/g, '');

const dom = new JSDOM(safeHtml, { runScripts: "dangerously" });
const window = dom.window;

window.showToast = console.log;
window.alert = console.error;

const project = {
  id: 1, 
  episodes: [{id: 'ep1', title: '1화', plan: '', body: '', type: 'chapter'}],
  planSections: [
    {id: 'sec1', type: 'beatsheet', title: '비트시트', body: '## 1화\n내용1\n\n## 2화\n내용2'}
  ]
};

window.state = { 
  projects: [project], 
  selectedProjectId: 1 
};
window.currentProject = () => window.state.projects[0];
window.currentEpisode = () => window.state.projects[0].episodes[0];

try {
  window.distributeBeatSheet('sec1');
  console.log("Success! Project episodes:", project.episodes.map(e => e.title));
} catch (e) {
  console.error("Error:", e.stack);
}
