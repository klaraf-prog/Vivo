'use strict';
// Lists Firebase Auth users with their studioRole custom claim.
// Editor: read-only. Superadmin: can also change roles via studio-set-role.
const { initAdmin, verifyStudioToken, json } = require('./_studio-shared');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

  const actor = await verifyStudioToken(event.headers['authorization'], ['editor', 'superadmin']);
  if (!actor) return json(403, { error: 'Forbidden' });

  const auth = initAdmin().auth();
  const result = await auth.listUsers(1000);

  const users = result.users.map(u => ({
    uid:         u.uid,
    email:       u.email       || null,
    displayName: u.displayName || null,
    studioRole:  u.customClaims?.studioRole || null,
    createdAt:   u.metadata.creationTime
                   ? new Date(u.metadata.creationTime).getTime() : null,
    lastSignIn:  u.metadata.lastSignInTime
                   ? new Date(u.metadata.lastSignInTime).getTime() : null,
  }));

  return json(200, { users });
};
