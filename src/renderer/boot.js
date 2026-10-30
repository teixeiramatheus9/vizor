// Classic script, first thing in <body>: copies the density/theme/palette the
// main process put on the URL onto <body> before anything paints. Values are
// whitelisted in main (workspace-boot.js); onState keeps them current later.
(() => {
  const params = new URLSearchParams(location.search);
  for (const key of ['density', 'theme', 'palette']) {
    const value = params.get(key);
    if (value && /^[a-z0-9-]{1,24}$/i.test(value)) document.body.dataset[key] = value;
  }
})();
