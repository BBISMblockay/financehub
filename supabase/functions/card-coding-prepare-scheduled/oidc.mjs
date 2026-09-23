import { createRemoteJWKSet, jwtVerify } from 'npm:jose@6.2.12';

const issuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`));
const repository = 'BBISMblockay/financehub';
const repositoryId = '1110494889';
const ownerId = '227868936';
// The two workflows that prepare coding: after each bank feed sync, and the
// nightly catch-up. Nothing else -- not a PR, not a fork, not another job on
// main -- may spend model calls on a company's transactions.
export const WORKFLOWS = [
  `${repository}/.github/workflows/plaid-sync.yml@refs/heads/main`,
  `${repository}/.github/workflows/card-coding-prepare.yml@refs/heads/main`,
];

export async function verifySchedulerIdentity(token, audience, verificationKeys = keys) {
  const { payload } = await jwtVerify(token, verificationKeys, {
    issuer, audience, algorithms: ['RS256'], maxTokenAge: '10m',
    requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'jti'], clockTolerance: 5,
  });
  const subjects = [
    `repo:${repository}:ref:refs/heads/main`,
    `repo:BBISMblockay@${ownerId}/financehub@${repositoryId}:ref:refs/heads/main`,
  ];
  if (!subjects.includes(payload.sub) || payload.repository !== repository ||
      payload.repository_id !== repositoryId || payload.repository_owner_id !== ownerId ||
      payload.ref !== 'refs/heads/main' || payload.ref_type !== 'branch' ||
      !WORKFLOWS.includes(payload.workflow_ref) ||
      !['schedule', 'workflow_dispatch'].includes(payload.event_name) ||
      payload.runner_environment !== 'github-hosted') throw new Error('scheduler_identity_rejected');
  return payload;
}
