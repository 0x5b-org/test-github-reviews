import { Octokit, } from "octokit";
import { beforeAll, describe, onTestFailed, test } from "vitest";
import _ from 'lodash';
import 'lodash.product';
import { createAppAuth } from "@octokit/auth-app";
import { setTimeout } from 'node:timers/promises';

const apptokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: 1178750,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
    installationId: 65717473
  }
});

const tokentokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

const dismissStales = [true, false];
const lastPushes = [true, false];

const { data: main } = await tokentokit.rest.git.getRef({
  owner: '0x5b-org',
  repo: 'repository-config-testbed',
  ref: 'heads/main'
});

const rulesets = await tokentokit.paginate(tokentokit.rest.repos.getRepoRulesets, {
  owner: '0x5b-org',
  repo: 'repository-config-testbed',
  includes_parents: false
});

const branches = await tokentokit.paginate(tokentokit.rest.repos.listBranches, {
  owner: '0x5b-org',
  repo: 'repository-config-testbed'
});

describe.concurrent.for(_.product(dismissStales, lastPushes))('Require Reviews (dismiss-stale: %s, last-push: %s)', async ([dismissStale, lastPush]) => {
  const branchPrefix = `reviews/dismiss-stale@${dismissStale}/last-push@${lastPush}`;
  let pullRequest: Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data'];

  // Cleanup
  beforeAll(async () => {
    // Delete branches
    for (const branchType of ['main', 'feature']) {
      const branch = branches.find(branch => branch.name === `${branchPrefix}/${branchType}`);
      if (branch) {
        await apptokit.rest.git.deleteRef({
          owner: '0x5b-org',
          repo: 'repository-config-testbed',
          ref: `heads/${branch.name}`
        });
      }
    }

    // Wait 5s for branches to be deleted
    await setTimeout(5_000);

    // Branch deletion will close any PRs
  }, 20_000);

  // Setup
  beforeAll(async () => {
    // Upsert ruleset
    const ruleset = {
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      name: `Reviews (dismiss-stale: ${dismissStale}, last-push: ${lastPush})`,
      target: 'branch',
      enforcement: 'active',
      conditions: {
        ref_name: {
          include: [`refs/heads/${branchPrefix}/main`],
          exclude: []
        }
      },
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: dismissStale,
            require_code_owner_review: false,
            require_last_push_approval: lastPush,
            required_review_thread_resolution: false
          }
        }
      ]
    } satisfies Parameters<Octokit['rest']['repos']['createRepoRuleset']>[0];

    const rulesetId = rulesets.find(r => r.name === ruleset.name)?.id;
    if (rulesetId) await apptokit.rest.repos.updateRepoRuleset({ ...ruleset, ruleset_id: rulesetId });
    else await apptokit.rest.repos.createRepoRuleset(ruleset);
  
    // Create branches
    for (const branchType of ['main', 'feature']) {
      await tokentokit.rest.git.createRef({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        ref: `refs/heads/${branchPrefix}/${branchType}`,
        sha: main.object.sha
      });
    }

    // Push file to feature branch
    await tokentokit.rest.repos.createOrUpdateFileContents({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      path: 'test_file',
      message: 'Update feature branch',
      content: Buffer.from('Hello World!').toString('base64'),
      branch: `${branchPrefix}/feature`
    });

    // Open Pull Request
    const { data: pull } = await tokentokit.rest.pulls.create({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      title: `Test Reviews (dismiss-stale: ${dismissStale}, last-push: ${lastPush})`,
      head: `${branchPrefix}/feature`,
      base: `${branchPrefix}/main`
    });

    pullRequest = pull;

    // Approve PR (by app)
    await apptokit.rest.pulls.createReview({
      owner: '0x5b-org',
      repo: 'repository-config-testbed',
      pull_number: pullRequest.number,
      event: 'APPROVE'
    });
  }, 40_000);

  describe.skip('Update Pull Request (same diff)', async () => {
    beforeAll(async () => {
      const { data: headCommit } = await tokentokit.rest.git.getCommit({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        commit_sha: pullRequest.head.sha
      });
      
      const { data: commit } = await tokentokit.rest.git.createCommit({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        message: 'Empty commit',
        parents: [pullRequest.head.sha],
        tree: headCommit.tree.sha
      });

      await tokentokit.rest.git.updateRef({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        ref: `heads/${branchPrefix}/feature`,
        sha: commit.sha
      });
    });

    test('Pull Request mergeability', { retry: 5 }, async ({ expect }) => {
      onTestFailed(async () => await setTimeout(5_000));

      const { data: pull } = await tokentokit.rest.pulls.get({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        pull_number: pullRequest.number
      });
  
      expect(pull.mergeable_state).not.toBe("unknown");
      expect(pull.mergeable_state).toMatchSnapshot();
    });
  });

  describe('Update Pull Request (changed diff)', async () => {
    beforeAll(async () => {
      await apptokit.rest.repos.createOrUpdateFileContents({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        path: 'test_file_2',
        message: 'Change feature branch',
        content: Buffer.from('Hello World!').toString('base64'),
        branch: `${branchPrefix}/feature`
      });
    });

    test('Pull Request mergeability', { retry: 5 }, async ({ expect }) => {
      onTestFailed(async () => await setTimeout(5_000));
      
      const { data: pull } = await tokentokit.rest.pulls.get({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        pull_number: pullRequest.number
      });

      tokentokit.rest.pulls
  
      expect(pull.mergeable_state).not.toBe("unknown");
      expect(pull.mergeable_state).toMatchSnapshot();
    });
  });

  describe.skip('Re-approve (same user as made the change)', () => {
    beforeAll(async () => {
      await apptokit.rest.pulls.createReview({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        pull_number: pullRequest.number,
        event: 'APPROVE'
      });
    });

    test('Pull Request mergeability', { retry: 5 }, async ({ expect }) => {
      onTestFailed(async () => await setTimeout(5_000));
      
      const { data: pull } = await tokentokit.rest.pulls.get({
        owner: '0x5b-org',
        repo: 'repository-config-testbed',
        pull_number: pullRequest.number
      });
  
      expect(pull.mergeable_state).not.toBe("unknown");
      expect(pull.mergeable_state).toMatchSnapshot();
    });
  });
});
