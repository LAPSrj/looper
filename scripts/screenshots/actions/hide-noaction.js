// Turns on View → Task Logs → Hide Runs with No Action.
(async () => {
  const info = await window.looper.info();
  const s = await window.looper.updateSettings({ view: { ...info.settings.view, hideNoActionRuns: true } });
  await new Promise((r) => setTimeout(r, 1500));
  return s.view.hideNoActionRuns;
})()
