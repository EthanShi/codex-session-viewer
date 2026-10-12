import { assertSupportedRuntime } from "./lib/runtime.mjs";

try {
  await assertSupportedRuntime();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
