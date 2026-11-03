import { heartbeatIsFresh } from './heartbeat.js';

/**
 * Container healthcheck (`node dist/health.js`): exits 0 while the running
 * bot keeps its heartbeat fresh, i.e. while it is connected to Discord.
 * Needs no configuration, no port and no network.
 */
if (await heartbeatIsFresh()) {
  process.exit(0);
} else {
  console.error('No recent heartbeat: the bot is starting or not connected to Discord');
  process.exit(1);
}
