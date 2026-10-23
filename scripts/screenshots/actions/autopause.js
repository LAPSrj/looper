// Fails Support inbox sweep's check five times in a row, so it shows as auto-paused.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rt = async () => (await window.looper.runtime.list()).find((r) => r.taskId === 'inbox-sweep');
  for (let i = 0; i < 5; i++) {
    await window.looper.runtime.runNow('inbox-sweep');
    await sleep(500);
    for (let j = 0; j < 120 && (await rt()).runs.length > 0; j++) await sleep(500);
  }
  const r = await rt();
  return [r.state, r.pausedReason, r.consecutiveErrors];
})()
