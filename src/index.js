const core = require('@actions/core');
const github = require('@actions/github');
const simpleGit = require('simple-git');

const TEST_PATTERNS = [
  '**/*.test.{js,ts,jsx,tsx}',
  '**/*.spec.{js,ts,jsx,tsx}',
  '**/test/**/*.{js,ts,jsx,tsx}',
  '**/tests/**/*.{js,ts,jsx,tsx}',
  '**/__tests__/**/*.{js,ts,jsx,tsx}',
  '**/__mocks__/**/*.{js,ts,jsx,tsx}',
];

const BUG_KEYWORDS = [
  'fix',
  'bug',
  'hotfix',
  'patch',
  'regression',
  'defect',
  'issue',
  'error',
  'crash',
  'fail',
];

const RISK_THRESHOLDS = {
  LOW: 30,
  MEDIUM: 60,
  HIGH: 100,
};

function getRiskLabel(score) {
  if (score <= RISK_THRESHOLDS.LOW) return '🟢 Low Risk';
  if (score <= RISK_THRESHOLDS.MEDIUM) return '🟡 Medium Risk';
  return '🔴 High Risk';
}

function normalize(value, min, max) {
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function isTestFile(filePath) {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('/test/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    lower.includes('/__mocks__/')
  );
}

async function getDiffStats(octokit, owner, repo, pullNumber) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: pullNumber,
  });

  let totalAdditions = 0;
  let totalDeletions = 0;
  const touchedFiles = [];

  for (const file of files) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
    touchedFiles.push({
      filename: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      isTest: isTestFile(file.filename),
    });
  }

  return {
    totalAdditions,
    totalDeletions,
    totalChanges: totalAdditions + totalDeletions,
    touchedFiles,
    hasTestChanges: touchedFiles.some(f => f.isTest),
  };
}

async function getHistoricalBugDensity(git, touchedFiles, sinceDays = 90) {
  if (touchedFiles.length === 0) return 0;

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - sinceDays);
  const sinceStr = sinceDate.toISOString().split('T')[0];

  let totalBugCommits = 0;
  let totalCommits = 0;

  for (const file of touchedFiles) {
    try {
      const raw = await git.raw(['log', `--since=${sinceStr}`, '--pretty=format:%s', '--', file.filename]);
      const lines = raw.trim().split('\n').filter(l => l.length > 0);
      totalCommits += lines.length;

      for (const line of lines) {
        const msg = line.toLowerCase();
        if (BUG_KEYWORDS.some(keyword => msg.includes(keyword))) {
          totalBugCommits++;
        }
      }
    } catch (err) {
      core.warning(`Failed to get git log for ${file.filename}: ${err.message}`);
      totalCommits += 1;
    }
  }

  return totalCommits > 0 ? totalBugCommits / totalCommits : 0;
}

function computeRiskScore(diffStats, bugDensity, weights = {}) {
  const wDiff = weights.diff ?? 0.4;
  const wBug = weights.bug ?? 0.4;
  const wTest = weights.test ?? 0.2;

  if (diffStats.totalChanges === 0) return 0;

  const normalizedDiff = normalize(diffStats.totalChanges, 0, 500);
  const normalizedBug = normalize(bugDensity, 0, 1);
  const testFactor = diffStats.hasTestChanges ? 0 : 1;

  const score = Math.round(
    (wDiff * normalizedDiff + wBug * normalizedBug + wTest * testFactor) * 100
  );

  return Math.max(0, Math.min(100, score));
}

function generateComment(score, diffStats, bugDensity, riskLabel) {
  const testStatus = diffStats.hasTestChanges ? '✅ Tests modified' : '⚠️ No test changes detected';

  return `## PR Risk Score: ${score}/100 (${riskLabel})

| Metric | Value |
|--------|-------|
| **Lines Changed** | +${diffStats.totalAdditions} / -${diffStats.totalDeletions} (${diffStats.totalChanges} total) |
| **Files Touched** | ${diffStats.touchedFiles.length} |
| **Historical Bug Density** | ${(bugDensity * 100).toFixed(1)}% |
| **Test Coverage** | ${testStatus} |

### Breakdown
- **Diff Size Impact** (40%): ${(normalize(diffStats.totalChanges, 0, 500) * 40).toFixed(1)}/40
- **Bug Density Impact** (40%): ${(normalize(bugDensity, 0, 1) * 40).toFixed(1)}/40
- **Test Changes Impact** (20%): ${diffStats.hasTestChanges ? '0' : '20'}/20

> 💡 *This score helps prioritize review attention. High-risk PRs may need more thorough review, additional testing, or splitting into smaller changes.*
`;
}

async function postComment(octokit, owner, repo, pullNumber, body) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
  });

  const existingComment = comments.find(c =>
    c.user.type === 'Bot' && c.body.includes('PR Risk Score')
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });
    core.info('Updated existing risk score comment');
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
    core.info('Created new risk score comment');
  }
}

async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const weightsInput = core.getInput('weights');
    const sinceDays = parseInt(core.getInput('since-days') || '90', 10);
    const failOnHigh = core.getInput('fail-on-high') === 'true';

    const octokit = github.getOctokit(token);
    const context = github.context;

    if (!context.payload.pull_request) {
      core.setFailed('This action only runs on pull_request events');
      return;
    }

    const { owner, repo } = context.repo;
    const pullNumber = context.payload.pull_request.number;

    core.info(`Analyzing PR #${pullNumber} in ${owner}/${repo}`);

    const git = simpleGit(process.cwd());

    const diffStats = await getDiffStats(octokit, owner, repo, pullNumber);
    core.info(`Diff stats: ${diffStats.totalChanges} changes across ${diffStats.touchedFiles.length} files`);

    const bugDensity = await getHistoricalBugDensity(git, diffStats.touchedFiles, sinceDays);
    core.info(`Historical bug density: ${(bugDensity * 100).toFixed(1)}%`);

    const weights = weightsInput
      ? JSON.parse(weightsInput)
      : { diff: 0.4, bug: 0.4, test: 0.2 };

    const score = computeRiskScore(diffStats, bugDensity, weights);
    const riskLabel = getRiskLabel(score);

    const comment = generateComment(score, diffStats, bugDensity, riskLabel);

    await postComment(octokit, owner, repo, pullNumber, comment);

    core.setOutput('risk-score', score.toString());
    core.setOutput('risk-label', riskLabel);
    core.setOutput('total-changes', diffStats.totalChanges.toString());
    core.setOutput('bug-density', bugDensity.toString());
    core.setOutput('has-test-changes', diffStats.hasTestChanges.toString());

    if (failOnHigh && score > RISK_THRESHOLDS.HIGH) {
      core.setFailed(`PR risk score (${score}) exceeds high-risk threshold`);
    }

    core.info(`Risk score computed: ${score}/100 (${riskLabel})`);
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

module.exports = { run, computeRiskScore, getDiffStats, getHistoricalBugDensity, isTestFile };

if (require.main === module) {
  run();
}