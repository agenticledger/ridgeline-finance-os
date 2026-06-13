const { registerToolHandler } = require('./toolExecutor');

const DEEP_TOOLS = [
  {
    name: 'deep__web_search',
    description: 'Search the web for information. Returns search results for a given query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'deep__web_fetch',
    description: 'Fetch the content of a web page by URL. Returns the text content (limited to 10,000 characters).',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'deep__csv_export',
    description: 'Export data as a CSV file. Returns the CSV content for download.',
    inputSchema: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description: 'The CSV data content (including headers)',
        },
        filename: {
          type: 'string',
          description: 'Suggested filename for the export (e.g. "report.csv")',
        },
      },
      required: ['data', 'filename'],
    },
  },
];

registerToolHandler('deep__', async (toolName, input, _context) => {
  switch (toolName) {
    case 'deep__web_search': {
      if (!input.query) return JSON.stringify({ error: 'query is required' });

      const apiKey = process.env.BRAVE_SEARCH_API_KEY;
      if (!apiKey) {
        return JSON.stringify({ error: 'BRAVE_SEARCH_API_KEY not configured' });
      }

      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(input.query)}&count=8&text_decorations=false`;
        const response = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
          },
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          return JSON.stringify({ error: `Brave Search API error: ${response.status} ${response.statusText}` });
        }

        const data = await response.json();
        const results = (data?.web?.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          published: r.page_age || null,
        }));

        return JSON.stringify({ query: input.query, count: results.length, results });
      } catch (err) {
        return JSON.stringify({ error: `Search failed: ${err.message || 'Unknown error'}` });
      }
    }

    case 'deep__web_fetch': {
      if (!input.url) {
        return JSON.stringify({ error: 'url is required' });
      }
      try {
        const response = await fetch(input.url, {
          headers: {
            'User-Agent': 'Orphil-Agent/1.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          return JSON.stringify({
            error: `HTTP ${response.status}: ${response.statusText}`,
            url: input.url,
          });
        }

        let text = await response.text();
        if (text.length > 10_000) {
          text = text.substring(0, 10_000) + '\n...[truncated at 10,000 chars]';
        }

        return JSON.stringify({
          url: input.url,
          contentLength: text.length,
          content: text,
        });
      } catch (err) {
        return JSON.stringify({
          error: `Fetch failed: ${err.message || 'Unknown error'}`,
          url: input.url,
        });
      }
    }

    case 'deep__csv_export': {
      if (!input.data) {
        return JSON.stringify({ error: 'data is required' });
      }
      return JSON.stringify({
        type: 'csv_export',
        filename: input.filename || 'export.csv',
        data: input.data,
        message: `CSV export ready: ${input.filename || 'export.csv'}`,
      });
    }

    default:
      return JSON.stringify({ error: `Unknown deep tool: ${toolName}` });
  }
});

module.exports = { DEEP_TOOLS };
