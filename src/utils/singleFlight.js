// Coalesce timer ticks while a previous asynchronous cycle is still running.
export function singleFlight(work) {
  let running = null;
  return (...args) => {
    if (running) return running;
    running = Promise.resolve().then(() => work(...args)).finally(() => { running = null; });
    return running;
  };
}
