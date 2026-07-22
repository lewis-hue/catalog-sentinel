/**
 * Probe the configured Steel Browser connector and print a secret-safe status.
 * Exits non-zero only when Steel is required but not ready.
 */
import { probeSteelHealth } from '@sentinel/steel';

async function main(): Promise<void> {
  const health = await probeSteelHealth(process.env);
  const marker = health.status === 'READY'
    ? 'READY'
    : health.required
      ? 'FAILED'
      : 'WARNING';

  console.log(`\n[${marker}] Steel connector: ${health.status}`);
  console.log(`   mode         ${health.mode}`);
  console.log(`   required     ${health.required}`);
  console.log(`   wsl2         ${health.wsl2}`);
  console.log(`   apiUrl       ${health.apiUrl ?? '(none)'}`);
  console.log(`   loginMode    ${health.loginMode}`);
  console.log(`   liveLogin    ${health.liveLoginAvailable}`);
  console.log(`   message      ${health.message}\n`);
  process.exitCode = health.required && health.status !== 'READY' ? 1 : 0;
}

main().catch((error) => {
  console.error('probe-steel failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
