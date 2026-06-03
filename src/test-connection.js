'use strict';
// Verify the Xero org connection: scopes, project/task reads, and project users.
// Run after `npm run auth`:  npm run test:xero
const xero = require('./xero');
const store = require('./store');

(async () => {
  console.log(`Storage backend: ${store.backend}`);
  try {
    const projects = await xero.getProjects();
    console.log(`\nPASS - connected. ${projects.length} project(s):`);
    for (const p of projects) {
      console.log(`  • ${p.name}  [${p.status}]  projectId=${p.projectId}`);
      const tasks = await xero.getTasks(p.projectId);
      for (const t of tasks) console.log(`        - ${t.name}  taskId=${t.taskId}`);
    }

    const users = await xero.getProjectUsers();
    console.log(`\nPASS - ${users.length} project user(s) (use xeroUserId in config/userMap.json):`);
    for (const u of users) console.log(`  • ${u.name}  <${u.email || ''}>  xeroUserId=${u.userId}`);

    console.log('\n✅ Connection verified. You have the project/task/user IDs needed for the user map.');
  } catch (err) {
    console.error('\n❌ FAIL -', err.message);
    console.error('Run `npm run auth` first (as a Standard/Adviser user), and check .env scopes/redirect URI.');
    process.exit(1);
  }
})();
