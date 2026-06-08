'use strict';
const fs = require('fs');
const config = require('./config');
const mockData = require('./mockData');

// userMap.json shape:
// {
//   "users": [
//     {
//       "teamsId": "aad-object-id-or-upn",
//       "email": "priya@process-x.com.au",
//       "name": "Priya",
//       "xeroUserId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
//       "allowedProjectIds": ["<projectId>", "<projectId>"]
//     }
//   ]
// }

let _cache = { at: 0, data: null };

function load() {
  if (_cache.data && Date.now() - _cache.at < 30 * 1000) return _cache.data;
  let parsed = { users: [] };
  // Prefer USER_MAP_JSON env (e.g. App Service setting) over the file, so the team list
  // can be edited without redeploying.
  if (config.agent.userMapJson) {
    try { parsed = JSON.parse(config.agent.userMapJson); } catch { parsed = { users: [] }; }
  } else {
    try { parsed = JSON.parse(fs.readFileSync(config.agent.userMapFile, 'utf8')); } catch { parsed = { users: [] }; }
  }
  if (!Array.isArray(parsed.users)) parsed.users = [];
  _cache = { at: Date.now(), data: parsed };
  return parsed;
}

// Resolve a person by Teams id, UPN, or email (case-insensitive).
function resolveUser(identity) {
  if (!identity) return null;
  const id = String(identity).toLowerCase();
  const { users } = load();
  const found = users.find(
    (u) =>
      (u.teamsId && u.teamsId.toLowerCase() === id) ||
      (u.email && u.email.toLowerCase() === id) ||
      (u.upn && u.upn.toLowerCase() === id)
  );
  if (found) return found;
  // In mock mode, fall back to a default user so the flow works without a configured map.
  if (config.xero.mock) return { ...mockData.defaultUser, email: String(identity) };
  return null;
}

function allUsers() {
  return load().users;
}

module.exports = { resolveUser, allUsers };
