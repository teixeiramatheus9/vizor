import { renderSidebar, renderTopBar } from './workspace-view.js';

const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');
let selectedId = null;
let lastTree = null;

function render() {
  if (!lastTree) return;
  topbar.innerHTML = renderTopBar(lastTree);
  sidebar.innerHTML = renderSidebar(lastTree, selectedId);
}

window.vizor.onState(({ tree, theme, palette }) => {
  if (theme) document.body.dataset.theme = theme;
  if (palette) document.body.dataset.palette = palette;
  lastTree = tree;
  render();
});

document.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-project]');
  if (remove) {
    window.vizor.removeProject(remove.dataset.removeProject);
    return;
  }
  if (event.target.closest('[data-add-project]')) {
    window.vizor.addProject();
    return;
  }
  const row = event.target.closest('[data-session]');
  if (row) {
    selectedId = row.dataset.session;
    render();
  }
});
