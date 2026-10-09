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

interface SearchUsersResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubUser[];
}

interface SearchOptions {
  /** Search keywords (e.g., "golang") */
  query: string;
  /** Optional qualifiers: in:login, location:london, repos:>50, etc. */
  qualifiers?: string[];
  /** Sort field: followers | repositories | joined */
  sort?: 'followers' | 'repositories' | 'joined';
  /** Sort order */
  order?: 'asc' | 'desc';
  /** Results per page (max 100) */
  perPage?: number;
  /** Page number */
  page?: number;
}

// ---------- Constants ----------

const GITHUB_API = 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.warn('⚠️  GITHUB_TOKEN is not set. Rate limit is 10 req/min.');
}

// ---------- Core Function ----------

/**
 * Search GitHub users via the REST API.
 * Docs: https://docs.github.com/en/rest/search/search#search-users
 */
async function searchUsers(options: SearchOptions): Promise<SearchUsersResponse> {
  const {
    query,
    qualifiers = [],
    sort = 'followers',
    order = 'desc',
    perPage = 10,
    page = 1,
  } = options;

  // Build the q parameter: "golang in:login location:london"
  const q = [query, ...qualifiers].join(' ');

  const params = new URLSearchParams({
    q,
    sort,
    order,
    per_page: String(perPage),
    page: String(page),
  });

  const url = `${GITHUB_API}/search/users?${params.toString()}`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'github-user-search-script',
  };

  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `GitHub API error ${response.status} ${response.statusText}: ${errorBody}`
    );
  }

  const json = await response.json();
  console.log(json);
  return json as SearchUsersResponse;
}

// ---------- CLI Entrypoint ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = args[0] ?? 'golang';

  // Example qualifiers: pass extra args like `repos:>50 location:london`
  const qualifiers = args.slice(1);

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
    console.log(`   (showing ${result.items.length}, incomplete=${result.incomplete_results})\n`);

    result.items.forEach((user, i) => {
      console.log(
        `${String(i + 1).padStart(2, ' ')}. ${user.login.padEnd(28)} ` +
        `⭐ score=${user.score.toFixed(2)}  ${user.html_url}`
      );
    });
  } catch (error) {
    console.error('❌ Search failed:', error);
    process.exit(1);
  }
}

main();