import 'dotenv/config';

// ---------- Types ----------

interface GitHubUser {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  html_url: string;
  type: string;
  score: number;
}

interface GitHubUserDetails {
  login: string;
  name: string | null;
  email: string | null;
  bio: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  public_repos: number;
  followers: number;
  following: number;
  html_url: string;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  fork: boolean;
  owner: { login: string };
}

interface GitHubCommit {
  commit: {
    author: {
      name: string | null;
      email: string | null;
      date: string | null;
    } | null;
  };
  author: { login: string } | null;
}

interface SearchUsersResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubUser[];
}

/** Enriched user with resolved email info. */
interface EnrichedUser {
  login: string;
  name: string | null;
  profileEmail: string | null;   // from /users/:login
  commitEmail: string | null;    // best guess from commit history
  email: string | null;          // final resolved email
  emailSource: 'profile' | 'commits' | 'none';
  followers: number;
  publicRepos: number;
  htmlUrl: string;
}

interface SearchOptions {
  query: string;
  qualifiers?: string[];
  sort?: 'followers' | 'repositories' | 'joined';
  order?: 'asc' | 'desc';
  perPage?: number;
  page?: number;
}

// ---------- Constants ----------

const GITHUB_API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.warn('⚠️  GITHUB_TOKEN is not set. Rate limit is 10 req/min.');
}

const BASE_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'github-user-search-script',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

// ---------- HTTP helper ----------

async function ghFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: BASE_HEADERS });

  if (!res.ok) {
    // Soft-fail on 404/403 so one user's failure doesn't kill the run.
    if (res.status === 404 || res.status === 403) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

// ---------- Search ----------

async function searchUsers(options: SearchOptions): Promise<SearchUsersResponse> {
  const {
    query,
    qualifiers = [],
    sort = 'followers',
    order = 'desc',
    perPage = 10,
    page = 1,
  } = options;

  const q = [query, ...qualifiers].filter(Boolean).join(' ');
  const params = new URLSearchParams({
    q,
    sort,
    order,
    per_page: String(perPage),
    page: String(page),
  });

  return ghFetch<SearchUsersResponse>(`${GITHUB_API}/search/users?${params}`);
}

// ---------- Email resolution ----------

/**
 * Fetch the user's public profile and pull the (possibly null) email.
 */
async function fetchProfileEmail(login: string): Promise<{
  details: GitHubUserDetails;
  email: string | null;
}> {
  const details = await ghFetch<GitHubUserDetails>(`${GITHUB_API}/users/${login}`);
  return { details, email: details.email ?? null };
}

/**
 * Scan the user's recent public commits for an email address.
 * Looks at up to `maxRepos` non-fork repos, and up to `commitsPerRepo` commits each.
 *
 * Skips GitHub noreply addresses unless `includeNoreply` is true.
 */
async function fetchCommitEmail(
  login: string,
  maxRepos = 3,
  commitsPerRepo = 20,
  includeNoreply = false
): Promise<string | null> {
  let repos: GitHubRepo[];
  try {
    repos = await ghFetch<GitHubRepo[]>(
      `${GITHUB_API}/users/${login}/repos?per_page=100&sort=pushed&type=owner`
    );
  } catch {
    return null;
  }

  // Prefer source repos (not forks) that have been pushed to recently.
  const candidates = repos.filter((r) => !r.fork).slice(0, maxRepos);

  const emailCounts = new Map<string, number>();

  for (const repo of candidates) {
    try {
      const commits = await ghFetch<GitHubCommit[]>(
        `${GITHUB_API}/repos/${repo.full_name}/commits?author=${login}&per_page=${commitsPerRepo}`
      );

      for (const c of commits) {
        const email = c.commit?.author?.email;
        if (!email) continue;

        // Skip GitHub's noreply addresses unless explicitly requested.
        if (!includeNoreply && email.endsWith('@users.noreply.github.com')) {
          continue;
        }

        emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
      }
    } catch {
      // Ignore per-repo failures (empty repo, permission, rate limit, etc.)
    }
  }

  if (emailCounts.size === 0) return null;

  // Return the most frequently seen email.
  return [...emailCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Resolve the best email for a user:
 *   1. Public profile email (if set)
 *   2. Most common non-noreply commit email
 */
async function resolveUser(login: string, scanCommits: boolean): Promise<EnrichedUser> {
  const { details, email: profileEmail } = await fetchProfileEmail(login);

  let commitEmail: string | null = null;
  if (!profileEmail && scanCommits) {
    commitEmail = await fetchCommitEmail(login);
  }

  const email = profileEmail ?? commitEmail;
  const emailSource: EnrichedUser['emailSource'] = profileEmail
    ? 'profile'
    : commitEmail
    ? 'commits'
    : 'none';

  return {
    login: details.login,
    name: details.name,
    profileEmail,
    commitEmail,
    email,
    emailSource,
    followers: details.followers,
    publicRepos: details.public_repos,
    htmlUrl: details.html_url,
  };
}

// ---------- CLI Entrypoint ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = args[0] ?? 'golang';

  // Flags: --scan-commits to enable commit scanning (off by default — it's slow)
  const scanCommits = args.includes('--scan-commits');
  const qualifiers = args.slice(1).filter((a) => !a.startsWith('--'));

  try {
    const result = await searchUsers({
      query,
      qualifiers,
      sort: 'followers',
      order: 'desc',
      perPage: 10,
      page: 1,
    });

    console.log(`\n🔎 Found ${result.total_count} users for "${query}"`);
    console.log(`   (showing ${result.items.length}, incomplete=${result.incomplete_results})`);
    if (scanCommits) console.log('   📧 commit scanning ENABLED (slower)');
    console.log('');

    const enriched: EnrichedUser[] = [];

    // Resolve sequentially to avoid hammering the rate limit.
    for (const u of result.items) {
      try {
        const info = await resolveUser(u.login, scanCommits);
        enriched.push(info);

        const emailDisplay =
          info.email ?? '(no public email)';
        const sourceTag =
          info.emailSource === 'profile'
            ? '[profile]'
            : info.emailSource === 'commits'
            ? '[commits]'
            : '[none]';

        console.log(
          `✅ ${info.login.padEnd(28)} ` +
            `email=${emailDisplay.padEnd(35)} ${sourceTag.padEnd(10)} ` +
            `followers=${info.followers.toString().padEnd(10)} ` +
            ` ${info.htmlUrl}`
        );
      } catch (err) {
        console.log(`⚠️  ${u.login.padEnd(28)} failed: ${(err as Error).message}`);
      }
    }

    // Optionally dump JSON for downstream use.
    if (args.includes('--json')) {
      console.log('\n--- JSON ---');
      console.log(JSON.stringify(enriched, null, 2));
    }
  } catch (error) {
    console.error('❌ Search failed:', error);
    process.exit(1);
  }
}

main();