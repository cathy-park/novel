const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<div><p>검은 재킷도 벗지 않은 채였다.</p><p><br></p><p>셔츠의 가장 위 단추만 풀려 있었다.</p></div>`);
const div = dom.window.document.querySelector('div');

let emptyNodes = [];
Array.from(div.children).forEach(child => {
  if (child.tagName === 'P' && !child.textContent.trim() && !child.querySelector('img')) {
    emptyNodes.push(child);
  } else {
    if (emptyNodes.length === 1) {
      emptyNodes[0].remove();
    } else if (emptyNodes.length > 1) {
      for (let i = 1; i < emptyNodes.length; i++) {
        emptyNodes[i].remove();
      }
    }
    emptyNodes = [];
  }
});
emptyNodes.forEach(node => node.remove());

console.log(div.innerHTML);
