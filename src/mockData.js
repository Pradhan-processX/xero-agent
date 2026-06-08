'use strict';
// Seed data for XERO_MOCK mode — mirrors the real ProcessX Xero Projects structure
// (from the screenshots) so the whole pipeline runs without a live Xero connection.
// IDs are fake but stable, so they work in config/userMap.json too.

const projects = [
  {
    projectId: 'mock-proj-ai-clinical',
    name: 'ProcessX AI Clinical',
    status: 'INPROGRESS',
    tasks: [
      { taskId: 'mock-task-governance', name: 'Governance', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-care-persona', name: 'Care Persona', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-project-meetings', name: 'Project Meetings', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-durid-dev', name: 'Durid Development', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-project-mgmt', name: 'Project Management', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-discovery', name: 'Disovery & Business Requirements', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-unit-testing', name: 'Unit Testing', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-uat-internal', name: 'UAT - Internal PX', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-uat-client', name: 'UAT - Client', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
    ],
  },
  {
    projectId: 'mock-proj-general',
    name: 'ProcessX ProcessX General',
    status: 'INPROGRESS',
    tasks: [
      { taskId: 'mock-task-gen-admin', name: 'Admin', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-gen-meetings', name: 'Internal Meetings', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
      { taskId: 'mock-task-gen-bizdev', name: 'Business Development', status: 'ACTIVE', chargeType: 'NON_CHARGEABLE' },
    ],
  },
  {
    projectId: 'mock-proj-tranxform-dm',
    name: 'ProcessX TranXform Project (DM)',
    status: 'INPROGRESS',
    tasks: [
      { taskId: 'mock-task-dm-meetings', name: 'Project Meetings', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-dm-discovery', name: 'Discovery & Business Requirements', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-dm-development', name: 'Development', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-dm-validation', name: 'Validation', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-dm-unit-testing', name: 'Unit Testing', status: 'ACTIVE', chargeType: 'TIME' },
      { taskId: 'mock-task-dm-uat', name: 'UAT - Client', status: 'ACTIVE', chargeType: 'TIME' },
    ],
  },
];

const users = [
  { userId: 'mock-user-you', name: 'You (mock)', email: 'letschat@process-x.com.au' },
  { userId: 'mock-user-teammate', name: 'Teammate (mock)', email: 'teammate@process-x.com.au' },
];

// A default mapped user so /capture works out of the box in mock mode (all projects allowed).
const defaultUser = {
  teamsId: 'mock',
  email: 'letschat@process-x.com.au',
  name: 'You (mock)',
  xeroUserId: 'mock-user-you',
  allowedProjectIds: projects.map((p) => p.projectId),
};

module.exports = { projects, users, defaultUser };
