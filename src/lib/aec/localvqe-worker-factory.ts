/** Create the Step 3 engine worker. It is intentionally not wired into the mic path. */
export const createLocalVqeWorker = (): Worker =>
  new Worker(new URL("./localvqe-worker.ts", import.meta.url), {
    type: "module",
  });
