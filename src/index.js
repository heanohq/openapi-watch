import { run } from './main.js';

run().catch((err) => {
  console.log(`::error::${String(err.message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exitCode = 1;
});
