'use strict';
// Helper to fill config/userMap.json: prints Xero project users and projects with their ids.
// Run after `npm run auth`:  node src/list-users.js
const xero = require('./xero');

(async () => {
  try {
    const [users, projects] = await Promise.all([xero.getProjectUsers(), xero.getProjects()]);
    console.log('\n=== Project users (xeroUserId) ===');
    users.forEach((u) => console.log(`  ${u.userId}  ${u.name}  <${u.email || ''}>`));
    console.log('\n=== Projects (projectId) ===');
    projects.forEach((p) => console.log(`  ${p.projectId}  ${p.name}  [${p.status}]`));
    console.log('');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
